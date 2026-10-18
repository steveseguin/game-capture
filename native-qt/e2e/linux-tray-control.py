#!/usr/bin/env python3
"""Operate an owned packaged application's real GNOME tray menu through AT-SPI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import dbus
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, GLib


stale_nodes_skipped = 0


def read_accessible(call):
    global stale_nodes_skipped
    try:
        return call()
    except GLib.Error as error:
        # GNOME may retire unrelated overview/window objects during traversal.
        # Do not swallow transport failures or failures of the chosen action.
        if 'does not exist' not in str(error):
            raise
        stale_nodes_skipped += 1
        return None


def role(node):
    return read_accessible(node.get_role_name) or ''


def name(node):
    return read_accessible(node.get_name) or ''


def nodes(node):
    count = read_accessible(node.get_child_count)
    if count is None:
        return
    yield node
    for i in range(count):
        child = read_accessible(lambda: node.get_child_at_index(i))
        if child:
            yield from nodes(child)


def pump():
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)


def has(node, state):
    states = read_accessible(node.get_state_set)
    return states is not None and states.contains(state)


def keys(values):
    command = [sys.executable, str(Path(__file__).with_name('linux-portal-select.py')), '--keys', *values]
    if not os.environ.get('GC_QA_KEYBOARD_SOCKET'):
        command = ['sudo', '-n', *command]
    subprocess.run(command, check=True, timeout=10)
    time.sleep(.25); pump()


def focus(node):
    assert node.get_component_iface().grab_focus(), 'Tray control refused focus'
    time.sleep(.15); pump()
    assert has(node, Atspi.StateType.FOCUSED), 'Tray control is not focused'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pid', type=int)
    parser.add_argument('command', choices=['snapshot', 'menu', 'action'])
    parser.add_argument('name', nargs='?')
    parser.add_argument('--screenshot', type=Path)
    args = parser.parse_args()
    assert Path(f'/proc/{args.pid}/exe').resolve().name == 'game-capture'
    bus = dbus.SessionBus()
    watcher = bus.get_object('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher')
    entries = watcher.Get('org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems', dbus_interface='org.freedesktop.DBus.Properties')
    daemon = bus.get_object("org.freedesktop.DBus", "/org/freedesktop/DBus")
    owned = []
    for value in entries:
        service, separator, path = str(value).partition('@')
        if not separator:
            service, path = str(value).split('/', 1); path = '/' + path
        if int(daemon.GetConnectionUnixProcessID(service, dbus_interface="org.freedesktop.DBus")) == args.pid:
            owned.append((service, path))
    assert len(owned) == 1, 'Owned process must register exactly one tray item'
    service, path = owned[0]
    item = bus.get_object(service, path)
    properties = item.GetAll('org.kde.StatusNotifierItem', dbus_interface='org.freedesktop.DBus.Properties')
    result = {key: str(properties[key]) for key in ['Id', 'Title', 'Status']}
    result['tooltip'] = str(properties['ToolTip'][2])
    result['iconSha256'] = hashlib.sha256(b''.join(bytes(row[2]) for row in properties['IconPixmap'])).hexdigest()
    result['service'] = service; result['pid'] = args.pid
    if args.command == 'snapshot':
        print(json.dumps(result)); return
    desktop = Atspi.get_desktop(0)
    applications = [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
    shell = next(node for node in applications if node is not None and name(node) == 'gnome-shell')
    menus = [node for node in nodes(shell) if role(node) == 'menu' and name(node) == result['Title'] and has(node, Atspi.StateType.SHOWING)]
    assert len(menus) == 1, 'Tray icon is absent or ambiguous in the actual desktop'
    def shown_quit():
        return [node for node in nodes(shell) if role(node) == 'label' and name(node) == 'Quit' and has(node, Atspi.StateType.SHOWING)]
    labels = shown_quit()
    if not labels:
        focus(menus[0]); keys(['SPACE']); labels = shown_quit()
    assert len(labels) == 1, 'Owned tray popup did not open uniquely'
    panel = labels[0].get_parent().get_parent()
    rows = [node for node in nodes(panel) if role(node) == 'label' and name(node)]
    result['menu'] = [{'name': name(node), 'enabled': has(node.get_parent(), Atspi.StateType.SENSITIVE)} for node in rows]
    expected = {'Hide', 'Show', 'Go Live', 'Stop', 'Starting...', 'Stopping...', 'Copy Share Link', 'Open Share Link', 'Quit'}
    assert {row['name'] for row in result['menu']} <= expected, 'Unexpected popup menu: ' + repr(result['menu'])
    if args.screenshot:
        subprocess.run(['gnome-screenshot', '-f', str(args.screenshot)], check=True, timeout=10)
    if args.command == 'action':
        targets = [node.get_parent() for node in rows if name(node) == args.name]
        assert len(targets) == 1 and has(targets[0], Atspi.StateType.SENSITIVE), 'Tray action is missing or disabled'
        focus(targets[0]); keys(['ENTER']); result['action'] = args.name
    result['staleNodesSkipped'] = stale_nodes_skipped
    print(json.dumps(result))


if __name__ == '__main__':
    main()
