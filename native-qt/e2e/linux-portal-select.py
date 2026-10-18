#!/usr/bin/env python3
"""Operate the real GNOME portal picker for an owned, uniquely titled fixture.

Uses AT-SPI to identify/verify the exact dialog and normal keyboard events to
operate GTK4 rows that lack an accessible selection action. The input helper
requires access to /dev/uinput (sudo is scoped to this helper, not the app).
"""
import argparse
import json
import os
import select
import socket
import struct
from pathlib import Path
import subprocess
import sys
import time


ALLOWED_KEYS = {"SUPER_SHIFT_RIGHT", "ALT_F", "UP", "HOME", "DOWN", "SPACE", "TAB", "ENTER", "ALT_TAB", "ALT_F4", "CTRL_A", "CTRL_V", "CTRL_C"}


def emit_keys(device, keys):
    from evdev import ecodes as ec
    if not isinstance(keys, list) or len(keys) > 64 or any(key not in ALLOWED_KEYS for key in keys):
        raise RuntimeError("Unexpected QA keys")
    for key in keys:
        if key == 'SUPER_SHIFT_RIGHT':
            chord = [ec.KEY_LEFTMETA, ec.KEY_LEFTSHIFT, ec.KEY_RIGHT]
            for code in chord: device.write(ec.EV_KEY, code, 1)
            device.syn();time.sleep(.05)
            for code in reversed(chord): device.write(ec.EV_KEY, code, 0)
            device.syn();time.sleep(.25)
            continue
        chords = {"ALT_F": (ec.KEY_LEFTALT, ec.KEY_F), "ALT_TAB": (ec.KEY_LEFTALT, ec.KEY_TAB), "ALT_F4": (ec.KEY_LEFTALT, ec.KEY_F4),
                  "CTRL_A": (ec.KEY_LEFTCTRL, ec.KEY_A), "CTRL_V": (ec.KEY_LEFTCTRL, ec.KEY_V), "CTRL_C": (ec.KEY_LEFTCTRL, ec.KEY_C)}
        if key in chords:
            modifier, button = chords[key]
            device.write(ec.EV_KEY, modifier, 1)
            device.write(ec.EV_KEY, button, 1); device.syn()
            time.sleep(.05)
            device.write(ec.EV_KEY, button, 0)
            device.write(ec.EV_KEY, modifier, 0); device.syn()
            time.sleep(.25)
            continue
        code = getattr(ec, "KEY_" + key)
        device.write(ec.EV_KEY, code, 1); device.syn()
        time.sleep(.08)
        device.write(ec.EV_KEY, code, 0); device.syn()
        time.sleep(.15)
    time.sleep(.3)


def keyboard(keys):
    if os.environ.get('GC_QA_KEYBOARD_SOCKET'):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(8)
            client.connect(os.environ['GC_QA_KEYBOARD_SOCKET'])
            client.sendall(json.dumps(keys).encode() + b'\n')
            if client.recv(32) != b'ok':
                raise RuntimeError('Owned keyboard rejected input')
        return
    import evdev
    from evdev import ecodes as ec
    with evdev.UInput({ec.EV_KEY: list(range(1, 248))}, name="Game Capture owned QA keyboard") as device:
        time.sleep(1.5)
        emit_keys(device, keys)


