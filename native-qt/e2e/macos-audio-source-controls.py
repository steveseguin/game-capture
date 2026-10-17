#!/usr/bin/env python3
"""Exercise source-dependent audio choices in the packaged Mac GUI, without starting capture."""
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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, required=True)
parser.add_argument('--ui-helper', type=Path, required=True)
parser.add_argument('--reports', type=Path, required=True)
parser.add_argument('--qt-accessibility-debug', action='store_true')
parser.add_argument('--cycles', type=int, default=3, choices=range(1, 11))
args = parser.parse_args()
report = args.reports.resolve() / str(uuid.uuid4())
report.mkdir(parents=True)
exe = args.app.resolve() / 'Contents/MacOS/game-capture'
helper = args.ui_helper.resolve()
settings = report / 'settings'
ini = settings / 'VDO.Ninja/Game Capture.ini'
ini.parent.mkdir(parents=True)
ini.write_text('[video]\nsourceMode=window\n[audio]\nsource=selected-window\n'
               'windowSource=selected-window\nincludeMicrophone=false\nmicrophoneDeviceId=none\n')
discovery = report / 'control.json'
env = {k: v for k, v in os.environ.items() if not k.startswith(('QT_', 'DYLD_', 'VERSUS_', 'GAME_CAPTURE_'))}
if args.qt_accessibility_debug:
    env['QT_LOGGING_RULES'] = 'qt.accessibility.table=true;qt.accessibility.cache=true'


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


result = {'scope': 'Real packaged GUI audio menus, source changes, saved preferences and relaunch; no capture or media workflow',
          'executableSha256': digest(exe), 'harnessSha256': digest(Path(__file__)),
          'app': str(args.app.resolve()),
          'qtWidgetsSha256': digest(args.app.resolve() / 'Contents/Frameworks/QtWidgets.framework/Versions/A/QtWidgets'),
          'qtCocoaSha256': digest(args.app.resolve() / 'Contents/PlugIns/platforms/libqcocoa.dylib'),
          'helperSha256': digest(helper), 'observations': [], 'passed': False}
result['cycles'] = args.cycles
result['qtAccessibilityDebug'] = args.qt_accessibility_debug
shutil.copy2(__file__, report / Path(__file__).name)
shutil.copy2(Path(__file__).with_name('macos-ui-control.mm'), report / 'macos-ui-control.mm')
child = None
control = None
logs = []


