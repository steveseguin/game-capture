#!/usr/bin/env python3
"""Operate an explicitly identified Game Capture GUI through its AT-SPI UI."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib


def nodes(node):
    yield node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child:
            yield from nodes(child)


def pump():
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)


def action_names(node):
    interface = node.get_action_iface()
    return [interface.get_action_name(i) for i in range(interface.get_n_actions())] if interface else []


def press(node):
    if not node.get_state_set().contains(Atspi.StateType.SENSITIVE):
        raise RuntimeError("Control is disabled: " + node.get_name())
    component = node.get_component_iface()
    if component:
        component.grab_focus()
    interface = node.get_action_iface()
    names = [name.casefold() for name in action_names(node)]
    for name in ["press", "click", "toggle", "showmenu"]:
        if name in names and interface.do_action(names.index(name)):
            time.sleep(.15)
            pump()
            return
    raise RuntimeError("No usable accessible action: " + node.get_name() + " " + str(names))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pid", type=int)
    parser.add_argument("command", choices=["dump", "press", "choose", "choose-prefix", "text", "read-text", "reveal", "menu", "value", "source"])
    parser.add_argument("name", nargs="?")
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    if Path(f"/proc/{args.pid}/exe").resolve().name != "game-capture":
        raise RuntimeError("PID is not the requested Game Capture application")
    deadline = time.monotonic() + 5
    app = None
    while time.monotonic() < deadline:
        pump()
        desktop = Atspi.get_desktop(0)
        app = next((desktop.get_child_at_index(i) for i in range(desktop.get_child_count())
                    if desktop.get_child_at_index(i).get_process_id() == args.pid), None)
        if app:
            break
        time.sleep(.1)
    if app is None:
        raise RuntimeError("Application is absent from AT-SPI")
    if args.command != "dump" and os.environ.get("QT_QPA_PLATFORM") == "xcb":
        focus = subprocess.run(["xdotool", "getwindowfocus", "getwindowpid"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
        # Preserve focus in owned menus/dialogs. Refocusing the main window can
        # dismiss a menu, and Qt popups can inherit the main window's title.
        if focus.returncode or focus.stdout.strip() != str(args.pid):
            windows = subprocess.check_output(["xdotool", "search", "--onlyvisible", "--pid", str(args.pid),
                                               "--name", "^Game Capture - Powered by VDO.Ninja$"], text=True, timeout=3).split()
            if len(windows) != 1:
                raise RuntimeError("Expected one owned Game Capture main window")
            subprocess.run(["xdotool", "windowfocus", "--sync", windows[0]], check=True, timeout=3)

    def find(role, name):
        pump()
        matches = [node for node in nodes(app) if node.get_role_name() == role and node.get_name() == name]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one {role} named {name!r}; found {len(matches)}")
        return matches[0]

    if args.command == "dump":
        print(json.dumps([{"role": node.get_role_name(), "name": node.get_name(),
                           "actions": action_names(node),
                           "value": node.get_value_iface().get_current_value() if node.get_role_name() == "spin button" else None,
                           "states": [str(state.value_nick) for state in node.get_state_set().get_states()]}
                          for node in nodes(app)], indent=2))
    elif args.command in ["choose", "choose-prefix"]:
        combo = find("combo box", args.name)
        press(combo)
        rows = [node for node in nodes(combo) if node.get_role_name() == "list item"]
        choices = [node for node in rows if (node.get_name().startswith(args.value) if args.command == "choose-prefix" else node.get_name() == args.value)]
        if len(choices) != 1:
            raise RuntimeError("Requested combo choice is absent or ambiguous")
        # Qt's generic accessible list-item action selects a popup row without
        # activating the QComboBox. In the X11 GUI fixture use normal keyboard
        # selection, after confirming the focused window belongs to this app.
        if os.environ.get("QT_QPA_PLATFORM") != "xcb":
            raise RuntimeError("Keyboard combo fixture requires the X11 Qt backend")
        owner = subprocess.check_output(["xdotool", "getwindowfocus", "getwindowpid"], text=True, timeout=3).strip()
        if owner != str(args.pid):
            raise RuntimeError("Owned application does not hold keyboard focus")
        selected = choices[0].get_name()
        subprocess.run(["xdotool", "key", "--clearmodifiers", "Home", *(["Down"] * rows.index(choices[0])), "Return"], check=True, timeout=3)
        time.sleep(.25); pump()
        if not any(node.get_role_name() == "combo box" and node.get_name() == selected for node in nodes(app)):
            raise RuntimeError("Combo did not select the requested value")
    elif args.command in ["text", "read-text", "reveal"]:
        matches = [node for node in nodes(app) if node.get_role_name() in ["text", "password text"] and node.get_name() == args.name]
        if len(matches) != 1:
            raise RuntimeError("Text control is absent or ambiguous")
        field = matches[0]
        if args.command == "reveal":
            buttons = [node for node in nodes(field.get_parent()) if node.get_role_name() in ["push button", "toggle button", "check box"] and node.get_name() in ["Show", "Hide"]]
            if len(buttons) != 1:
                raise RuntimeError("Expected one credential reveal button in " + field.get_parent().get_role_name() + "; found " + str(len(buttons)))
            press(buttons[0])
        elif args.command == "read-text":
            print(json.dumps(Atspi.Text.get_text(field.get_text_iface(), 0, -1)))
        elif not field.get_editable_text_iface().set_text_contents(args.value):
            raise RuntimeError("Could not edit text control")
    elif args.command == "menu":
        matches = [node for node in nodes(app) if node.get_role_name() in ["menu", "menu item"] and node.get_name() == args.name]
        if len(matches) != 1:
            raise RuntimeError("Menu item is absent or ambiguous")
        item = matches[0]
        if 'showmenu' in [name.casefold() for name in action_names(item)]:
            press(item)
        else:
            # QAction's synchronous AT-SPI action can wait inside a modal
            # dialog. Click the confirmed owned menu item normally instead.
            if os.environ.get('QT_QPA_PLATFORM') != 'xcb':
                raise RuntimeError('Menu click fixture requires X11')
            bounds = item.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            if bounds.width <= 0 or bounds.height <= 0 or not item.get_state_set().contains(Atspi.StateType.SHOWING):
                raise RuntimeError('Menu item is not visible')
            owner = subprocess.check_output(['xdotool', 'getwindowfocus', 'getwindowpid'], text=True, timeout=3).strip()
            if owner != str(args.pid):
                raise RuntimeError('Owned menu does not hold focus')
            subprocess.run(['xdotool', 'mousemove', str(bounds.x + bounds.width//2), str(bounds.y + bounds.height//2), 'click', '1'], check=True, timeout=3)
            time.sleep(.2)
    elif args.command == "value":
        field = find("spin button", args.name)
        value = float(args.value)
        if not field.get_value_iface().set_current_value(value) or abs(field.get_value_iface().get_current_value() - value) > .0001:
            raise RuntimeError("Numeric control rejected value")
    elif args.command == "source":
        container = find("list", "Available capture sources")
        choices = [node for node in nodes(container) if node.get_role_name() == "list item" and args.name in node.get_name()]
        if len(choices) != 1:
            raise RuntimeError("Owned source is absent or ambiguous")
        press(choices[0])
        if not choices[0].get_state_set().contains(Atspi.StateType.SELECTED):
            raise RuntimeError("Source did not become selected")
    else:
        candidates = [node for node in nodes(app) if node.get_role_name() in ["push button", "check box"] and node.get_name() == args.name]
        if len(candidates) != 1:
            raise RuntimeError("Control is absent or ambiguous: " + str(args.name))
        press(candidates[0])


if __name__ == "__main__":
    main()