def keyboard_server(path):
    import evdev
    from evdev import ecodes as ec
    owner = int(os.environ['SUDO_UID'])
    assert os.getuid() == 0 and owner > 0
    assert path.parent.name.startswith('gc-wayland-keys-') and not path.exists()
    with socket.socket(socket.AF_UNIX) as server, evdev.UInput({ec.EV_KEY: list(range(1, 248))}, name='Game Capture owned QA keyboard') as device:
        server.bind(str(path)); os.chmod(path, 0o600); os.chown(path, owner, -1)
        server.listen(1)
        time.sleep(1.5)
        print('ready', flush=True)
        try:
            while True:
                ready, _, _ = select.select([server, sys.stdin], [], [], 2)
                if sys.stdin in ready and not sys.stdin.readline():
                    break
                if server not in ready:
                    continue
                with server.accept()[0] as client:
                    client.settimeout(5)
                    _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != owner:
                        continue
                    data = b''
                    while not data.endswith(b'\n') and len(data) < 4096:
                        chunk = client.recv(4096 - len(data))
                        if not chunk:
                            break
                        data += chunk
                    emit_keys(device, json.loads(data))
                    client.sendall(b'ok')
        finally:
            path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--title")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cancel", action="store_true")
    parser.add_argument("--observe", choices=["open", "closed"])
    parser.add_argument("--keys", nargs="+")
    parser.add_argument("--keyboard-server", type=Path)
    args = parser.parse_args()
    if args.keyboard_server:
        keyboard_server(args.keyboard_server)
        return
    if args.keys:
        if any(key not in ALLOWED_KEYS for key in args.keys):
            raise SystemExit("Unexpected QA key")
        keyboard(args.keys)
        return
    if not args.title or not args.title.startswith("Owned Linux Capture "):
        raise SystemExit("Only an owned fixture may be selected")
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib

    def nodes(node):
        yield node
        for index in range(node.get_child_count()):
            child = node.get_child_at_index(index)
            if child:
                yield from nodes(child)

    def dialog_nodes():
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        root = Atspi.get_desktop(0)
        for index in range(root.get_child_count()):
            app = root.get_child_at_index(index)
            if app is not None and app.get_name() == "xdg-desktop-portal-gnome":
                for dialog in nodes(app):
                    if dialog.get_role_name() == "frame" and dialog.get_name() == "Share Screen":
                        return list(nodes(dialog))
        return []

    result = {"title": args.title, "mode": args.observe or ("cancel" if args.cancel else "share"), "actions": [], "passed": False}
    def save():
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + "\n")

    def send(keys):
        result["actions"].append(keys); save()
        subprocess.run([*(["sudo", "-n"] if not os.environ.get("GC_QA_KEYBOARD_SOCKET") else []), sys.executable, str(Path(__file__).resolve()), "--keys", *keys], check=True, timeout=10)

    try:
        if args.observe == 'closed':
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if not any(n.get_role_name() == 'list item' and n.get_name().startswith(args.title) for n in dialog_nodes()):
                    result['passed'] = True
                    return
                time.sleep(.1)
            raise RuntimeError('Owned portal dialog did not close')
        deadline = time.monotonic() + 20
        target = None
        while time.monotonic() < deadline:
            target = next((node for node in dialog_nodes() if node.get_role_name() == "list item" and
                           node.get_name().startswith(args.title)), None)
            if target and any(target.get_parent().get_child_at_index(i).get_state_set().contains(Atspi.StateType.FOCUSED)
                              for i in range(target.get_parent().get_child_count())):
                break
            target = None
            time.sleep(0.2)
        if target is None:
            raise RuntimeError("Owned fixture is absent from the real portal picker")
        if args.observe == 'open':
            result['passed'] = True
            return
        siblings = [target.get_parent().get_child_at_index(i) for i in range(target.get_parent().get_child_count())]
        if not any(node.get_state_set().contains(Atspi.StateType.FOCUSED) for node in siblings):
            raise RuntimeError("Portal source list does not own keyboard focus")
        send(["HOME"] + ["DOWN"] * target.get_index_in_parent() + ["SPACE"])
        current = dialog_nodes()
        selected = next((node for node in current if node.get_role_name() == "list item" and
                         node.get_name().startswith(args.title)), None)
        share = next((node for node in current if node.get_role_name() == "push button" and node.get_name() == "Share"), None)
        if not selected or not selected.get_state_set().contains(Atspi.StateType.SELECTED):
            raise RuntimeError("Keyboard did not select the owned fixture")
        if not share or not share.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Share button remains disabled")
        if args.cancel:
            share = next((node for node in current if node.get_role_name() == "push button" and node.get_name() == "Cancel"), None)
            if not share:
                raise RuntimeError("Portal Cancel button is absent")
        for _ in range(8):
            if share.get_state_set().contains(Atspi.StateType.FOCUSED):
                send(["ENTER"])
                result["passed"] = True
                return
            send(["TAB"])
        raise RuntimeError("Could not focus the requested portal button")
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
