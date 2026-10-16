#!/usr/bin/env python3
"""Extract the Mac delivery ZIP, verify its contents, and launch/relaunch it through Launch Services.

Uses private preferences and an owned extraction directory. No media capture,
quarantine bypass, system installation, or notarization qualification is performed.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import stat
import subprocess
import time
import urllib.request
import uuid
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delivery', required=True, type=Path)
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    delivery, helper = args.delivery.resolve(), args.ui_helper.resolve()
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location('delivery_packager', Path(__file__).parents[1] / 'qa/package-macos-download.py')
    packager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packager)
    for path in [Path(__file__), Path(__file__).with_name('macos-ui-control.mm'), Path(spec.origin)]:
        shutil.copyfile(path, report / path.name)
    result = {'scope': __doc__, 'harnessSha256': packager.digest(Path(__file__)),
              'helperSha256': packager.digest(helper), 'launches': [], 'passed': False}
    manifest = json.loads((delivery / 'delivery-manifest.json').read_text())
    target = report / 'Relocated Applications'
    app = target / manifest['appName']
    exe = app / 'Contents/MacOS/game-capture'
    settings, discovery = report / 'settings', report / 'control.json'
    pid, control = None, None

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def owned_pids():
        output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
        return [int(parts[0]) for line in output.splitlines()
                if len(parts := line.strip().split(None, 1)) == 2 and parts[1] == str(exe)]

    def wait(check, message, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = check()
            if value:
                return value
            time.sleep(.2)
        raise AssertionError(message)

    def api(route, body=None):
        request = urllib.request.Request(control['base_url'] + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def ui(action, name=None):
        return subprocess.check_output([str(helper), str(pid), action, *([name] if name else [])],
                                       text=True, stderr=subprocess.PIPE, timeout=5)

    def field(name):
        return next((r for r in json.loads(ui('dump')) if r.get('AXIdentifier', '').endswith('.' + name)), None)

    try:
        print('Reports:', report, flush=True)
        assert manifest['format'] == 1 and manifest['appName'] == 'Game Capture.app'
        assert manifest['architecture'] == 'arm64'
        result['deliveryManifestSha256'] = packager.digest(delivery / 'delivery-manifest.json')
        result['archive'] = manifest['archive']
        for line in (delivery / 'SHA256SUMS').read_text().splitlines():
            expected, name = line.split('  ', 1)
            assert Path(name).name == name
            assert packager.digest(delivery / name) == expected, 'Delivery checksum mismatch: ' + name
        archive = delivery / manifest['archive']['name']
        assert archive.parent == delivery and packager.digest(archive) == manifest['archive']['sha256']
        with zipfile.ZipFile(archive) as zipped:
            names = set()
            for entry in zipped.infolist():
                name = PurePosixPath(entry.filename)
                assert not name.is_absolute() and '..' not in name.parts and name.parts[0] in [app.name, '__MACOSX']
                assert entry.filename not in names
                names.add(entry.filename)
                if stat.S_ISLNK(entry.external_attr >> 16):
                    link = zipped.read(entry).decode()
                    normalized = os.path.normpath(str(name.parent / link))
                    assert not Path(link).is_absolute() and normalized.startswith(app.name + '/')
        target.mkdir()
        subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(target)], check=True)
        assert packager.inventory(app) == manifest['appFiles'], 'Extracted files, symlinks or permissions differ'
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result['extractedApp'] = str(app)
        result['executableSha256'] = packager.digest(exe)
        result['verifiedBundleEntries'] = len(manifest['appFiles'])
        result['verifiedMachOBinaries'] = len(manifest['binaries'])
        for name, expected in manifest['binaries'].items():
            assert packager.digest(app / name) == expected
        result['sessionState'] = json.loads(subprocess.check_output(
            [str(helper), str(os.getpid()), 'session-state'], text=True))
        if result['sessionState']['screenLocked']:
            result['blocked'] = 'screen_locked'
            raise RuntimeError('Mac session is locked; unlock it before the Launch Services/GUI workflow')
        for index in range(2):
            assert not discovery.exists() and not owned_pids()
            started = time.monotonic()
            command = ['/usr/bin/open', '-n', '-a', str(app), '--args', '--settings-dir=' + str(settings),
                       '--local-control', '--local-control-port=0', '--local-control-discovery=' + str(discovery)]
            subprocess.run(command, check=True, capture_output=True, timeout=10)
            wait(discovery.exists, 'Launch Services app did not start local control')
            control = json.loads(discovery.read_text())
            pid = control['pid']
            assert owned_pids() == [pid], 'Launch Services did not run the extracted executable'
            wait(lambda: field('advancedToggle'), 'Extracted GUI not accessible')
            expected = index  # First launch starts collapsed; second restores the toggle.
            assert int(field('advancedToggle').get('AXValue', 0)) == expected
            ui('press', 'advancedToggle')
            wait(lambda: int(field('advancedToggle').get('AXValue', 0)) != expected, 'Extracted GUI control did not respond')
            d = api('/diagnostics')
            assert d['platform_capabilities']['platform'] == 'macOS' and d['platform_capabilities']['can_publish']
            assert not d['app']['live'] and not d['app']['capturing'] and not d['source']['has_frame']
            assert d['video']['frames_sent'] == 0 and d['metrics']['audio_packets_sent'] == 0
            result['launches'].append({'pid': pid, 'launchSeconds': time.monotonic() - started,
                                      'extractedExecutableConfirmed': True, 'guiControlResponded': True,
                                      'persistedPreferenceRestored': bool(index), 'captureStayedOff': True})
            save()
            api('/commands', {'command': 'quit'})
            wait(lambda: not owned_pids(), 'Extracted app did not quit', 10)
            assert not discovery.exists()
        assert packager.inventory(app) == manifest['appFiles'], 'Launching modified the bundle'
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if pid and pid in owned_pids():
            try:
                (report / 'failed-ui.json').write_text(ui('dump'))
            except Exception:
                pass
    finally:
        if pid and pid in owned_pids() and control:
            try:
                api('/commands', {'command': 'quit'})
                wait(lambda: pid not in owned_pids(), 'Quit failed', 5)
            except Exception:
                pass
        # Only processes running the unique, owned extracted executable qualify.
        for child in owned_pids():
            os.kill(child, signal.SIGTERM)
        try:
            wait(lambda: not owned_pids(), 'Owned app remained alive', 3)
        except AssertionError:
            for child in owned_pids():
                os.kill(child, signal.SIGKILL)
        save()
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
