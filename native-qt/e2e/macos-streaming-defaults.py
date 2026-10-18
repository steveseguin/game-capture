#!/usr/bin/env python3
"""Exercise packaged GUI defaults, explicit overrides, and older-bundle settings migration.

Only owned preference directories and PID-scoped accessibility actions are used.
This checks idle configuration workflows; live publishing is qualified separately.
Foreground activation and physical keyboard navigation are outside this workflow.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--previous-app', required=True, type=Path)
    parser.add_argument('--expected-executable-sha256', required=True)
    parser.add_argument('--expected-previous-sha256', required=True)
    parser.add_argument('--previous-default-audio-bitrate', type=int, default=192,
                        help='Expected first-run audio bitrate of the identified older bundle')
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    assert 6 <= args.previous_default_audio_bitrate <= 510
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    exe = args.app.resolve() / 'Contents/MacOS/game-capture'
    old = args.previous_app.resolve() / 'Contents/MacOS/game-capture'
    helper = args.ui_helper.resolve()
    assert sha(exe) == args.expected_executable_sha256
    assert sha(old) == args.expected_previous_sha256
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    (report / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    result = dict(scope=__doc__, executableSha256=sha(exe), previousExecutableSha256=sha(old),
                  harnessSha256=sha(Path(__file__)), helperSha256=sha(helper), launches=[], passed=False)
    child = control = None
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('QT_', 'DYLD_', 'GAME_CAPTURE_', 'VERSUS_', 'GH_', 'GITHUB_', 'ACTIONS_'))}

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def ui(action, *values):
        probe = subprocess.run([str(helper), str(child.pid), action, *values],
                               text=True, capture_output=True, timeout=10)
        if probe.returncode:
            raise RuntimeError(f'Accessibility {action} failed ({probe.returncode}): {probe.stderr.strip()}')
        return probe.stdout

    def field(name):
        return next((r for r in json.loads(ui('dump'))
                     if r.get('AXIdentifier', '').endswith('.' + name)), None)

    def window_ready():
        # Local-control discovery precedes MainWindow construction. Only retry
        # this read-only query; never retry a mutating accessibility action.
        probe = subprocess.run([str(helper), str(child.pid), 'actions', 'sourceModeSelect'],
                               text=True, capture_output=True, timeout=10)
        if probe.returncode == 3:
            return False
        assert probe.returncode == 0, 'GUI readiness query failed: ' + probe.stderr
        return 'AXPress' in probe.stdout

    def wait(check, message):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            assert child.poll() is None, 'Owned app exited before ' + message
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

    def expand(name):
        row = wait(lambda: field(name), 'Missing disclosure: ' + name)
        if not int(row.get('AXValue', 0)):
            ui('press', name)
        wait(lambda: int((field(name) or {}).get('AXValue', 0)) == 1, 'Disclosure did not expand')

    def values():
        # Explicit allowlist: no stream identifiers, endpoints, or credentials.
        observed = {}
        for name in ['resolutionSelect', 'fpsSelect', 'bitrateSelect', 'encoderSelect', 'codecSelect']:
            row = wait(lambda: field(name), 'Missing control: ' + name)
            observed[name] = row.get('AXTitle')
        observed['audioBitrateSpin'] = int(field('audioBitrateSpin')['AXValue'])
        return observed

    defaults = dict(resolutionSelect='1280x720', fpsSelect='60',
                    bitrateSelect='Standard (4000 kbps)',
                    encoderSelect='Auto (Hardware, then Software)',
                    codecSelect='H.264 (Compatibility)', audioBitrateSpin=128)
    explicit = dict(resolutionSelect='1920x1080', fpsSelect='30',
                    bitrateSelect='Medium (6000 kbps)',
                    encoderSelect='Software (x264 / VP9 / AV1)',
                    codecSelect='H.264 (Compatibility)', audioBitrateSpin=192)
    hardware = {**explicit, 'encoderSelect': 'Apple VideoToolbox'}
    automatic = {**explicit, 'encoderSelect': defaults['encoderSelect']}
    # The old bundle creates its own preferences through real UI actions. The
    # candidate then reads those files without synthetic settings injection.
    cases = [('fresh', exe, 'fresh', defaults, explicit),
             ('relaunch-software', exe, 'fresh', explicit, hardware),
             ('relaunch-videotoolbox', exe, 'fresh', hardware, automatic),
             ('relaunch-auto', exe, 'fresh', automatic, None),
             ('previous', old, 'migration',
              {**defaults, 'audioBitrateSpin': args.previous_default_audio_bitrate}, explicit),
             ('migrated', exe, 'migration', explicit, None)]
    print('Reports:', report, flush=True)
    try:
        for label, binary, profile, expected, edit in cases:
            directory = report / label
            directory.mkdir()
            discovery = directory / 'private-control.json'
            control = None
            entry = dict(case=label, executableSha256=sha(binary), passed=False)
            result['launches'].append(entry)
            save()
            with (directory / 'private-gui.log').open('w') as log:
                child = subprocess.Popen([str(binary), '--settings-dir=' + str(report / ('private-' + profile)),
                    '--local-control', '--local-control-port=0', '--local-control-discovery=' + str(discovery)],
                    cwd=report, env=env, stdout=log, stderr=subprocess.STDOUT)
                wait(discovery.exists, 'Control endpoint unavailable')
                control = json.loads(discovery.read_text())
                assert control['pid'] == child.pid
                wait(window_ready, 'GUI controls unavailable')
                expand('advancedToggle')
                expand('audioEncodingToggle')
                idle()
                entry['observed'] = values()
                assert entry['observed'] == expected, f'{label}: unexpected settings: {entry["observed"]}'
                if edit:
                    for name, title in edit.items():
                        if name == 'audioBitrateSpin':
                            # Numeric AX actions exercise the actual spinbox.
                            current = int(field(name)['AXValue'])
                            if current != title:
                                ui('increment' if title > current else 'decrement', name, str(abs(title-current)))
                        elif field(name).get('AXTitle') != title:
                            ui('press', name)
                            ui('press', title)
                            wait(lambda: field(name).get('AXTitle') == title, 'Selection did not commit: ' + name)
                    entry['edited'] = values()
                    assert entry['edited'] == edit
                idle()
                api('/commands', {'command': 'quit'})
                child.wait(timeout=15)
                entry.update(exitCode=child.returncode, discoveryRemoved=not discovery.exists())
                assert child.returncode == 0 and entry['discoveryRemoved']
                entry['passed'] = True
                save()
        result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
    finally:
        if child and child.poll() is None:
            try:
                if control:
                    api('/commands', {'command': 'quit'})
                child.wait(timeout=5)
            except Exception:
                child.terminate()
                child.wait(timeout=5)
        save()
        print(json.dumps(dict(report=str(report), passed=result['passed'], error=result.get('error'))), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