def save():
    (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')


def wait(check, message, seconds=10):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        assert child is None or child.poll() is None, 'Publisher exited unexpectedly'
        value = check()
        if value:
            return value
        time.sleep(.2)
    raise AssertionError(message)


def ui(action, name=None):
    return subprocess.check_output([str(helper), str(child.pid), action, *([name] if name else [])],
                                   text=True, stderr=subprocess.PIPE, timeout=10)


def rows():
    return json.loads(ui('dump'))


def field(name):
    return next((r for r in rows() if str(r.get('AXIdentifier', '')).endswith('.' + name)), None)


def menu_rows(name):
    # This workflow opens one popup at a time. All Mac app combos now use
    # owned AudioChoiceView rows; older packages used them only for audio.
    return [r for r in rows() if r.get('AXRole') == 'AXStaticText'
            and (('.' + name + '.') in r.get('AXIdentifier', '')
                 or '.versus::platform::AudioChoiceView.' in r.get('AXIdentifier', ''))]


def close_menu(name):
    if menu_rows(name):
        ui('press', name)
        wait(lambda: not menu_rows(name), 'Menu did not close: ' + name)


def choose(name, title):
    close_menu(name)
    ui('press', name)
    wait(lambda: any(r.get('AXTitle') == title for r in menu_rows(name)),
         'Menu item missing: ' + title)
    ui('press', title)
    wait(lambda: field(name).get('AXTitle') == title, 'Selection did not commit: ' + title)
    close_menu(name)
    if name == 'sourceModeSelect':
        # Source enumeration and camera-panel layout continue after the combo
        # commits. Let that layout settle before opening another popup.
        time.sleep(.8)


def api(route, body=None):
    request = urllib.request.Request(control['base_url'] + route,
        data=json.dumps(body).encode() if body else None,
        headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def start(label):
    global child, control
    log = (report / (label + '.log')).open('w')
    logs.append(log)
    child = subprocess.Popen([str(exe), '--settings-dir=' + str(settings), '--local-control',
        '--local-control-port=0', '--local-control-discovery=' + str(discovery)],
        env=env, cwd=report, stdout=log, stderr=subprocess.STDOUT)
    wait(discovery.exists, 'Local control not ready', 15)
    control = json.loads(discovery.read_text())
    assert control['pid'] == child.pid
    wait(lambda: field('advancedToggle'), 'GUI not accessible', 15)
    if not int(field('advancedToggle').get('AXValue', 0)):
        ui('press', 'advancedToggle')


def stop():
    api('/commands', {'command': 'quit'})
    assert child.wait(timeout=10) == 0
    assert not discovery.exists()


def check_audio(label, enabled, expected):
    assert field('audioSourceSelect')['AXTitle'] == expected
    close_menu('audioSourceSelect')
    ui('press', 'audioSourceSelect')
    expected_titles = {'Selected window/app audio', 'System audio (all apps)',
                       'Selected microphone/input', 'No audio'}
    snapshots = []
    def complete_menu():
        items = menu_rows('audioSourceSelect')
        snapshots.append(sorted({r.get('AXTitle') for r in items}))
        return items if set(snapshots[-1]) == expected_titles else None
    try:
        menu = wait(complete_menu, 'Audio menu has missing or unsupported choices in ' + label, 5)
    finally:
        result['observations'].append({'label': label, 'audioBefore': expected, 'menuSnapshots': snapshots})
        save()
    result['observations'][-1]['menu'] = menu
    save()
    app_item = next((r for r in menu if r['AXTitle'] == 'Selected window/app audio'), None)
    if enabled:
        assert app_item and app_item.get('AXEnabled') is True, 'Selected-app audio missing in ' + label
    for r in menu:
        if r['AXTitle'] != 'Selected window/app audio':
            assert r.get('AXEnabled') is True, 'Supported audio choice disabled'
    if not enabled:
        # Even a direct accessibility action must not select the unavailable route.
        attempted = subprocess.run([str(helper), str(child.pid), 'press', 'Selected window/app audio'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        result['observations'][-1]['unavailableActionExit'] = attempted.returncode
        result['observations'][-1]['audioAfterUnavailableAction'] = field('audioSourceSelect')['AXTitle']
        save()
        assert app_item and app_item.get('AXEnabled') is False, 'Selected-app audio must be disabled in ' + label
        assert field('audioSourceSelect')['AXTitle'] == expected
    close_menu('audioSourceSelect')
    diagnostics = api('/diagnostics')
    assert not diagnostics['app']['live'] and not diagnostics['app']['capturing']
    assert not diagnostics['source']['has_frame']
    assert diagnostics['video']['frames_sent'] == 0
    assert diagnostics['metrics']['audio_packets_sent'] == 0
    result['observations'][-1]['captureStayedOff'] = True
    save()


try:
    state = json.loads(subprocess.check_output([str(helper), str(os.getpid()), 'session-state'], text=True))
    assert not state['screenLocked'], 'Unlock the Mac for native GUI workflows'
    start('publisher')
    check_audio('window', True, 'Selected window/app audio')
    for cycle in range(args.cycles):
        for source in ['Syphon (texture sharing)', 'Camera / Webcam']:
            label = f'cycle {cycle + 1}: {source}'
            choose('sourceModeSelect', source)
            check_audio(label, False, 'No audio')
            choose('audioSourceSelect', 'System audio (all apps)')
            check_audio(label + ' system', False, 'System audio (all apps)')
            choose('audioSourceSelect', 'Selected microphone/input')
            check_audio(label + ' input', False, 'Selected microphone/input')
            choose('sourceModeSelect', 'Window')
            check_audio('restored window from ' + label, True, 'Selected window/app audio')
    choose('audioSourceSelect', 'No audio')
    choose('sourceModeSelect', 'Syphon (texture sharing)')
    check_audio('syphon no-audio preference', False, 'No audio')
    stop()
    start('publisher-relaunch')
    assert field('sourceModeSelect')['AXTitle'] == 'Syphon (texture sharing)'
    check_audio('restored syphon', False, 'No audio')
    choose('sourceModeSelect', 'Window')
    check_audio('restored window no-audio preference', True, 'No audio')
    stop()
    # Older packages allowed this unsupported combination to be saved.
    legacy = configparser.ConfigParser()
    legacy.optionxform = str
    legacy.read(ini)
    legacy['video']['sourceMode'] = 'camera'
    legacy['audio']['source'] = 'selected-window'
    legacy['audio']['windowSource'] = 'none'
    with ini.open('w') as config:
        legacy.write(config)
    start('publisher-legacy-settings')
    assert field('sourceModeSelect')['AXTitle'] == 'Camera / Webcam'
    check_audio('legacy camera settings normalized', False, 'No audio')
    choose('sourceModeSelect', 'Window')
    check_audio('legacy window preference restored', True, 'No audio')
    stop()
    result['passed'] = True
except Exception as error:
    result['error'] = repr(error)
    if child is not None and child.poll() is None:
        try:
            (report / 'failed-ui.json').write_text(ui('dump'))
        except Exception:
            pass
finally:
    if child is not None and child.poll() is None:
        try:
            stop()
        except Exception:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
    result['publisherExit'] = child.returncode if child is not None else None
    for log in logs:
        log.close()
    save()
    print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
raise SystemExit(0 if result['passed'] else 1)
