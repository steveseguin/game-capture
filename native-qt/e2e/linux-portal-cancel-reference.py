#!/usr/bin/env python3
"""Independent owned portal cancellation comparison; not application testing."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid
import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports', type=Path, required=True)
    parser.add_argument('--close-mode', choices=['session', 'request', 'request-session'], required=True)
    args = parser.parse_args()
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True, mode=0o700)
    shutil.copyfile(__file__, report / Path(__file__).name)
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus(private=True)
    bus.set_exit_on_disconnect(False)
    watcher = dbus.SessionBus(private=True)
    watcher.set_exit_on_disconnect(False)
    service = 'org.freedesktop.portal.Desktop'
    backend = 'org.freedesktop.impl.portal.desktop.gnome'
    desktop = dbus.Interface(bus.get_object(service, '/org/freedesktop/portal/desktop'), 'org.freedesktop.portal.ScreenCast')
    prefix = bus.get_unique_name()[1:].replace('.', '_')
    result = {'classification': 'Independent desktop portal comparison, not application testing.', 'mode': args.close_mode, 'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'responses': {}}
    started = time.time()
    session = None
    owner = None

    def pump(seconds):
        loop = GLib.MainLoop()
        GLib.timeout_add(int(seconds * 1000), lambda: (loop.quit(), False)[1])
        loop.run()

    def request(method, arguments, options=None, wait=True):
        token = 'gc_reference_' + uuid.uuid4().hex
        path = '/org/freedesktop/portal/desktop/request/' + prefix + '/' + token
        values = []
        def response(code, data):
            values.append((int(code), data))
            result['responses'][method] = int(code)
        bus.add_signal_receiver(response, signal_name='Response', dbus_interface='org.freedesktop.portal.Request', path=path)
        opts = dbus.Dictionary(options or {}, signature='sv');opts['handle_token'] = token
        actual = getattr(desktop, method)(*arguments, opts, timeout=5)
        assert str(actual) == path
        if wait:
            deadline = time.monotonic() + 5
            while not values and time.monotonic() < deadline:
                pump(.05)
            assert values and values[0][0] == 0, method + ' failed'
            return values[0][1]
        return path

    def same_owner(owner):
        try:
            return str(watcher.get_name_owner(backend)) == owner
        except dbus.DBusException:
            return False

    try:
        data = request('CreateSession', [], {'session_handle_token': 'gc_reference_' + uuid.uuid4().hex})
        session = str(data['session_handle'])
        def session_closed(details):
            result['sessionClosedSignal'] = True
        bus.add_signal_receiver(session_closed, signal_name='Closed',
                                dbus_interface='org.freedesktop.portal.Session',
                                bus_name=service, path=session)
        request('SelectSources', [dbus.ObjectPath(session)], {'types': dbus.UInt32(2), 'multiple': dbus.Boolean(False)})
        pending = request('Start', [dbus.ObjectPath(session), ''], wait=False)
        pump(2)
        assert 'Start' not in result['responses'], 'Permission request was not pending'
        owner = str(watcher.get_name_owner(backend))
        result['backendOwnerBefore'] = owner
        if args.close_mode in ('request', 'request-session'):
            dbus.Interface(bus.get_object(service, pending), 'org.freedesktop.portal.Request').Close(timeout=5)
        if args.close_mode in ('session', 'request-session'):
            try:
                dbus.Interface(bus.get_object(service, session), 'org.freedesktop.portal.Session').Close(timeout=5)
                result['sessionCloseReply'] = 'success'
            except dbus.DBusException as error:
                # Request.Close can retire the session before this second call.
                # Require its actual Closed signal; backend survival alone is insufficient.
                pump(.2)
                if (args.close_mode != 'request-session'
                        or error.get_dbus_name() not in ('org.freedesktop.DBus.Error.UnknownMethod',
                                                        'org.freedesktop.DBus.Error.UnknownObject')
                        or not result.get('sessionClosedSignal')):
                    raise
                result['sessionCloseReply'] = 'already-closed-with-signal'
        session = None
        pump(2)
        result['backendSurvivedClose'] = same_owner(owner)
        bus.close()
        pump(2)
        result['backendSurvivedDisconnect'] = same_owner(owner)
        result['passed'] = result['backendSurvivedClose'] and result['backendSurvivedDisconnect']
    except Exception as error:
        result['error'] = str(error); result['passed'] = False
    finally:
        if bus.get_is_connected():
            if session:
                try:
                    dbus.Interface(bus.get_object(service, session), 'org.freedesktop.portal.Session').Close(timeout=5)
                except dbus.DBusException:
                    pass
            bus.close()
        pump(2)
        if owner:
            result['backendSurvivedCleanup'] = same_owner(owner)
            result['passed'] = result['passed'] and result['backendSurvivedCleanup']
        watcher.close()
        journal = subprocess.check_output(['journalctl', '--user', '-u', 'xdg-desktop-portal.service', '-u', 'xdg-desktop-portal-gnome.service', '--since=@' + str(int(started)), '--no-pager', '-o', 'short-iso'], text=True)
        (report / 'portal-journal.log').write_text(journal)
        result['journalSha256'] = hashlib.sha256(journal.encode()).hexdigest()
        (report / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'report': str(report), **result}, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
