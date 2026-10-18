#!/usr/bin/env python3
"""Run a workflow in owned software-rendered GNOME, PipeWire and session bus.

This qualifies an isolated Wayland compositor, not a physical GNOME session.
Hardware monitors are disabled. Keyboard input targets only this compositor's
RemoteDesktop session; it never uses the host keyboard or /dev/uinput.
"""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
import uuid
import dbus


KEYS = {
    'ESCAPE': [1], 'ALT_F': [56, 33], 'ALT_F7': [56, 65],
    'ALT_TAB': [56, 15], 'ALT_F4': [56, 62], 'CTRL_A': [29, 30],
    'CTRL_V': [29, 47], 'CTRL_C': [29, 46], 'SUPER_SHIFT_RIGHT': [125, 42, 106],
    'LEFT': [105], 'RIGHT': [106], 'UP': [103], 'DOWN': [108],
    'HOME': [102], 'SPACE': [57], 'TAB': [15], 'ENTER': [28],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--pulse-fault', action='store_true', help='Allow child to stop/start only the owned Pulse service; keep video PipeWire running')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    assert command and 1 <= args.timeout <= 7200
    assert '0.4.' in subprocess.check_output(['wireplumber', '--version'], text=True)
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    shutil.copyfile(__file__, report/Path(__file__).name)
    result = {'scope': __doc__, 'passed': False,
              'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'commandSha256': hashlib.sha256(json.dumps(command).encode()).hexdigest()}
    processes = []; logs = []; child = session = None
    retired_pids = set()

    def save():
        (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')

    def retire(process, group=False):
        if process and process.poll() is None:
            if group: os.killpg(process.pid, signal.SIGTERM)
            else: process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if group: os.killpg(process.pid, signal.SIGKILL)
                else: process.kill()
                process.wait(timeout=5)

    with tempfile.TemporaryDirectory(prefix='gc-gnome-') as temporary:
        root = Path(temporary)
        env = {k:v for k,v in os.environ.items() if k not in [
            'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'SESSION_MANAGER',
            'DESKTOP_AUTOSTART_ID', 'AT_SPI_BUS_ADDRESS', 'PULSE_SERVER', 'PIPEWIRE_REMOTE',
            'PIPEWIRE_RUNTIME_DIR', 'PIPEWIRE_CONFIG_DIR', 'PIPEWIRE_CONFIG_NAME',
            'PULSE_RUNTIME_PATH', 'PULSE_SINK', 'PULSE_SOURCE', 'PULSE_COOKIE',
            'WIREPLUMBER_CONFIG_DIR', 'GC_QA_KEYBOARD_SOCKET', 'GC_QA_AUDIO_SOCKET', 'GC_QA_AUDIO_FAULT_SCOPE'] and not k.startswith(
                ('QT_', 'GNOME_', 'GAME_CAPTURE_', 'VERSUS_'))}
        for key, name in [('XDG_RUNTIME_DIR', 'runtime'), ('XDG_CONFIG_HOME', 'config'),
                          ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('XDG_CACHE_HOME', 'cache')]:
            directory = root/name; directory.mkdir(mode=0o700); env[key] = str(directory)
        env.update(GSETTINGS_BACKEND='memory', LIBGL_ALWAYS_SOFTWARE='1',
                   XDG_SESSION_TYPE='wayland', XDG_CURRENT_DESKTOP='GNOME',
                   GNOME_SHELL_SESSION_MODE='user', WAYLAND_DISPLAY='gc-qa',
                   PIPEWIRE_RUNTIME_DIR=env['XDG_RUNTIME_DIR'],
                   PULSE_SERVER='unix:'+env['XDG_RUNTIME_DIR']+'/pulse/native',
                   GC_QA_OWNED_WAYLAND=str(report), GC_QA_KEYBOARD_SOCKET=str(root/'input.sock'))
        if args.pulse_fault:
            env.update(GC_QA_AUDIO_SOCKET=str(root/'audio.sock'), GC_QA_AUDIO_FAULT_SCOPE='pulse-only')
            result['audioFault'] = {'scope':'Owned pipewire-pulse only; compositor and video PipeWire stay running', 'actions':[]}
        config = root/'wireplumber'; shutil.copytree('/usr/share/wireplumber', config)
        main_config = config/'wireplumber.conf'
        main_config.write_text('\n'.join(line for line in main_config.read_text().splitlines()
                                         if 'name = bluetooth.lua' not in line)+'\n')
        monitors = config/'main.lua.d/90-enable-all.lua'; content = monitors.read_text()
        for name in ['alsa_monitor', 'v4l2_monitor', 'libcamera_monitor']:
            assert name+'.enable()' in content
            content = content.replace(name+'.enable()', '-- disabled by owned fixture: '+name)
        monitors.write_text(content); env['WIREPLUMBER_CONFIG_DIR'] = str(config)
        shutil.copytree(config, report/'wireplumber-config')

        def launch(name, argv, address_pipe=False):
            log = (report/(name+'.log')).open('w'); logs.append(log)
            process = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE if address_pipe else log,
                                       stderr=log, text=True)
            processes.append((name, process)); return process

        def wait_for(check, seconds=15):
            end = time.monotonic()+seconds
            while not check():
                assert all(p.poll() is None or p.pid in retired_pids for _, p in processes), 'Owned desktop service exited'
                if time.monotonic() >= end: raise RuntimeError('Owned desktop startup timed out')
                time.sleep(.1)

        def keys(values):
            assert isinstance(values, list) and len(values) <= 64 and all(k in KEYS for k in values)
            for key in values:
                pressed = []
                try:
                    for code in KEYS[key]:
                        session.NotifyKeyboardKeycode(dbus.UInt32(code), True); pressed.append(code)
                    time.sleep(.08)
                finally:
                    for code in reversed(pressed): session.NotifyKeyboardKeycode(dbus.UInt32(code), False)
                time.sleep(.2)

        def pactl(*values):
            return subprocess.check_output(['pactl', *values], env=env, text=True, stderr=subprocess.DEVNULL, timeout=3).strip()

        def audio_ready():
            def ready():
                try: pactl('info'); return True
                except subprocess.SubprocessError: return False
            wait_for(ready)
            pactl('load-module', 'module-null-sink', 'sink_name=gc_audio_default', 'rate=48000', 'channels=2')
            pactl('set-default-sink', 'gc_audio_default')

        def audio_action(action):
            nonlocal pulse
            assert action in ['stop', 'start']
            if action == 'stop':
                assert pulse.poll() is None, 'Owned Pulse service already stopped'
                retire(pulse); retired_pids.add(pulse.pid)
                state = {'retiredPid':pulse.pid, 'exitCode':pulse.returncode}
            else:
                assert pulse.poll() is not None, 'Owned Pulse service already running'
                pulse = launch('pulse-'+str(len(result['audioFault']['actions'])), ['pipewire-pulse'])
                audio_ready(); state = {'startedPid':pulse.pid}
            assert pipewire.poll() is None and shell.poll() is None, 'Audio-only fault interrupted desktop/video service'
            state.update(pipewirePid=pipewire.pid, shellPid=shell.pid)
            result['audioFault']['actions'].append({'action':action, **state}); save()
            return state

        print('Owned Wayland desktop:', report, flush=True)
        try:
            bus = launch('bus', ['dbus-daemon', '--session', '--nofork', '--print-address=1'], True)
            env['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.readline().strip()
            assert env['DBUS_SESSION_BUS_ADDRESS'].startswith('unix:')
            pipewire = launch('pipewire', ['pipewire'])
            wait_for(lambda: (root/'runtime/pipewire-0').is_socket())
            launch('wireplumber', ['wireplumber']); pulse = launch('pulse', ['pipewire-pulse'])
            if args.pulse_fault: audio_ready()
            shell = launch('shell', ['gnome-shell', '--headless', '--wayland', '--no-x11', '--sm-disable',
                                     '--virtual-monitor=1440x1000', '--wayland-display=gc-qa'])
            wait_for(lambda: (root/'runtime/gc-qa').is_socket())
            connection = dbus.bus.BusConnection(env['DBUS_SESSION_BUS_ADDRESS'])
            wait_for(lambda: connection.name_has_owner('org.gnome.Mutter.RemoteDesktop'))
            daemon = dbus.Interface(connection.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus'), 'org.freedesktop.DBus')
            assert int(daemon.GetConnectionUnixProcessID('org.gnome.Mutter.RemoteDesktop')) == shell.pid
            owner = str(daemon.GetNameOwner('org.gnome.Shell')); result['shellOwner'] = owner
            a11y = connection.get_object('org.a11y.Bus', '/org/a11y/bus')
            dbus.Interface(a11y, 'org.freedesktop.DBus.Properties').Set('org.a11y.Status', 'IsEnabled', dbus.Boolean(True))
            # Let Qt discover the address asynchronously through the session bus.
            # Qt 6.4's explicit-address path can signal before its bridge connects.
            dbus.Interface(a11y, 'org.a11y.Bus').GetAddress()
            remote = dbus.Interface(connection.get_object('org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop'), 'org.gnome.Mutter.RemoteDesktop')
            session = dbus.Interface(connection.get_object('org.gnome.Mutter.RemoteDesktop', remote.CreateSession()), 'org.gnome.Mutter.RemoteDesktop.Session')
            session.Start(); time.sleep(1); keys(['ESCAPE'])
            cards = json.loads(subprocess.check_output(['pactl', '--format=json', 'list', 'cards'], env=env, text=True, timeout=5))
            assert cards == []; result['hardwareCards'] = 0
            result['ownedPids'] = {name:p.pid for name,p in processes}; result['runtime'] = str(root)
            with ExitStack() as stack:
                server = stack.enter_context(socket.socket(socket.AF_UNIX))
                server.bind(env['GC_QA_KEYBOARD_SOCKET']); os.chmod(env['GC_QA_KEYBOARD_SOCKET'], 0o600); server.listen(1)
                servers = [server]; audio_server = None
                if args.pulse_fault:
                    audio_server = stack.enter_context(socket.socket(socket.AF_UNIX))
                    audio_server.bind(env['GC_QA_AUDIO_SOCKET']); os.chmod(env['GC_QA_AUDIO_SOCKET'], 0o600); audio_server.listen(1)
                    servers.append(audio_server)
                child = subprocess.Popen(command, env=env, start_new_session=True)
                result['childPid'] = child.pid; save(); end = time.monotonic()+args.timeout
                while child.poll() is None:
                    assert shell.poll() is None, 'Owned compositor exited during workflow'
                    if time.monotonic() >= end: raise RuntimeError('Owned workflow deadline exceeded')
                    ready, _, _ = select.select(servers, [], [], .2)
                    if not ready: continue
                    selected = ready[0]
                    with selected.accept()[0] as client:
                        client.settimeout(3)
                        _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        assert uid == os.getuid()
                        data = b''
                        while not data.endswith(b'\n') and len(data) < 4096:
                            block = client.recv(4096-len(data))
                            if not block: break
                            data += block
                        if selected is audio_server:
                            try:
                                action = data.decode().strip()
                                response = {'passed':True, 'action':action, 'result':audio_action(action)}
                            except Exception as error:
                                response = {'passed':False, 'error':repr(error)}
                            client.sendall((json.dumps(response)+'\n').encode())
                        else:
                            keys(json.loads(data)); client.sendall(b'ok')
                result['exitCode'] = child.wait()
                result['compositorSurvived'] = shell.poll() is None and str(daemon.GetNameOwner('org.gnome.Shell')) == owner
                result['passed'] = result['exitCode'] == 0 and result['compositorSurvived']
        except Exception as error:
            result['error'] = repr(error)
        finally:
            retire(child, True)
            if session:
                try: session.Stop()
                except dbus.DBusException: pass
            for _, process in reversed(processes): retire(process)
            result['retired'] = {name:p.returncode for name,p in processes}
            result['ownedProcessesRetired'] = all(p.poll() is not None for _,p in processes) and (child is None or child.poll() is not None)
            result['passed'] = bool(result['passed'] and result['ownedProcessesRetired'])
            for log in logs: log.close()
            save()
    print(json.dumps({'report':str(report/'results.json'), 'passed':result['passed'], 'error':result.get('error')}), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
