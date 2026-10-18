#!/usr/bin/env python3
"""Own a failing/stalled Secret Service on the explicitly isolated QA bus."""
import argparse
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

parser = argparse.ArgumentParser()
parser.add_argument('--mode', choices=['unavailable', 'stall'], required=True)
args = parser.parse_args()
DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
assert not bus.name_has_owner('org.freedesktop.secrets'), 'Never replace a running secret store'
name = dbus.service.BusName('org.freedesktop.secrets', bus, do_not_queue=True)


class Service(dbus.service.Object):
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {'Collections': dbus.Array([], signature='o')}

    @dbus.service.method('org.freedesktop.Secret.Service', in_signature='sv', out_signature='vo', async_callbacks=('reply', 'error'))
    def OpenSession(self, algorithm, value, reply, error):
        if args.mode == 'unavailable':
            error(dbus.exceptions.DBusException('Owned unavailable fixture', name='org.freedesktop.Secret.Error.IsLocked'))
        # Deliberately never answer in stall mode; the application must cancel.


service = Service(bus, '/org/freedesktop/secrets')
print('ready', flush=True)
GLib.MainLoop().run()
