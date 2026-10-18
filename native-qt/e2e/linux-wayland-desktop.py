#!/usr/bin/env python3
"""Native GNOME/Wayland workflows with an owned, separately named real keyring.

Only the keyring uses a filtered session-bus proxy. It may own its random QA
name; it cannot contact the existing store or change the GNOME session env.
The application retains native portal/accessibility access and uses libsecret's
service-name override. No desktop store is unlocked, replaced or modified.
"""
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
import dbus


def wait(check):
    end = time.monotonic() + 15
    while time.monotonic() < end:
        if check():
            return
        time.sleep(.1)
    raise RuntimeError('Owned Wayland fixture startup timed out')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    assert command and os.environ.get('DBUS_SESSION_BUS_ADDRESS')
    bus = dbus.SessionBus()
    daemon = dbus.Interface(bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus'), 'org.freedesktop.DBus')
    def owner(name):
        return str(daemon.GetNameOwner(name)) if bus.name_has_owner(name) else None
    originals = {name: owner(name) for name in ['org.freedesktop.secrets', 'org.gnome.keyring']}
    report = args.reports.resolve() / str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    shutil.copyfile(__file__, report / Path(__file__).name)
    service_name = 'ninja.vdo.GameCapture.QA.s' + uuid.uuid4().hex
    assert not bus.name_has_owner(service_name)
    # Refuse this fixture on builds without GNOME's alternate-service support.
    assert b'GNOME_KEYRING_TEST_SERVICE' in Path('/usr/bin/gnome-keyring-daemon').read_bytes()
    env = {k:v for k,v in os.environ.items() if not k.startswith(('QT_', 'GNOME_KEYRING_', 'GAME_CAPTURE_', 'VERSUS_')) and k not in ['AT_SPI_BUS_ADDRESS','DESKTOP_AUTOSTART_ID','SECRET_SERVICE_BUS_NAME']}
    for key, suffix in [('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state')]:
        directory = report / ('private-' + suffix); directory.mkdir(mode=0o700); env[key] = str(directory)
    env.update(QT_QPA_PLATFORM='wayland', XDG_SESSION_TYPE='wayland', WAYLAND_DISPLAY=os.environ.get('WAYLAND_DISPLAY','wayland-0'),
               QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1', SECRET_SERVICE_BUS_NAME=service_name, GC_QA_WAYLAND_DESKTOP=str(report))
    result = {'scope':'Native Wayland desktop and portal with an owned GNOME keyring under a random service name behind an own-name-only D-Bus proxy; existing desktop secret-store owners remain unchanged.',
              'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'serviceName':service_name,'originalOwners':originals,'passed':False}
    result['sessionBusId'] = str(daemon.GetId())
    proxy = keyring = child = None
    print('Native Wayland fixture:', report, flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix='gc-wayland-store-') as temporary, (report/'private-keyring.log').open('wb') as keyring_log, (report/'private-proxy.log').open('wb') as proxy_log:
            directory = Path(temporary); socket = directory/'bus'; control = directory/'control'; control.mkdir(mode=0o700)
            runtime = directory/'runtime'; runtime.mkdir(mode=0o700)
            proxy = subprocess.Popen(['xdg-dbus-proxy',os.environ['DBUS_SESSION_BUS_ADDRESS'],str(socket),'--filter','--own='+service_name],stdout=proxy_log,stderr=proxy_log)
            wait(lambda: socket.is_socket())
            filtered_bus = dbus.bus.BusConnection('unix:path='+str(socket))
            assert not filtered_bus.name_has_owner('org.freedesktop.secrets')
            assert not filtered_bus.name_has_owner('org.gnome.SessionManager')
            result['existingStoreAndSessionManagerHidden']=True
            filtered_bus.close()
            keyring_env = {**env,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+str(socket),'GNOME_KEYRING_TEST_SERVICE':service_name,'XDG_RUNTIME_DIR':str(runtime)}
            keyring = subprocess.Popen(['gnome-keyring-daemon','--foreground','--unlock','--components=secrets','--control-directory='+str(control)],env=keyring_env,stdin=subprocess.PIPE,stdout=keyring_log,stderr=keyring_log)
            keyring.stdin.write(secrets.token_hex(24).encode()); keyring.stdin.close()
            wait(lambda: bus.name_has_owner(service_name))
            assert int(daemon.GetConnectionUnixProcessID(service_name)) == proxy.pid
            assert {name:owner(name) for name in originals} == originals
            # This child initializes libsecret after setting the service override.
            subprocess.run([sys.executable,'-c',"import gi; gi.require_version('Secret','1'); from gi.repository import Secret; s=Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION,None); c=Secret.Collection.for_alias_sync(s,'default',Secret.CollectionFlags.NONE,None); assert c and not c.get_locked()"],env=env,check=True,timeout=10)
            result['ownedStoreUnlocked']=True
            child = subprocess.Popen(command,env=env,start_new_session=True)
            result['ownedPids'] = {'child':child.pid,'keyring':keyring.pid,'proxy':proxy.pid}
            (report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
            result['exitCode']=child.wait(); result['passed']=result['exitCode']==0
    except Exception as error:
        result['error']=repr(error)
    finally:
        cleanup_errors = []
        for name, process in [('child',child),('keyring',keyring),('proxy',proxy)]:
            try:
                if process and process.poll() is None:
                    if name == 'child': os.killpg(process.pid,signal.SIGTERM)
                    else: process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        if name == 'child': os.killpg(process.pid,signal.SIGKILL)
                        else: process.kill()
                        process.wait(timeout=5)
            except Exception as error:
                cleanup_errors.append(name+': '+repr(error))
        result['ownedProcessesRetired'] = all(process is None or process.poll() is not None for process in [child,keyring,proxy])
        # Desktop failure may disconnect this bus. Preserve the child outcome
        # and cleanup evidence even when ownership can no longer be queried.
        result.update(storeRetired=None, originalOwnersUnchanged=None, sessionBusUnchanged=None)
        try:
            result['sessionBusUnchanged'] = str(daemon.GetId()) == result['sessionBusId']
            result['storeRetired']=not bus.name_has_owner(service_name)
            result['originalOwnersUnchanged']={name:owner(name) for name in originals}==originals
        except Exception as error:
            cleanup_errors.append('session bus: '+repr(error))
        if cleanup_errors: result['cleanupErrors'] = cleanup_errors
        result['passed']=bool(result['passed'] and result['ownedProcessesRetired'] and
                              result['storeRetired'] and result['originalOwnersUnchanged'] and
                              result['sessionBusUnchanged'] and not cleanup_errors)
        (report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'report':str(report),'passed':result['passed'],'error':result.get('error')}),flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
