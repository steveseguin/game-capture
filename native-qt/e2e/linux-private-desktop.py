#!/usr/bin/env python3
"""Run owned GUI workflows with an isolated session bus and real private keyring."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def wait(check):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.1)
    raise RuntimeError('Private desktop startup timed out')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--isolated', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    assert command
    if not args.isolated:
        report = args.reports.resolve() / str(uuid.uuid4())
        report.mkdir(parents=True, mode=0o700)
        shutil.copyfile(__file__, report / Path(__file__).name)
        env = dict(os.environ)
        # Keep the host Pulse socket explicit before replacing XDG_RUNTIME_DIR.
        env['PULSE_SERVER'] = env.get('PULSE_SERVER', 'unix:' + env.get('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid())) + '/pulse/native')
        for name in list(env):
            if name.startswith(('QT_', 'DBUS_', 'GNOME_KEYRING_', 'GAME_CAPTURE_', 'VERSUS_')) or name in ['AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY']:
                env.pop(name)
        for name, suffix in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'runtime')]:
            directory = report / ('private-' + suffix)
            directory.mkdir(mode=0o700)
            env[name] = str(directory)
        env.update(QT_QPA_PLATFORM='xcb', XDG_SESSION_TYPE='x11', QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1', GC_QA_PRIVATE_DESKTOP=str(report))
        print('Private desktop:', report, flush=True)
        return subprocess.call(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), '--reports=' + str(args.reports), '--isolated=' + str(report), '--', *command], env=env)

    import dbus
    import gi
    gi.require_version('Secret', '1')
    from gi.repository import Secret
    report = args.isolated.resolve()
    assert os.environ['GC_QA_PRIVATE_DESKTOP'] == str(report)
    assert Path(os.environ['XDG_DATA_HOME']).parent == report
    bus = dbus.SessionBus()
    assert not bus.name_has_owner('org.freedesktop.secrets'), 'Never replace an existing store'
    accessibility = bus.get_object('org.a11y.Bus', '/org/a11y/bus')
    dbus.Interface(accessibility, 'org.freedesktop.DBus.Properties').Set('org.a11y.Status', 'IsEnabled', dbus.Boolean(True))
    dbus.Interface(accessibility, 'org.a11y.Bus').GetAddress()
    child = keyring = None
    result = {'scope': 'Owned isolated desktop/keyring fixture; application evidence is in child workflow reports.', 'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'passed': False}
    try:
        with tempfile.TemporaryDirectory(prefix='gc-gui-keyring-') as control, (report / 'private-keyring.log').open('wb') as log:
            keyring = subprocess.Popen(['gnome-keyring-daemon', '--foreground', '--unlock', '--components=secrets', '--control-directory=' + control], stdin=subprocess.PIPE, stdout=log, stderr=log)
            keyring.stdin.write(secrets.token_hex(24).encode())
            keyring.stdin.close()
            wait(lambda: bus.name_has_owner('org.freedesktop.secrets'))
            assert (Path(control) / 'control').is_socket()
            service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
            collection = Secret.Collection.for_alias_sync(service, 'default', Secret.CollectionFlags.NONE, None)
            assert collection and not collection.get_locked()
            child = subprocess.Popen(command, start_new_session=True)
            result['exitCode'] = child.wait()
            result['passed'] = result['exitCode'] == 0
            keyring.terminate()
            keyring.wait(timeout=5)
    finally:
        if child and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        if keyring and keyring.poll() is None:
            keyring.terminate()
            keyring.wait(timeout=5)
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
