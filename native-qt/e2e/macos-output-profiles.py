#!/usr/bin/env python3
"""Packaged GUI destination persistence and missing-owned-Keychain-item recovery.

Uses private settings and generated loopback destinations, never starts capture or
publishes. Does not lock the Keychain, change ACLs, or touch another profile.
This validates configuration workflows, not protocol delivery or denied-access UX.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--ui-helper', required=True, type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    app, helper = args.app.resolve(), args.ui_helper.resolve()
    exe = app / 'Contents/MacOS/game-capture'
    assert (app / 'Contents/Frameworks').is_dir(), 'Use a deployed bundle'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    shutil.copy2(__file__, report / Path(__file__).name)
    shutil.copy2(Path(__file__).with_name('macos-ui-control.mm'), report / 'macos-ui-control.mm')
    settings, discovery = report / 'settings', report / 'control.json'
    ini = settings / 'VDO.Ninja/Game Capture.ini'
    result = {'scope': __doc__, 'executableSha256': sha(exe), 'harnessSha256': sha(Path(__file__)),
              'uiHelperSha256': sha(helper), 'steps': [], 'launches': [], 'passed': False}
    child, control, log = None, None, None
    owned = set()
    service = 'ninja.vdo.game-capture.output-profiles'
    marker = uuid.uuid4().hex
    profiles = [
        {'name': 'whip', 'title': 'WHIP', 'url': f'http://127.0.0.1:20501/{marker}/whip', 'secret': 'whip-' + marker},
        {'name': 'srt', 'title': 'SRT (caller)', 'url': 'srt://127.0.0.1:20502', 'secret': 'srt-' + marker[:16],
         'streamId': '#!::r=' + marker + ',m=publish', 'latency': 203, 'aac': 193},
        {'name': 'rtmp', 'title': 'RTMP / RTMPS', 'url': 'rtmp://127.0.0.1:20503/' + marker,
         'secret': 'key-' + marker, 'aac': 194},
        {'name': 'rtsp', 'title': 'RTSP / VRChat (TCP)', 'url': f'rtsp://qa:{marker}@127.0.0.1:20504/tcp', 'aac': 195},
        {'name': 'rtsp-udp', 'title': 'RTSP (UDP)', 'url': f'rtsp://qa:{marker}@127.0.0.1:20505/udp', 'aac': 196},
        {'name': 'udp', 'title': 'UDP / MPEG-TS (LAN)', 'url': 'udp://127.0.0.1:20506', 'aac': 197},
        {'name': 'rist', 'title': 'RIST', 'url': 'rist://127.0.0.1:20507', 'latency': 207, 'aac': 198},
    ]
    private_values = {profile[key] for profile in profiles for key in ['url', 'secret', 'streamId'] if profile.get(key)}
    # Local-only fixture: never include its values or raw GUI trees in an export.
    (report / 'private-fixture.json').write_text(json.dumps(profiles, indent=2) + '\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QT_', 'DYLD_', 'GAME_CAPTURE_', 'VERSUS_'))}

    def save():
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')

    def wait(check, message, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if child and child.poll() is not None:
                raise AssertionError('Owned app exited before ' + message)
            value = check()
            if value:
                return value
            time.sleep(.15)
        raise AssertionError(message)

    def step(message):
        result['steps'].append(message)
        save()

    def ui(action, *values):
        return subprocess.check_output([str(helper), str(child.pid), action, *values], text=True,
                                       stderr=subprocess.PIPE, timeout=10)

    def rows():
        return json.loads(ui('dump'))

    def field(name):
        return next((x for x in rows() if x.get('AXIdentifier', '').endswith('.' + name)), None)

    def value(name):
        row = field(name)
        assert row is not None, 'Missing control: ' + name
        return row.get('AXValue')

    def choose(profile):
        selection = wait(lambda: field('outputSelect'), 'Output selector unavailable')
        if selection.get('AXTitle') != profile['title']:
            ui('press', 'outputSelect')
            ui('press', profile['title'])
            wait(lambda: (field('outputSelect') or {}).get('AXTitle') == profile['title'],
                 'Output selection did not commit')

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

    def reference():
        if not ini.exists():
            return None
        match = re.search(r'^profilesEncrypted="?@ByteArray\(([A-Za-z0-9+/=]+)\)"?$', ini.read_text(), re.M)
        if not match:
            assert 'profilesEncrypted=' not in ini.read_text(), 'Unrecognized private reference encoding'
            return None
        ref = base64.b64decode(match[1], validate=True).decode('ascii')
        assert re.fullmatch(r'mac-keychain-v1:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', ref)
        return ref

    def no_plaintext():
        text = ini.read_text()
        for private in private_values:
            assert private not in text, 'Destination data leaked into private INI'
        assert marker not in text, 'Generated credential leaked into INI'

    def keychain(operation, ref):
        assert ref in owned, 'Refusing to inspect or delete an unowned Keychain reference'
        action = 'delete-generic-password' if operation == 'delete' else 'find-generic-password'
        p = subprocess.run(['/usr/bin/security', action, '-s', service, '-a', ref], capture_output=True, timeout=10)
        assert p.returncode in (0, 44), 'Owned Keychain operation failed'
        return p.returncode == 0

    def remember():
        ref = reference()
        assert ref is not None
        owned.add(ref)
        assert keychain('find', ref)
        no_plaintext()
        return ref

    def start(label):
        nonlocal child, control, log
        assert not discovery.exists()
        log = (report / (label + '.log')).open('w')
        arguments = ['--settings-dir=' + str(settings), '--local-control',
            '--local-control-port=0', '--local-control-discovery=' + str(discovery)]
        child = subprocess.Popen([str(exe), *arguments],
            cwd=report, env=env, stdout=log, stderr=subprocess.STDOUT)
        result['launches'].append({'label': label, 'pid': child.pid})
        wait(discovery.exists, 'Application did not expose control discovery', 15)
        control = json.loads(discovery.read_text())
        assert control['pid'] == child.pid
        wait(lambda: field('advancedToggle'), 'Application GUI did not appear', 15)
        subprocess.run(['/usr/bin/open', '-a', str(app), '--args', *arguments],
                       check=True, capture_output=True, timeout=10)
        ui('activate')
        wait(lambda: field('advancedToggle'), 'GUI unavailable after activation', 15)
        idle()

    def quit_app():
        idle()
        api('/commands', {'command': 'quit'})
        child.wait(timeout=10)
        assert child.returncode == 0 and not discovery.exists()
        result['launches'][-1]['exitCode'] = child.returncode
        log.close()
        no_plaintext()

    def advanced():
        if not int(value('advancedToggle')):
            ui('press', 'advancedToggle')
        wait(lambda: int(value('advancedToggle')) == 1, 'Advanced did not expand')
        if not int(value('audioEncodingToggle')):
            ui('press', 'audioEncodingToggle')
        wait(lambda: int(value('audioEncodingToggle')) == 1, 'Audio encoding settings did not expand')

    def numeric(name, expected):
        before = int(value(name))
        if before != expected:
            ui('increment' if expected > before else 'decrement', name, str(abs(expected-before)))
        assert int(value(name)) == expected

    def check(profile):
        choose(profile)
        assert value('outputUrlInput') == profile['url'], 'Restored URL differs: ' + profile['name']
        if 'secret' in profile:
            controls = [r for r in rows() if r.get('AXTitle') in ('Show', 'Hide')]
            result['revealControlAttributes'] = [{k: r.get(k) for k in ['AXRole', 'AXTitle', 'AXHelp', 'AXDescription', 'AXIdentifier']} for r in controls]
            shows = [r for r in controls if r.get('AXDescription') == 'Show output credential']
            assert len(shows) == 1, 'Secret reveal must address exactly one output credential button'
            ui('press', 'Show output credential')
            try:
                wait(lambda: value('outputSecretInput') == profile['secret'], 'Restored credential differs')
            finally:
                ui('press', 'Hide output credential')
        if 'streamId' in profile:
            assert value('outputStreamIdInput') == profile['streamId']
        for key, widget in [('latency', 'outputLatencySpin'), ('aac', 'aacBitrateSpin')]:
            if key in profile:
                assert int(value(widget)) == profile[key], 'Restored numeric setting differs: ' + key
        no_plaintext()
        idle()

    def reset(confirm):
        result['pendingReset'] = {'confirm': confirm, 'launch': result['launches'][-1]['label']}
        save()
        ui('press', 'Reset to Defaults...')
        wait(lambda: any(r.get('AXRole') == 'AXButton' and r.get('AXTitle') == 'Reset' for r in rows()),
             'Reset confirmation missing')
        ui('press', 'Reset' if confirm else 'Cancel')
        wait(lambda: not any(r.get('AXRole') == 'AXButton' and r.get('AXTitle') == 'Reset' for r in rows()),
             'Reset confirmation did not close')
        if confirm:
            wait(lambda: (field('streamIdInput') or {}).get('AXValue') == '' and
                 int((field('advancedToggle') or {}).get('AXValue', -1)) == 0,
                 'Confirmed Reset did not restore defaults')
            assert reference() is None
        idle()

    def interrupted(signum, frame):
        raise InterruptedError('Owned workflow interrupted')

    signal.signal(signal.SIGTERM, interrupted)

    try:
        print('Reports:', report, flush=True)
        state = json.loads(subprocess.check_output([str(helper), str(os.getpid()), 'session-state'], text=True))
        assert not state['screenLocked'], 'GUI workflow requires an unlocked session'
        result['sessionState'] = state
        start('populate')
        assert reference() is None
        ui('set', 'streamIdInput', 'owned-profile-fixture')
        advanced()
        for profile in profiles:
            choose(profile)
            ui('set', 'outputUrlInput', profile['url'])
            if 'secret' in profile:
                ui('set', 'outputSecretInput', profile['secret'])
            if 'streamId' in profile:
                ui('set', 'outputStreamIdInput', profile['streamId'])
            for key, widget in [('latency', 'outputLatencySpin'), ('aac', 'aacBitrateSpin')]:
                if key in profile:
                    numeric(widget, profile[key])
            remember()
        original = remember()
        for profile in reversed(profiles):
            check(profile)
        step('Seven distinct profiles survive native protocol switching without plaintext persistence')
        quit_app()

        start('restore')
        assert reference() == original
        advanced()
        for profile in profiles:
            check(profile)
        step('All seven profiles restore URLs, credentials and numeric settings after packaged relaunch')
        # Change one protocol, proving that updating its Keychain JSON does not
        # silently replace the other cached destination profiles.
        profiles[1]['secret'] = 'updated-srt-' + marker[:16]
        private_values.add(profiles[1]['secret'])
        profiles[1]['latency'] = 211
        choose(profiles[1])
        ui('set', 'outputSecretInput', profiles[1]['secret'])
        numeric('outputLatencySpin', profiles[1]['latency'])
        for profile in profiles:
            check(profile)
        assert reference() == original
        quit_app()

        start('restore-edited')
        advanced()
        for profile in profiles:
            check(profile)
        assert reference() == original
        step('Editing SRT preserves the same opaque reference and all other profiles across relaunch')
        quit_app()
        assert keychain('delete', original)
        assert not keychain('find', original)

        start('missing-item')
        wait(lambda: 'Keychain' in str(value('statusLabel')), 'Missing profile did not show a Keychain error')
        assert reference() == original
        choose({'title': 'VDO.Ninja (default)'})
        ui('set', 'streamIdInput', 'missing-item-preservation-check')
        no_plaintext()
        assert reference() == original and not keychain('find', original)
        reset(False)
        assert reference() == original and value('streamIdInput') == 'missing-item-preservation-check'
        step('Missing owned item shows an error and preserves the opaque reference through edits and cancelled Reset')
        reset(True)
        assert not keychain('find', original)
        step('Explicit Reset recovers from the missing item without recreating or touching another Keychain item')
        advanced()
        profile = profiles[0]
        choose(profile)
        ui('set', 'outputUrlInput', profile['url'])
        ui('set', 'outputSecretInput', profile['secret'])
        recovered = remember()
        assert recovered != original
        quit_app()

        start('recovered')
        advanced()
        check(profiles[0])
        assert reference() == recovered
        reset(False)
        assert reference() == recovered and keychain('find', recovered)
        reset(True)
        assert not keychain('find', recovered)
        step('Recovered profile survives relaunch; cancelled Reset preserves it and confirmed Reset removes its owned item')
        quit_app()

        start('defaults')
        assert reference() is None and value('streamIdInput') == '' and int(value('advancedToggle')) == 0
        quit_app()
        step('Reset defaults persist across relaunch, with capture and network output remaining off throughout')
        for p in report.glob('*.log'):
            text = p.read_text()
            assert marker not in text and all(private not in text for private in private_values), 'Private destination data leaked into app logs'
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        if child and child.poll() is None:
            try:
                (report / 'private-failure-ax.json').write_text(json.dumps(rows(), indent=2) + '\n')
            except Exception:
                pass
        if isinstance(error, subprocess.CalledProcessError):
            result['toolError'] = error.stderr
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
        # A failed workflow may have created an item before its first checkpoint.
        # Fresh private settings are the only source from which ownership is derived.
        try:
            if reference():
                owned.add(reference())
            for ref in owned:
                keychain('delete', ref)
                assert not keychain('find', ref)
            result['ownedItemsRemoved'] = len(owned)
        except Exception as error:
            result['cleanupError'] = repr(error)
            result['passed'] = False
        save()
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
