#!/usr/bin/env python3
"""Packaged Mac configuration-menu selection and persistence across relaunch.

Uses native accessibility actions, fresh settings, no capture or publication, no
physical-device capture and no system preference changes. This does not qualify
actual encoding at every selected setting or general VoiceOver interaction.
"""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--launches', type=int, default=4, choices=range(2, 9))
    parser.add_argument('--row-action', choices=['press', 'click'], default='press',
                        help='Native AX row press or mouse click verified inside the owned popup')
    args = parser.parse_args()
    app, helper = args.app.resolve(), args.ui_helper.resolve()
    exe = app / 'Contents/MacOS/game-capture'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    assert (app / 'Contents/Frameworks').is_dir()
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    for p in [Path(__file__), Path(__file__).with_name('macos-ui-control.mm')]:
        shutil.copy2(p, report / p.name)
    settings, discovery = report / 'settings', report / 'control.json'
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    result = {'scope': __doc__, 'executableSha256': sha(exe), 'harnessSha256': sha(Path(__file__)),
              'uiHelperSha256': sha(helper), 'rowAction': args.row_action, 'launches': [], 'actions': [], 'passed': False}
    choices = {
        'resolutionSelect': ['3840x2160', '2560x1440', '1920x1080', '1280x720', '960x540', '1080x1920', '720x1280'],
        'fpsSelect': ['30', '60'],
        'bitrateSelect': ['Custom', 'Economy (2500 kbps)', 'High (12000 kbps)', 'Standard (4000 kbps)'],
        'iceModeSelect': ['Host Only (LAN)', 'Direct STUN', 'Relay Only', 'Auto with TURN fallback (Recommended)'],
        'encoderSelect': ['Apple VideoToolbox', 'Software (x264 / VP9 / AV1)', 'Auto (Hardware, then Software)'],
        'codecSelect': ['H.265 / HEVC (Apple VideoToolbox)', 'VP9 (Software, experimental)',
                        'AV1 (Software, experimental)', 'H.264 (Compatibility)'],
        'audioCodecSelect': ['PCM (experimental)', 'Opus (48 kHz)'],
        'audioChannelsSelect': ['Mono (1 channel)', 'Stereo (2 channels)'],
        'alphaBackgroundModeSelect': ['Chroma background', 'Opaque background', 'No background fill'],
    }
    child, control, log = None, None, None
    expected = {}
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QT_', 'DYLD_', 'GAME_CAPTURE_', 'VERSUS_'))}

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def ui(action, *values):
        return subprocess.check_output([str(helper), str(child.pid), action, *values], text=True,
                                       stderr=subprocess.PIPE, timeout=10)

    def rows():
        return json.loads(ui('dump'))

    def field(name):
        return next((r for r in rows() if r.get('AXIdentifier', '').endswith('.' + name)), None)

    def wait(check, message, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise AssertionError('Owned app exited before ' + message)
            value = check()
            if value:
                return value
            time.sleep(.15)
        raise AssertionError(message)

    def api(route, body=None):
        request = urllib.request.Request(control['base_url'] + route,
            data=json.dumps(body).encode() if body else None,
            headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def idle():
        d = api('/diagnostics')
        assert not d['app']['live'] and not d['app']['capturing']
        assert d['video']['frames_sent'] == 0 and d['metrics']['audio_packets_sent'] == 0

    def choose(name, title):
        result['pendingAction'] = {'control': name, 'title': title, 'pid': child.pid}
        save()
        row = wait(lambda: field(name), 'Missing control: ' + name)
        before = row.get('AXTitle')
        assert row.get('AXEnabled'), 'Disabled control: ' + name
        if before != title:
            ui('press', name)
            if args.row_action == 'click':
                # Qt animates/positions its popup and briefly guards mouse
                # release after opening. Allow that transition before the one
                # click; do not retry a selection that failed to commit.
                time.sleep(.3)
                before_bounds = json.loads(ui('bounds', title))
                time.sleep(.1)
                bounds = json.loads(ui('bounds', title))
                assert before_bounds == bounds, 'Popup row bounds did not settle'
                result.setdefault('mouseClicks', []).append({
                    'control': name, 'title': title, 'bounds': bounds})
                save()
            ui(args.row_action, title)
            wait(lambda: (field(name) or {}).get('AXTitle') == title, 'Selection did not commit: ' + name)
        idle()
        result['actions'].append({'control': name, 'before': before, 'after': title,
                                  'changed': before != title, 'launch': len(result['launches'])})
        result.pop('pendingAction', None)
        save()

    def expand(name):
        row = wait(lambda: field(name), 'Missing disclosure: ' + name)
        if not int(row.get('AXValue', 0)):
            ui('press', name)
        wait(lambda: int((field(name) or {}).get('AXValue', 0)) == 1, 'Disclosure did not expand: ' + name)

    try:
        print('Reports:', report, flush=True)
        for index in range(args.launches):
            assert not discovery.exists()
            arguments = ['--settings-dir=' + str(settings), '--local-control', '--local-control-port=0',
                         '--local-control-discovery=' + str(discovery)]
            log = (report / f'launch-{index}.log').open('w')
            child = subprocess.Popen([str(exe), *arguments], cwd=report, env=env, stdout=log, stderr=subprocess.STDOUT)
            result['launches'].append({'pid': child.pid, 'index': index})
            wait(discovery.exists, 'Control discovery did not appear', 15)
            control = json.loads(discovery.read_text())
            assert control['pid'] == child.pid
            wait(lambda: field('advancedToggle'), 'GUI did not appear', 15)
            subprocess.run(['/usr/bin/open', '-a', str(app), '--args', *arguments], check=True, capture_output=True, timeout=10)
            ui('activate')
            expand('advancedToggle')
            expand('audioEncodingToggle')
            idle()
            restored = {name: field(name).get('AXTitle') for name in expected}
            assert restored == expected, 'Saved menu selections did not restore'
            result['launches'][-1]['restored'] = restored
            for name, titles in choices.items():
                shift = index % len(titles)
                for title in titles[shift:] + titles[:shift]:
                    choose(name, title)
                expected[name] = (field(name) or {}).get('AXTitle')
            # Open the popup through its native AX action, then navigate and
            # commit/cancel with PID-targeted keys. AXFocused alone does not
            # reliably move Qt focus on macOS, so do not assume it did.
            choose('fpsSelect', '30')
            for direction, title in [('up', '60'), ('down', '30')]:
                ui('press', 'fpsSelect')
                ui('key', direction)
                ui('key', 'return')
                wait(lambda: (field('fpsSelect') or {}).get('AXTitle') == title,
                     'Keyboard popup selection did not commit')
                result['keyboardSelections'] = result.get('keyboardSelections', 0) + 1
            ui('press', 'fpsSelect')
            ui('key', 'up')
            ui('key', 'escape')
            wait(lambda: (field('fpsSelect') or {}).get('AXTitle') == '30', 'Escape changed the selected frame rate')
            expected['fpsSelect'] = '30'
            result['keyboardCancellations'] = result.get('keyboardCancellations', 0) + 1
            # Exercise the editable control, not only its popup. Invalid text
            # must not replace the last valid saved resolution.
            ini = settings / 'VDO.Ninja/Game Capture.ini'
            def saved_resolution():
                config = configparser.ConfigParser(interpolation=None)
                config.read(ini)
                return config.get('video', 'resolution')
            for text in ['160x90', '3840x2160', '1920x930']:
                ui('set', 'Custom stream resolution', text)
                wait(lambda: (field('resolutionSelect') or {}).get('AXTitle') == text and saved_resolution() == text,
                     'Custom resolution did not persist')
                result.setdefault('customResolutions', []).append({'launch': index, 'text': text})
            for invalid in ['719x1280', 'not-a-size']:
                ui('set', 'Custom stream resolution', invalid)
                wait(lambda: (field('resolutionSelect') or {}).get('AXTitle') == invalid, 'Editor did not accept fixture text')
                assert saved_resolution() == '1920x930', 'Invalid custom resolution replaced the saved valid value'
                result.setdefault('invalidResolutionPreservation', []).append({'launch': index, 'text': invalid})
            ui('set', 'Custom stream resolution', '1920x930')
            wait(lambda: (field('resolutionSelect') or {}).get('AXTitle') == '1920x930', 'Valid custom resolution did not restore')
            expected['resolutionSelect'] = '1920x930'
            choose('sourceModeSelect', 'Camera / Webcam')
            for name, titles in {
                'cameraResolutionSelect': ['1280x720', '960x540', '640x480', '1920x1080'],
                'cameraFpsSelect': ['60 fps', '24 fps', '30 fps'],
            }.items():
                for title in titles:
                    choose(name, title)
            # Verify camera selections on disk; these controls are hidden when
            # relaunching into Window mode. Camera capture stays off here.
            camera_settings = configparser.ConfigParser(interpolation=None)
            camera_settings.read(ini)
            assert camera_settings.get('camera', 'resolution') == '1920x1080'
            assert camera_settings.getint('camera', 'fps') == 30
            choose('sourceModeSelect', 'Syphon (texture sharing)')
            choose('syphonAlphaSelect', 'Premultiplied alpha')
            choose('syphonAlphaSelect', 'Straight alpha')
            choose('sourceModeSelect', 'Window')
            # Refresh rebuilds the device model. Exercise selection after its
            # old accessible rows have been invalidated, without starting input.
            for _ in range(5):
                choose('microphoneDeviceSelect', 'macOS default microphone/input')
                ui('press', 'refreshSourcesButton')
                wait(lambda: (field('microphoneDeviceSelect') or {}).get('AXTitle') == 'macOS default microphone/input',
                     'Refresh lost the selected default input')
                choose('microphoneDeviceSelect', 'No microphone')
                ui('press', 'refreshSourcesButton')
                wait(lambda: (field('microphoneDeviceSelect') or {}).get('AXTitle') == 'No microphone',
                     'Refresh unexpectedly enabled a microphone')
                result['deviceModelRefreshes'] = result.get('deviceModelRefreshes', 0) + 2
            idle()
            api('/commands', {'command': 'quit'})
            child.wait(timeout=10)
            result['launches'][-1]['exitCode'] = child.returncode
            assert child.returncode == 0 and not discovery.exists()
            log.close()
            ini = settings / 'VDO.Ninja/Game Capture.ini'
            assert 'profilesEncrypted=' not in ini.read_text(), 'Idle menu workflow unexpectedly created an output profile'
            save()
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if isinstance(error, subprocess.CalledProcessError):
            result['toolError'] = error.stderr
        if child and child.poll() is None:
            try:
                (report / 'private-failure-ax.json').write_text(ui('dump'))
            except Exception:
                pass
    finally:
        if child and child.poll() is None:
            try:
                if control:
                    api('/commands', {'command': 'quit'})
                child.wait(timeout=5)
            except Exception:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
        if child:
            result['lastChildExitCode'] = child.poll()
        if log and not log.closed:
            log.close()
        save()
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
