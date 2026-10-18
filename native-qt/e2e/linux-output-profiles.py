#!/usr/bin/env python3
"""Packaged Qt GUI output-profile workflows with a private real GNOME keyring.

The outer process creates a separate session bus and XDG directories before
starting the keyring. Never locks, reads, replaces or deletes the user's store.
"""
import argparse
import base64
import configparser
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.request import Request, urlopen
import uuid


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def wait(check, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError('Workflow condition timed out')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--isolated-report', type=Path)
    args = parser.parse_args()
    if not args.isolated_report:
        report = args.reports.resolve() / str(uuid.uuid4())
        report.mkdir(parents=True, mode=0o700)
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(('QT_', 'VERSUS_', 'GAME_CAPTURE_', 'GNOME_KEYRING_', 'DBUS_')) or key in ['AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY']:
                env.pop(key)
        for key, suffix in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'runtime')]:
            directory = report / ('private-' + suffix)
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        env.update(QT_QPA_PLATFORM='xcb', XDG_SESSION_TYPE='x11', QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1')
        print('Report:', report, flush=True)
        return subprocess.call(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], '--isolated-report=' + str(report)], env=env)

    import dbus
    import gi
    gi.require_version('Secret', '1')
    from gi.repository import Secret
    report = args.isolated_report.resolve()
    assert Path(os.environ['XDG_DATA_HOME']).parent == report
    assert Path(os.environ['XDG_RUNTIME_DIR']).parent == report
    exe = args.publisher.resolve()
    bundle = exe.parent.parent.parent
    manifest_path = bundle / 'release-artifact-manifest.json'
    assert sha(manifest_path) == args.manifest_sha256
    manifest = json.loads(manifest_path.read_text())
    assert sha(exe) == manifest['artifact']['sha256']
    for entry in manifest['payload']['files']:
        file = (bundle / entry['relativePath']).resolve()
        assert file.is_relative_to(bundle) and file.stat().st_size == entry['size'] and sha(file) == entry['sha256']
    helper = Path(__file__).with_name('linux-ui-control.py')
    fixture = Path(__file__).with_name('linux-secret-service-fixture.py')
    for source in [Path(__file__), helper, fixture]:
        shutil.copyfile(source, report / source.name)
    helper = report / helper.name
    fixture = report / fixture.name
    result = {'scope': 'Extracted Ubuntu DEB; actual X11 Qt output-profile editing, switching, relaunch, locked/unavailable store and reset workflows. Real GNOME keyring on an isolated session bus. Excludes media publishing, Wayland GUI, other Secret Service providers and Windows/macOS regression.',
              'executableSha256': sha(exe), 'manifestSha256': sha(manifest_path), 'harnessSha256': sha(__file__),
              'guiHelperSha256': sha(helper), 'failureFixtureSha256': sha(fixture), 'phases': [], 'passed': False}
    save = lambda: (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    def record(name, **data):
        result['phases'].append({'name': name, **data})
        save()
    save()
    bus = dbus.SessionBus()
    assert not bus.name_has_owner('org.freedesktop.secrets')
    accessibility = bus.get_object('org.a11y.Bus', '/org/a11y/bus')
    dbus.Interface(accessibility, 'org.freedesktop.DBus.Properties').Set('org.a11y.Status', 'IsEnabled', dbus.Boolean(True))
    # Let Qt discover the private bus asynchronously. Qt 6.4 emits its initial
    # accessibility signal before the bridge connects when an address is forced.
    dbus.Interface(accessibility, 'org.a11y.Bus').GetAddress()
    password = secrets.token_hex(24)
    # AF_UNIX paths are limited to 107 bytes; report paths can exceed that.
    # A long control path makes gnome-keyring silently bind a truncated name.
    control_directory = tempfile.TemporaryDirectory(prefix='gc-keyring-')
    control_dir = Path(control_directory.name)
    assert len(str(control_dir / 'control').encode()) < 108
    keyring_log = (report / 'private-keyring.log').open('wb')
    keyring = None
    publisher = None
    stub = None
    control = None
    count = 0
    settings = report / 'private-settings'
    sensitive = []
    expected = {}

    def start_keyring():
        nonlocal keyring
        keyring = subprocess.Popen(['gnome-keyring-daemon', '--foreground', '--unlock', '--components=secrets', '--control-directory=' + str(control_dir)], stdin=subprocess.PIPE, stdout=keyring_log, stderr=keyring_log)
        keyring.stdin.write(password.encode())
        keyring.stdin.close()
        wait(lambda: bus.name_has_owner('org.freedesktop.secrets'))
        assert (control_dir / 'control').is_socket(), 'Owned keyring control socket is missing'
        Secret.Service.disconnect()
        service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
        collection = Secret.Collection.for_alias_sync(service, 'default', Secret.CollectionFlags.NONE, None)
        assert collection and not collection.get_locked(), 'Owned keyring is not unlocked'
        return service, collection

    def ui(*arguments):
        try:
            return subprocess.check_output([sys.executable, str(helper), str(publisher.pid), *arguments], timeout=12, text=True, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as error:
            raise RuntimeError('UI operation failed: ' + error.stderr) from None

    def api(route, body=None):
        request = Request(control['base_url'] + route, data=json.dumps(body).encode() if body else None,
                          headers={'Authorization': 'Bearer ' + control['token'], 'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def start():
        nonlocal publisher, control, count
        count += 1
        discovery = report / f'private-control-{count}.json'
        with (report / f'private-app-{count}.log').open('wb') as log:
            publisher = subprocess.Popen([str(exe), '--settings-dir=' + str(settings), '--local-control', '--local-control-port=0', '--local-control-discovery=' + str(discovery)], stdout=log, stderr=log)
        wait(lambda: discovery.exists() or publisher.poll() is not None, 15)
        assert publisher.poll() is None
        control = json.loads(discovery.read_text())
        assert control['pid'] == publisher.pid
        # Discovery precedes GUI construction and native capability probing.
        wait(lambda: subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(publisher.pid), '--name', '^Game Capture - Powered by VDO.Ninja$'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, 20)
        wait(lambda: bool(json.loads(ui('dump'))))
        assert not api('/diagnostics')['app']['capturing']
        return discovery

    def stop():
        nonlocal publisher
        if publisher and publisher.poll() is None:
            api('/commands', {'command': 'quit'})
            assert publisher.wait(timeout=10) == 0
        assert not (report / f'private-control-{count}.json').exists()
        publisher = None

    def config():
        file = settings / 'VDO.Ninja/Game Capture.ini'
        assert file.is_file(), 'Private application settings are missing'
        parsed = configparser.ConfigParser(interpolation=None)
        parsed.optionxform = str
        parsed.read(file)
        return parsed

    def reference():
        value = config().get('output', 'profilesEncrypted', fallback='')
        if value.startswith('@ByteArray('):
            value = value[len('@ByteArray('):-1]
        return base64.b64decode(value).decode()

    schema = Secret.Schema.new('ninja.vdo.game-capture.output-profiles', Secret.SchemaFlags.NONE, {'reference': Secret.SchemaAttributeType.STRING})
    def items():
        return service.search_sync(schema, {'reference': saved_reference}, Secret.SearchFlags.ALL, None)

    def read_saved():
        found = items()
        assert len(found) == 1 and not found[0].get_locked()
        found[0].load_secret_sync(None)
        raw = found[0].get_secret().get()
        if isinstance(raw, tuple):
            raw = raw[0]
        return json.loads(bytes(raw))

    def select(name):
        rows = json.loads(ui('dump'))
        choices = [r['name'] for r in rows if r['role'] == 'combo box' and r['name'] in [p[1] for p in protocols] + ['VDO.Ninja (default)']]
        assert len(choices) == 1
        if choices[0] != name:
            ui('choose', choices[0], name)

    def visible_error():
        return any(r['role'] == 'label' and ('desktop password store' in r['name'] or 'unsupported secret-store reference' in r['name']) and 'showing' in r['states'] for r in json.loads(ui('dump')))

    def check_plaintext():
        files = list(report.glob('private-app-*.log'))
        for directory in [settings, report / 'private-state', report / 'private-config', report / 'private-data']:
            files.extend(file for file in directory.rglob('*') if file.is_file())
        for file in files:
            contents = file.read_bytes()
            assert not any(value.encode() in contents for value in sensitive), 'Plaintext credential outside the secret store'

    def reset(success):
        ui('menu', 'File')
        ui('menu', 'Reset to Defaults...')
        ui('press', 'Reset')
        time.sleep(.3)
        if not success:
            assert any(r['name'] == 'Reset Failed' for r in json.loads(ui('dump')))
            ui('press', 'OK')

    protocols = [('whip', 'WHIP', 'WHIP bearer token'), ('srt', 'SRT (caller)', 'SRT passphrase'),
                 ('rtmp', 'RTMP / RTMPS', 'RTMP stream key'), ('rtsp', 'RTSP / VRChat (TCP)', None),
                 ('rtsp-udp', 'RTSP (UDP)', None), ('udp', 'UDP / MPEG-TS (LAN)', None), ('rist', 'RIST', None)]
    try:
        service, collection = start_keyring()
        started = time.monotonic()
        start()
        baseline_startup = time.monotonic() - started
        record('ordinary-startup', startupSeconds=baseline_startup)
        ui('press', 'Show advanced settings')
        (report / 'private-initial-ui.json').write_text(ui('dump'))
        assert not reference(), 'Ordinary startup created a secret-store item'
        for protocol, name, credential in protocols:
            select(name)
            marker = 'owned-' + secrets.token_hex(12)
            sensitive.append(marker)
            scheme = {'whip': 'https', 'rtsp-udp': 'rtsp', 'rtmp': 'rtmps'}.get(protocol, protocol)
            url = scheme + '://' + ('user:' + marker + '@' if protocol.startswith('rtsp') else '') + 'fixture.invalid/' + marker
            ui('text', 'Output URL', url)
            fields = {'url': url}
            if credential:
                secret = 'owned-' + secrets.token_hex(12)
                sensitive.append(secret)
                ui('text', credential, secret)
                fields[{'whip': 'token', 'srt': 'passphrase', 'rtmp': 'key'}[protocol]] = secret
            if protocol == 'srt':
                ui('text', 'Stream ID', marker)
                ui('value', 'SRT latency', '420')
                fields.update(streamId=marker, latencyMs=420)
            if protocol == 'rtmp':
                ui('press', 'Audio encoding')
                ui('value', 'AAC bitrate', '192')
                fields['aacBitrateKbps'] = 192
            expected[protocol] = fields
        saved_reference = reference()
        assert saved_reference.startswith('linux-secret-service-v1:')
        saved = read_saved()
        for protocol, fields in expected.items():
            assert all(saved[protocol][key] == value for key, value in fields.items()), protocol
        check_plaintext()
        record('seven-profiles-stored', referenceSha256=hashlib.sha256(saved_reference.encode()).hexdigest(), itemCount=len(items()))
        stop()
        start()
        for protocol, name, credential in protocols:
            select(name)
            assert json.loads(ui('read-text', 'Output URL')) == expected[protocol]['url']
            if credential:
                ui('reveal', credential)
                assert json.loads(ui('read-text', credential)) == expected[protocol][{'whip': 'token', 'srt': 'passphrase', 'rtmp': 'key'}[protocol]]
            if protocol == 'srt':
                assert json.loads(ui('read-text', 'Stream ID')) == expected[protocol]['streamId']
                assert next(r['value'] for r in json.loads(ui('dump')) if r['role'] == 'spin button' and r['name'] == 'SRT latency') == 420
            if protocol == 'rtmp':
                assert next(r['value'] for r in json.loads(ui('dump')) if r['role'] == 'spin button' and r['name'] == 'AAC bitrate') == 192
        record('gui-relaunch-restored-all-profiles')
        select('WHIP')
        changed = 'owned-' + secrets.token_hex(12)
        sensitive.append(changed)
        ui('text', 'WHIP bearer token', changed)
        assert reference() == saved_reference
        saved = read_saved()
        assert saved['whip']['token'] == changed and len(items()) == 1
        record('update-kept-reference-and-single-item')
        service.lock_sync([collection], None)
        unsaved = 'owned-unsaved-' + secrets.token_hex(8)
        sensitive.append(unsaved)
        ui('text', 'WHIP bearer token', unsaved)
        assert visible_error() and reference() == saved_reference
        check_plaintext()
        record('locked-autosave-error-preserved-reference')
        stop()
        start()
        assert visible_error()
        assert json.loads(ui('read-text', 'Output URL')) == ''
        reset(False)
        assert reference() == saved_reference
        record('locked-relaunch-and-reset-preserved-reference')
        stop()
        # Reopen the same on-disk store with its password in a fresh owned
        # daemon. --unlock alone does not reliably unlock an existing daemon.
        # This qualifies recovery after store restart, not in-place unlocking.
        keyring.terminate()
        keyring.wait(timeout=5)
        wait(lambda: not bus.name_has_owner('org.freedesktop.secrets'))
        service, collection = start_keyring()
        assert read_saved() == saved
        start()
        assert json.loads(ui('read-text', 'Output URL')) == expected['whip']['url']
        ui('reveal', 'WHIP bearer token')
        assert json.loads(ui('read-text', 'WHIP bearer token')) == changed
        record('store-restart-unlocked-and-relaunch-restored-preserved-profiles')
        # Delete only the exact owned item while its profile remains loaded.
        # Autosave must not silently recreate a missing saved destination.
        items()[0].delete_sync(None)
        ui('text', 'WHIP bearer token', unsaved)
        assert visible_error() and reference() == saved_reference and not items()
        stop()
        secret_value = Secret.Value.new(json.dumps(saved), -1, 'application/json')
        Secret.Item.create_sync(collection, schema, {'reference': saved_reference}, 'Owned QA restored profile', secret_value, Secret.ItemCreateFlags.NONE, None)
        record('missing-item-not-recreated-by-autosave')
        owned_item = items()[0]
        owned_item.set_secret_sync(Secret.Value.new('not-json', -1, 'application/json'), None)
        start()
        assert visible_error() and reference() == saved_reference
        ui('text', 'WHIP bearer token', unsaved)
        stop()
        owned_item.load_secret_sync(None)
        assert bytes(owned_item.get_secret().get()) == b'not-json'
        owned_item.set_secret_sync(secret_value, None)
        record('corrupt-profile-not-overwritten')
        duplicate = Secret.Item.create_sync(collection, schema, {'reference': saved_reference}, 'Owned QA duplicate profile', secret_value, Secret.ItemCreateFlags.NONE, None)
        assert len(items()) == 2
        start()
        assert visible_error() and reference() == saved_reference
        ui('text', 'WHIP bearer token', unsaved)
        stop()
        assert len(items()) == 2
        duplicate.delete_sync(None)
        assert read_saved() == saved
        record('ambiguous-reference-not-overwritten')
        settings_file = settings / 'VDO.Ninja/Game Capture.ini'
        encoded_reference = base64.b64encode(saved_reference.encode())
        invalid = 'unsupported-owned-reference'
        invalid_encoded = base64.b64encode(invalid.encode())
        contents = settings_file.read_bytes()
        assert contents.count(encoded_reference) == 1
        settings_file.write_bytes(contents.replace(encoded_reference, invalid_encoded))
        start()
        assert visible_error() and reference() == invalid
        ui('text', 'WHIP bearer token', unsaved)
        stop()
        assert reference() == invalid and read_saved() == saved
        settings_file.write_bytes(settings_file.read_bytes().replace(invalid_encoded, encoded_reference))
        record('unsupported-reference-preserved')
        check_plaintext()
        keyring.terminate(); keyring.wait(timeout=5)
        wait(lambda: not bus.name_has_owner('org.freedesktop.secrets'))
        for mode in ['unavailable', 'stall']:
            with (report / ('private-store-' + mode + '.log')).open('wb') as log:
                stub = subprocess.Popen([sys.executable, str(fixture), '--mode=' + mode], stdout=log, stderr=log)
            wait(lambda: bus.name_has_owner('org.freedesktop.secrets'))
            started = time.monotonic()
            start()
            assert visible_error() and reference() == saved_reference
            elapsed = time.monotonic() - started
            assert elapsed < baseline_startup + 6, 'Secret-store failure blocked startup beyond its bounded deadline'
            assert api('/health')['pid'] == publisher.pid
            stop()
            existing_settings = settings
            settings = report / ('private-first-save-' + mode)
            start()
            ui('press', 'Show advanced settings')
            select('WHIP')
            marker = 'owned-' + secrets.token_hex(12)
            sensitive.append(marker)
            started_save = time.monotonic()
            ui('text', 'Output URL', 'https://fixture.invalid/' + marker)
            save_elapsed = time.monotonic() - started_save
            assert save_elapsed < 5.5 and visible_error() and not reference()
            started_retry = time.monotonic()
            ui('text', 'WHIP bearer token', marker)
            assert time.monotonic() - started_retry < 2, 'Failed autosave retried on every edit'
            check_plaintext()
            stop()
            check_plaintext()
            settings = existing_settings
            stub.terminate(); stub.wait(timeout=5); stub = None
            wait(lambda: not bus.name_has_owner('org.freedesktop.secrets'))
            record(mode + '-store-bounded-and-preserved', startupSeconds=elapsed, firstSaveSeconds=save_elapsed)
        service, collection = start_keyring()
        assert read_saved() == saved
        start()
        reset(True)
        assert not reference() and not items()
        record('reset-deleted-owned-item-and-reference')
        stop()
        check_plaintext()
        record('no-plaintext-credentials-in-settings-logs-or-keyring-files')
        result['passed'] = True
    except Exception:
        result['error'] = traceback.format_exc()
        if publisher and publisher.poll() is None:
            try:
                (report / 'private-failure-ui.json').write_text(ui('dump'))
            except Exception:
                pass
    finally:
        if publisher and publisher.poll() is None:
            try:
                stop()
            except Exception:
                publisher.kill(); publisher.wait(timeout=5)
        for process in [stub, keyring]:
            if process and process.poll() is None:
                process.terminate(); process.wait(timeout=5)
        keyring_log.close()
        control_directory.cleanup()
        save()
        print(json.dumps({'report': str(report), 'passed': result['passed'], 'error': result.get('error')}), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
