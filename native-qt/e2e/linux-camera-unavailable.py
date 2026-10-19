#!/usr/bin/env python3
"""Packaged X11 camera-empty workflow with devices hidden only from the owned app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid
from PIL import ImageGrab


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def wait(check, message):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.2)
    raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    assert os.environ.get('GC_QA_PRIVATE_DESKTOP') and os.environ.get('QT_QPA_PLATFORM') == 'xcb'
    exe = args.publisher.resolve(); bundle = exe.parent.parent.parent
    manifest_path = bundle / 'release-artifact-manifest.json'
    assert sha(manifest_path) == args.manifest_sha256
    manifest = json.loads(manifest_path.read_text()); assert sha(exe) == manifest['artifact']['sha256']
    launcher = (bundle / manifest.get('launcher', manifest['artifact']['path'])).resolve()
    assert launcher.is_relative_to(bundle)
    for entry in manifest['payload']['files']:
        file = (bundle / entry['relativePath']).resolve()
        assert file.is_relative_to(bundle) and file.stat().st_size == entry['size'] and sha(file) == entry['sha256']
    report = args.reports.resolve() / str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    helper = Path(__file__).with_name('linux-ui-control.py'); (report / helper.name).write_bytes(helper.read_bytes())
    (report / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    devices = sorted(Path('/dev').glob('video*')); assert devices and all(p.is_char_device() for p in devices)
    identities = {str(p): p.stat().st_rdev for p in devices}
    result = {'scope': 'Extracted Linux package, actual X11 camera selection with V4L2 nodes masked only in the owned publisher mount namespace. Visible Linux empty-camera guidance, unavailable Go live, no capture, clean quit. Not physical disconnect or permission-denied qualification.',
              'executableSha256': sha(exe), 'manifestSha256': sha(manifest_path), 'harnessSha256': sha(__file__), 'guiHelperSha256': sha(helper), 'maskedDevices': list(identities), 'passed': False}
    control = None; publisher = None
    discovery = report / 'private-control.json'
    def api(route, body=None):
        request = urllib.request.Request(control['base_url'] + route, data=json.dumps(body).encode() if body else None,
                                         headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    try:
        with (report / 'publisher.log').open('wb') as log:
            # Preserve normal device access (including AppRun's /dev/null)
            # before masking only the camera nodes in this mount namespace.
            command = ['bwrap', '--die-with-parent', '--unshare-user', '--bind', '/', '/', '--dev-bind', '/dev', '/dev']
            for device in devices:
                command += ['--ro-bind', '/dev/null', str(device)]
            command += ['--', str(launcher), '--settings-dir=' + str(report / 'private-settings'), '--local-control', '--local-control-port=0', '--local-control-discovery=' + str(discovery)]
            publisher = subprocess.Popen(command, stdout=log, stderr=log)
            wait(discovery.exists, 'No owned publisher discovery')
            control = json.loads(discovery.read_text()); pid = control['pid']
            assert Path(f'/proc/{pid}/exe').resolve() == exe
            def ui(*values):
                return subprocess.check_output(['python3', str(report / helper.name), str(pid), *values], text=True, timeout=15)
            ui('choose', 'Window', 'Camera / Webcam')
            rows = json.loads(ui('dump')); (report / 'ui.json').write_text(json.dumps(rows, indent=2)+'\n')
            expected = 'No cameras found. Check connection and permissions, then Refresh.'
            assert any(row['name'] == expected for row in rows), 'Missing Linux camera-empty explanation'
            assert not any('Windows Settings' in row['name'] for row in rows)
            assert any(row['name'] == 'Go live unavailable' and 'sensitive' not in row['states'] for row in rows)
            assert not api('/diagnostics')['app']['capturing']
            ui('activate'); metadata = json.loads(ui('preview'))
            x, y, width, height = metadata['frame']; shot = report / 'camera-unavailable.png'
            ImageGrab.grab().crop((x, y, x+width, y+height)).save(shot)
            result.update(guidance=expected, goLiveDisabled=True, capturing=False, screenshotSha256=sha(shot))
            api('/commands', {'command': 'quit'}); assert publisher.wait(timeout=10) == 0
            assert not discovery.exists(); result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
    finally:
        if publisher and publisher.poll() is None:
            try:
                if control:
                    api('/commands', {'command': 'quit'}); publisher.wait(timeout=10)
            finally:
                if publisher.poll() is None:
                    publisher.terminate(); publisher.wait(timeout=5)
        result['hostDevicesUnchanged'] = all(Path(p).stat().st_rdev == identity for p, identity in identities.items())
        result['passed'] = result['passed'] and result['hostDevicesUnchanged']
        (report / 'results.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
