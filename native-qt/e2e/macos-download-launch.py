#!/usr/bin/env python3
"""Extract the Mac delivery ZIP, verify its contents, and launch/relaunch it through Launch Services.

Uses private preferences and an owned extraction directory. The optional browser
archive path requires its original quarantine metadata and verifies propagation
to the extracted app. No quarantine bypass or system installation is performed;
this existing Mac cannot establish clean-machine or first-permission behavior.
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
    parser.add_argument('--quarantined-archive', type=Path,
                        help='Previously browser-downloaded ZIP; require preserved quarantine on archive and extracted app')
    parser.add_argument('--replace-before-relaunch', action='store_true',
                        help='Retain the first extracted app, replace it from the same archive, and verify persisted preferences')
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
    owned_executables = {str(exe)}

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def quarantine(path):
        # CPython's os.getxattr is not available in every macOS distribution.
        return subprocess.check_output(['/usr/bin/xattr', '-p', 'com.apple.quarantine', str(path)],
                                       text=True, stderr=subprocess.PIPE).strip()

    def download_dialogs():
        dialogs = []
        processes = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
        for line in processes.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) != 2 or parts[1] != '/System/Library/CoreServices/CoreServicesUIAgent.app/Contents/MacOS/CoreServicesUIAgent':
                continue
            rows = json.loads(subprocess.check_output([str(helper), parts[0], 'dump'], text=True,
                                                      stderr=subprocess.PIPE, timeout=5))
            # Retain only dialog subtrees, not the agent's application menus.
            for at, row in enumerate(rows):
                if row.get('AXRole') != 'AXWindow':
                    continue
                end = next((i for i in range(at+1, len(rows)) if rows[i].get('depth', 99) <= row['depth']), len(rows))
                dialogs.append((int(parts[0]), rows[at:end]))
        return dialogs

    accepted_prompts = set()

    def accept_normal_download_open(index):
        if index in accepted_prompts:
            return
        dialogs = download_dialogs()
        if len(dialogs) != 1:
            return
        agent, rows = dialogs[0]
        values = [str(row.get('AXValue', '')) for row in rows]
        if not any('Game Capture' in value and 'downloaded from the Internet' in value and 'open it?' in value for value in values):
            return
        if not any('Apple checked it for malicious software and none was detected.' in value for value in values):
            return
        buttons = [row for row in rows if row.get('AXRole') == 'AXButton' and row.get('AXTitle') == 'Open' and row.get('AXEnabled')]
        if len(buttons) != 1 or not buttons[0].get('AXIdentifier'):
            return
        # Only the normal Open action for this already hash/signature-verified
        # download. Untrusted/damaged-app overrides are never selected.
        result.setdefault('normalOpenPrompts', []).append({'launchIndex': index, 'agentPid': agent, 'dialog': rows})
        save()
        subprocess.run([str(helper), str(agent), 'press', buttons[0]['AXIdentifier']], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        accepted_prompts.add(index)

    def owned_pids():
        output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
        return [int(parts[0]) for line in output.splitlines()
                if len(parts := line.strip().split(None, 1)) == 2 and parts[1] in owned_executables]

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
        archive = args.quarantined_archive.resolve() if args.quarantined_archive else delivery / manifest['archive']['name']
        if not args.quarantined_archive:
            assert archive.parent == delivery, 'Delivery archive must be inside the candidate directory'
        assert packager.digest(archive) == manifest['archive']['sha256']
        if args.quarantined_archive:
            result['scope'] = 'Browser-downloaded quarantined signed ZIP: extraction and Launch Services GUI workflows on this existing Mac; not clean-machine qualification'
            result['downloadedArchive'] = str(archive)
            result['archiveQuarantine'] = quarantine(archive)
            assert result['archiveQuarantine'], 'Downloaded archive has no quarantine metadata'
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
            result['requiredFreeBytes'] = sum(entry.file_size for entry in zipped.infolist()) * (2 if args.replace_before_relaunch else 1) + 128*1024*1024
            result['initialFreeBytes'] = shutil.disk_usage(report).free
            assert result['initialFreeBytes'] >= result['requiredFreeBytes'], 'Insufficient space to preserve extraction/replacement evidence'
        target.mkdir()
        subprocess.run(['/usr/bin/ditto', '-x', '-k', '--qtn', str(archive), str(target)], check=True)
        if args.quarantined_archive:
            result['appQuarantineBeforeLaunch'] = quarantine(app)
            assert result['appQuarantineBeforeLaunch'], 'Extraction did not propagate download quarantine'
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
            if args.quarantined_archive:
                assert not download_dialogs(), 'An existing system download dialog must be handled before this owned launch'
            started = time.monotonic()
            command = ['/usr/bin/open', '-n', '-a', str(app), '--args', '--settings-dir=' + str(settings),
                       '--local-control', '--local-control-port=0', '--local-control-discovery=' + str(discovery)]
            subprocess.run(command, check=True, capture_output=True, timeout=10)
            def launched():
                if discovery.exists():
                    return True
                if args.quarantined_archive:
                    accept_normal_download_open(index)
                return False
            wait(launched, 'Launch Services app did not start local control')
            control = json.loads(discovery.read_text())
            pid = control['pid']
            actual_executable = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'comm='], text=True).strip()
            if args.quarantined_archive and actual_executable != str(exe):
                assert '/AppTranslocation/' in actual_executable and actual_executable.endswith('/Game Capture.app/Contents/MacOS/game-capture'), 'Unexpected launch destination'
                assert packager.digest(Path(actual_executable)) == result['executableSha256'], 'Translocated executable differs from downloaded app'
                translocated_app = Path(actual_executable).parents[2]
                subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(translocated_app)], check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                owned_executables.add(actual_executable)
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
                                      'actualExecutable': actual_executable, 'translocated': actual_executable != str(exe),
                                      'extractedExecutableConfirmed': True, 'guiControlResponded': True,
                                      'persistedPreferenceRestored': bool(index), 'captureStayedOff': True})
            save()
            api('/commands', {'command': 'quit'})
            wait(lambda: not owned_pids(), 'Extracted app did not quit', 10)
            assert not discovery.exists()
            if index == 0 and args.replace_before_relaunch:
                previous = report/'Previous Installation'/app.name
                previous.parent.mkdir()
                app.rename(previous)
                subprocess.run(['/usr/bin/ditto', '-x', '-k', '--qtn', str(archive), str(target)], check=True)
                assert packager.inventory(app) == manifest['appFiles'], 'Replacement differs from the delivered bundle'
                subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                result['replacement'] = {'scope': 'Same-version archive replacement with private preferences retained; not a cross-version upgrade',
                                         'previousAppPreserved': str(previous), 'replacementMatchesDelivery': True}
                if args.quarantined_archive:
                    result['replacement']['quarantineBeforeRelaunch'] = quarantine(app)
                    assert result['replacement']['quarantineBeforeRelaunch'], 'Replacement lost download quarantine'
                save()
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
