#!/usr/bin/env python3
"""Operate the real GNOME portal picker for an owned, uniquely titled fixture.

Uses AT-SPI to identify/verify the exact dialog and normal keyboard events to
operate GTK4 rows that lack an accessible selection action. The input helper
requires access to /dev/uinput (sudo is scoped to this helper, not the app).
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time


def keyboard(keys):
    import evdev
    from evdev import ecodes as ec
    with evdev.UInput({ec.EV_KEY: list(range(1, 248))}, name="Game Capture owned QA keyboard") as device:
        time.sleep(1.5)
        for key in keys:
            code = getattr(ec, "KEY_" + key)
            device.write(ec.EV_KEY, code, 1); device.syn()
            time.sleep(0.08)
            device.write(ec.EV_KEY, code, 0); device.syn()
            time.sleep(0.15)
        time.sleep(0.3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--title")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--keys", nargs="+")
    args = parser.parse_args()
    if args.keys:
        allowed = {"HOME", "DOWN", "SPACE", "TAB", "ENTER"}
        if any(key not in allowed for key in args.keys):
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
            if app.get_name() == "xdg-desktop-portal-gnome":
                for dialog in nodes(app):
                    if dialog.get_role_name() == "frame" and dialog.get_name() == "Share Screen":
                        return list(nodes(dialog))
        return []

    result = {"title": args.title, "actions": [], "passed": False}
    def save():
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + "\n")

    def send(keys):
        result["actions"].append(keys); save()
        subprocess.run(["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "--keys", *keys], check=True, timeout=10)

    try:
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
        for _ in range(5):
            if share.get_state_set().contains(Atspi.StateType.FOCUSED):
                send(["ENTER"])
                result["passed"] = True
                return
            send(["TAB"])
        raise RuntimeError("Could not focus the portal Share button")
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        save()


if __name__ == "__main__":
    main()
