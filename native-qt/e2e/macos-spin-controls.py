#!/usr/bin/env python3
"""Verify native spin actions in the packaged Mac GUI, with private idle settings.

No physical capture devices or system preferences are changed. Numeric boundary
checks concern the UI; they do not qualify media encoding at those bitrates.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    app, helper = args.app.resolve(), args.ui_helper.resolve()
    exe = app / 'Contents/MacOS/game-capture'
    widgets = app / 'Contents/Frameworks/QtWidgets.framework/Versions/A/QtWidgets'
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    for name in [Path(__file__).name, 'macos-ui-control.mm']:
        shutil.copy2(Path(__file__).with_name(name), report / name)
    settings, discovery = report / 'settings', report / 'control.json'
    result = dict(app=str(app), executableSha256=sha(exe), qtWidgetsSha256=sha(widgets),
                  harnessSha256=sha(Path(__file__)), helperSha256=sha(helper),
                  scope=__doc__, actions=[], passed=False)
    child, control, log = None, None, None
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QT_', 'DYLD_', 'GAME_CAPTURE_', 'VERSUS_'))}

    def ui(action, *arguments):
        return subprocess.check_output([str(helper), str(child.pid), action, *arguments],
                                       text=True, stderr=subprocess.PIPE, timeout=10)

    def field(name):
        return next((r for r in json.loads(ui('dump')) if r.get('AXIdentifier', '').endswith('.' + name)), None)

    def wait(check, message, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = check()
            if value:
                return value
            time.sleep(.15)
        raise AssertionError(message)

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

    def choose(name, title):
        if field(name).get('AXTitle') != title:
            ui('press', name)
            ui('press', title)
            wait(lambda: field(name).get('AXTitle') == title, 'Choice not committed: ' + name)

    def value(name):
        return int(field(name)['AXValue'])

    def action(name, direction, expected):
        before = value(name)
        ui(direction, name, '1')
        actual = value(name)
        result['actions'].append(dict(control=name, direction=direction, before=before, actual=actual, expected=expected))
        assert actual == expected, f'{name} {direction}: expected {expected}, got {actual}'

    def typed(name, number):
        ui('focus', name)
        ui('click', name)
        ui('key', 'command-a')
        for digit in str(number):
            ui('key', digit)
        ui('key', 'return')
        assert value(name) == number

    def quit_app():
        idle()
        api('/commands', {'command': 'quit'})
        child.wait(timeout=10)
        assert child.returncode == 0 and not discovery.exists()

    try:
        print('Reports:', report, flush=True)
        for launch in range(2):
            log = (report / f'launch-{launch}.log').open('w')
            arguments = ['--settings-dir=' + str(settings), '--local-control', '--local-control-port=0',
                         '--local-control-discovery=' + str(discovery)]
            child = subprocess.Popen([str(exe), *arguments], cwd=report, env=env, stdout=log, stderr=subprocess.STDOUT)
            wait(discovery.exists, 'Application did not start', 15)
            control = json.loads(discovery.read_text())
            assert control['pid'] == child.pid
            wait(lambda: field('advancedToggle'), 'GUI did not appear', 15)
            subprocess.run(['/usr/bin/open', '-a', str(app), '--args', *arguments],
                           check=True, capture_output=True, timeout=10)
            ui('activate')
            idle()
            if not int(field('advancedToggle')['AXValue']):
                ui('press', 'advancedToggle')
            assert not int(field('audioEncodingToggle')['AXValue'])
            ui('press', 'audioEncodingToggle')
            if launch == 0:
                action('audioBitrateSpin', 'increment', 193)
                action('audioBitrateSpin', 'decrement', 192)
                typed('audioBitrateSpin', 64)
                action('audioBitrateSpin', 'increment', 65)
                action('audioBitrateSpin', 'decrement', 64)
                typed('audioBitrateSpin', 6)
                action('audioBitrateSpin', 'decrement', 6)
                action('audioBitrateSpin', 'increment', 7)
                typed('audioBitrateSpin', 510)
                action('audioBitrateSpin', 'increment', 510)
                action('audioBitrateSpin', 'decrement', 509)
                typed('audioBitrateSpin', 64)
                action('audioBitrateSpin', 'increment', 65)
                for name, initial in [('primaryAudioGainSpin', 100), ('microphoneAudioGainSpin', 100),
                                      ('viewerLimitSpin', 10)]:
                    assert value(name) == initial
                    action(name, 'increment', initial + 1)
                    action(name, 'decrement', initial)
                    action(name, 'increment', initial + 1)
                choose('bitrateSelect', 'Custom')
                action('customBitrateSpin', 'increment', 4001)
                action('customBitrateSpin', 'decrement', 4000)
                action('customBitrateSpin', 'increment', 4001)
                choose('outputSelect', 'SRT (caller)')
                action('outputLatencySpin', 'increment', 201)
                action('outputLatencySpin', 'decrement', 200)
                action('aacBitrateSpin', 'increment', 193)
                action('aacBitrateSpin', 'decrement', 192)
                choose('outputSelect', 'VDO.Ninja (default)')
            else:
                expected = {'audioBitrateSpin': 65, 'primaryAudioGainSpin': 101,
                            'microphoneAudioGainSpin': 101, 'viewerLimitSpin': 11, 'customBitrateSpin': 4001}
                result['restoredValues'] = {name: value(name) for name in expected}
                assert result['restoredValues'] == expected
                result['idlePersistencePassed'] = True
            (report / f'launch-{launch}-ui.json').write_text(ui('dump'))
            quit_app()
            log.close()
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if isinstance(error, subprocess.CalledProcessError):
            result['toolError'] = error.stderr
        if child and child.poll() is None:
            try:
                (report / 'failure-ui.json').write_text(ui('dump'))
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
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
