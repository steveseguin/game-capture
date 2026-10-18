#!/usr/bin/env python3
"""Packaged Mac keyboard/menu workflow using events directed only to the owned PID.

Uses private settings, stays idle, and does not change system keyboard/accessibility
preferences. This is not complete physical-keyboard or VoiceOver qualification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time
import urllib.request
import uuid


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    app, helper = args.app.resolve(), args.ui_helper.resolve()
    exe = app / 'Contents/MacOS/game-capture'
    version = plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
    assert (app / 'Contents/Frameworks').is_dir(), 'Use a deployed app'
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    for name in [Path(__file__).name, 'macos-ui-control.mm']:
        shutil.copyfile(Path(__file__).with_name(name), report / name)
    settings, discovery = report / 'settings', report / 'control.json'
    result = {'scope': __doc__, 'harnessSha256': sha(Path(__file__)), 'helperSha256': sha(helper),
              'executableSha256': sha(exe), 'steps': [], 'passed': False}
    child, control, log = None, None, None
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QT_', 'DYLD_', 'GAME_CAPTURE_', 'VERSUS_'))}

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def wait(check, message, seconds=8):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = check()
            if value:
                return value
            time.sleep(.15)
        raise AssertionError(message)

    def ui(action, *arguments):
        return subprocess.check_output([str(helper), str(child.pid), action, *arguments],
                                       text=True, stderr=subprocess.PIPE, timeout=10)

    def rows():
        return json.loads(ui('dump'))

    def field(name):
        return next((r for r in rows() if r.get('AXIdentifier', '').endswith('.' + name)), None)

    def message_text():
        return next((r.get('AXValue', '') for r in rows()
                     if r.get('AXIdentifier', '').endswith('.QMessageBox.qt_msgbox_label')), '')

    def snapshot(name):
        (report / (name + '-ui.json')).write_text(ui('dump'))

    def step(name):
        result['steps'].append(name)
        save()

    def api(route, body=None):
        request = urllib.request.Request(control['base_url'] + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def idle():
        d = api('/diagnostics')
        assert not d['app']['live'] and not d['app']['capturing']
        assert d['video']['frames_sent'] == 0 and d['metrics']['audio_packets_sent'] == 0

    def focus(name):
        ui('focus', name)
        wait(lambda: field(name).get('AXFocused'), 'Focus did not reach ' + name)

    def quit_by_key():
        idle()
        # Quit can destroy the AX connection before key-up returns. Require the
        # actual normal process exit and cleanup, retaining the posting result.
        posted = subprocess.run([str(helper), str(child.pid), 'key', 'command-q'],
                                text=True, capture_output=True, timeout=10)
        result.setdefault('quitKeyPosts', []).append({'returnCode': posted.returncode, 'stderr': posted.stderr})
        wait(lambda: child.poll() is not None, 'Command-Q did not quit', 10)
        assert child.returncode == 0 and not discovery.exists()
        step('Command-Q exited normally and removed discovery')

    try:
        print('Reports:', report, flush=True)
        for index in range(3):
            assert not discovery.exists()
            log = (report / f'launch-{index}.log').open('w')
            child = subprocess.Popen([str(exe), '--settings-dir=' + str(settings), '--local-control',
                '--local-control-port=0', '--local-control-discovery=' + str(discovery)],
                cwd=report, env=env, stdout=log, stderr=subprocess.STDOUT)
            wait(discovery.exists, 'Application did not start', 15)
            control = json.loads(discovery.read_text())
            assert control['pid'] == child.pid
            wait(lambda: field('streamIdInput'), 'GUI did not appear', 15)
            idle()
            # Use the same application-opening request as Finder before asking
            # the AX driver to verify actual foreground ownership.
            subprocess.run(['/usr/bin/open', '-a', str(app), '--args', '--settings-dir=' + str(settings),
                '--local-control', '--local-control-port=0', '--local-control-discovery=' + str(discovery)],
                check=True, capture_output=True, timeout=10)
            ui('activate')
            snapshot(f'launch-{index}')
            if index == 2:
                assert field('streamIdInput').get('AXValue') == ''
                assert int(field('advancedToggle').get('AXValue', 0)) == 0
                assert field('sourceModeSelect').get('AXTitle') == 'Window'
                step('Reset defaults persisted across relaunch and capture stayed off')
            elif index == 1:
                assert field('streamIdInput').get('AXValue') == 'a'
                assert int(field('advancedToggle').get('AXValue', 0)) == 1
                step('Keyboard-edited values and advanced state persisted across relaunch')
                ui('press-menu', 'Game Capture')
                wait(lambda: any(r.get('AXRole') == 'AXMenuItem' and r.get('AXTitle') == 'About Game Capture'
                                 and r.get('AXEnabled') for r in rows()), 'About menu item did not become enabled')
                ui('press-menu', 'About Game Capture')
                wait(lambda: ('Version ' + version) in message_text() and 'Powered by VDO.Ninja' in message_text(),
                     'About dialog did not expose its version')
                snapshot('about')
                ui('key', 'escape')
                wait(lambda: not message_text(), 'Escape did not dismiss About')
                step('Native About menu opens its dialog; Escape dismisses it')
                ui('press', 'Reset to Defaults...')
                wait(lambda: message_text().startswith('This clears saved stream details'), 'Reset confirmation did not open')
                snapshot('reset-confirmation')
                ui('key', 'escape')
                wait(lambda: not message_text(), 'Escape did not cancel Reset')
                assert field('streamIdInput').get('AXValue') == 'a'
                assert int(field('advancedToggle').get('AXValue', 0)) == 1
                step('Escape cancels Reset without changing the owned settings')
                ui('press', 'Reset to Defaults...')
                wait(lambda: any(r.get('AXRole') == 'AXButton' and r.get('AXTitle') == 'Reset' for r in rows()),
                     'Reset button did not appear')
                ui('press', 'Reset')
                wait(lambda: field('streamIdInput').get('AXValue') == '' and
                     int(field('advancedToggle').get('AXValue', 0)) == 0, 'Confirmed Reset did not restore defaults')
                step('Confirmed Reset restores the private stream and Advanced defaults')
            else:
                menus = [r for r in rows() if r.get('AXRole') == 'AXMenuItem']
                result['nativeMenuItems'] = menus
                assert any(r.get('AXTitle') == 'Quit Game Capture' for r in menus)
                ui('set', 'streamIdInput', 'remove-this-owned-value')
                focus('streamIdInput')
                ui('key', 'command-a')
                ui('key', 'backspace')
                wait(lambda: field('streamIdInput').get('AXValue') == '', 'Command-A/Backspace did not clear text')
                step('Command-A and Backspace edit the focused stream field')
                ui('key', 'a')
                wait(lambda: field('streamIdInput').get('AXValue') == 'a', 'Typed character did not reach the stream field')
                step('A typed character reaches the stream field')
                ui('key', 'tab')
                wait(lambda: field('passwordInput').get('AXFocused'), 'Tab did not reach password field')
                ui('key', 'shift-tab')
                wait(lambda: field('streamIdInput').get('AXFocused'), 'Shift-Tab did not return to stream field')
                step('Tab and Shift-Tab move between stream and password fields')
                focus('advancedToggle')
                assert int(field('advancedToggle').get('AXValue', 0)) == 0
                ui('key', 'space')
                wait(lambda: int(field('advancedToggle').get('AXValue', 0)) == 1, 'Space did not expand Advanced')
                step('Space toggles the focused Advanced checkbox')
                # AXFocused and AXPress do not establish combo focus here.
                # A PID/hit-checked native click gives the control normal mouse
                # focus before checking the subsequent keyboard interaction.
                ui('click', 'sourceModeSelect')
                wait(lambda: any(r.get('AXRole') == 'AXStaticText' and r.get('AXTitle') == 'Syphon (texture sharing)'
                                 for r in rows()), 'Source popup did not open')
                ui('key', 'escape')
                wait(lambda: field('sourceModeSelect').get('AXFocused'), 'Closing source popup did not focus combo')
                ui('key', 'down')
                wait(lambda: field('sourceModeSelect').get('AXTitle') == 'Camera / Webcam', 'Down did not choose Camera')
                ui('key', 'up')
                wait(lambda: field('sourceModeSelect').get('AXTitle') == 'Window', 'Up did not restore Window')
                step('Arrow keys change source type and restore Window without capture')
                ui('key', 'space')
                wait(lambda: any(r.get('AXRole') == 'AXStaticText' and r.get('AXTitle') == 'Syphon (texture sharing)'
                                 for r in rows()), 'Space did not open source popup')
                ui('key', 'escape')
                wait(lambda: not any(r.get('AXRole') == 'AXStaticText' and r.get('AXTitle') == 'Syphon (texture sharing)'
                                     for r in rows()), 'Escape did not close source popup')
                assert field('sourceModeSelect').get('AXTitle') == 'Window'
                step('Space opens source popup; Escape cancels without changing selection')
                snapshot('keyboard-complete')
            quit_by_key()
            log.close()
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if isinstance(error, subprocess.CalledProcessError):
            result['toolError'] = error.stderr
        if child and child.poll() is None:
            try:
                snapshot('failure')
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
        if log:
            log.close()
        save()
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
