#!/usr/bin/env python3
"""Operate an explicitly identified Game Capture GUI through its AT-SPI UI."""
import argparse
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
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
    parser.add_argument("command", choices=["dump", "press", "key-press", "choose", "choose-prefix", "text", "read-text", "reveal", "menu", "value", "source", "preview", "activate", "quit-menu", "move-monitor-right", "footer", "deny-camera-start", "close-window", "paste", "copy"])
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
        # The GTK platform theme can register an empty GTK application root
        # before Qt registers the actual widget tree, both with the same PID.
        # Select the toolkit, including when its main window is hidden to tray.
        candidates = [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
        candidates = [node for node in candidates if node is not None and
                      node.get_process_id() == args.pid and node.get_toolkit_name() == "Qt"]
        if len(candidates) > 1:
            raise RuntimeError("Multiple Qt accessibility roots for the requested application")
        if candidates:
            app = candidates[0]
            break
        time.sleep(.1)
    if app is None:
        raise RuntimeError("Qt application is absent from AT-SPI")
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

    def geometry(node):
        if node.get_role_name() not in ["filler", "frame", "combo box", "scroll bar"]:
            return None
        rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        return [rect.x, rect.y, rect.width, rect.height]

    if args.command == "dump":
        print(json.dumps([{"role": node.get_role_name(), "name": node.get_name(),
                           "actions": action_names(node),
                           "value": node.get_value_iface().get_current_value() if node.get_role_name() in ["spin button", "scroll bar"] else None,
                           "bounds": geometry(node),
                           "states": [str(state.value_nick) for state in node.get_state_set().get_states()]}
                          for node in nodes(app)], indent=2))
    elif args.command == "quit-menu":
        frame = find("frame", "Game Capture - Powered by VDO.Ninja")
        assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), "Owned application is not active"
        def send_menu_keys(values):
            if os.environ.get("QT_QPA_PLATFORM") == "xcb":
                subprocess.run(['xdotool', 'key', '--clearmodifiers', *values], check=True, timeout=3)
            else:
                assert os.environ.get('GC_QA_KEYBOARD_SOCKET'), 'Owned keyboard is required'
                subprocess.run([sys.executable, str(Path(__file__).with_name('linux-portal-select.py')), '--keys', *[v.upper() for v in values]], check=True, timeout=8)
            time.sleep(.15); pump()
        menus = [n for n in nodes(app) if n.get_role_name() in ['menu', 'menu item'] and n.get_name() == 'File']
        assert len(menus) == 1
        if os.environ.get('QT_QPA_PLATFORM') == 'xcb':
            press(menus[0])
        else:
            send_menu_keys(['ALT_F'])
        send_menu_keys(['Up'])
        item = find('menu item', 'Quit')
        states = item.get_state_set()
        assert states.contains(Atspi.StateType.SHOWING) and states.contains(Atspi.StateType.FOCUSED), 'Owned Quit item is not focused: '+str([(n.get_name(),[str(x.value_nick) for x in n.get_state_set().get_states()]) for n in nodes(app) if n.get_role_name() in ['menu','menu item']])
        started = int(time.time()*1000)
        send_menu_keys(['Return'] if os.environ.get("QT_QPA_PLATFORM") == "xcb" else ['ENTER'])
        print(json.dumps({'action':'File menu Quit', 'actionStartedAtMs':started}))
    elif args.command == "move-monitor-right":
        assert os.environ.get('QT_QPA_PLATFORM') == 'wayland' and os.environ.get('GC_QA_KEYBOARD_SOCKET')
        frame = find('frame', 'Game Capture - Powered by VDO.Ninja')
        assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), 'Owned application is not active'
        before = geometry(frame)
        subprocess.run([sys.executable, str(Path(__file__).with_name('linux-portal-select.py')), '--keys', 'SUPER_SHIFT_RIGHT'], check=True, timeout=8)
        time.sleep(.3);pump()
        assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), 'Owned application lost focus'
        print(json.dumps({'before':before,'after':geometry(frame)}))
    elif args.command == "close-window":
        frame = find("frame", "Game Capture - Powered by VDO.Ninja")
        assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), "Owned application is not active"
        if os.environ.get("QT_QPA_PLATFORM") == "xcb":
            subprocess.run(['xdotool', 'key', '--clearmodifiers', 'alt+F4'], check=True, timeout=3)
        else:
            assert os.environ.get('GC_QA_KEYBOARD_SOCKET'), 'Owned keyboard is required'
            subprocess.run([sys.executable, str(Path(__file__).with_name('linux-portal-select.py')), '--keys', 'ALT_F4'], check=True, timeout=8)
    elif args.command == "activate":
        frame = find("frame", "Game Capture - Powered by VDO.Ninja")
        if not frame.get_state_set().contains(Atspi.StateType.ACTIVE):
            if os.environ.get("QT_QPA_PLATFORM") != "wayland" or not os.environ.get("GC_QA_KEYBOARD_SOCKET"):
                raise RuntimeError("Owned window did not receive focus")
            keyboard = Path(__file__).with_name('linux-portal-select.py')
            # The replacement source is the most recently activated window.
            # Return once via the desktop switcher, then verify the exact PID.
            subprocess.run([sys.executable, str(keyboard), '--keys', 'ALT_TAB'], check=True, timeout=8)
            time.sleep(.5); pump()
            if not frame.get_state_set().contains(Atspi.StateType.ACTIVE):
                raise RuntimeError("Desktop switcher did not activate the owned application")
    elif args.command == "deny-camera-start":
        # Revoke only the owned QA alias immediately before the real UI action;
        # avoid spawning another observer while the source-refresh timer runs.
        alias = Path(args.name)
        assert alias.name == 'private-camera-device' and not alias.is_symlink()
        info = alias.stat()
        assert stat.S_ISCHR(info.st_mode) and info.st_uid == os.getuid()
        assert stat.S_IMODE(info.st_mode) == 0o600
        assert stat.S_IMODE(alias.parent.stat().st_mode) == 0o700
        assert args.value.startswith('/dev/video')
        mapped = Path(f'/proc/{args.pid}/root{args.value}').stat()
        assert (mapped.st_dev,mapped.st_ino,mapped.st_rdev) == (info.st_dev,info.st_ino,info.st_rdev)
        assert os.readlink(f'/proc/{args.pid}/ns/mnt') != os.readlink('/proc/self/ns/mnt')
        button = find('push button', 'Go live')
        assert button.get_state_set().contains(Atspi.StateType.SENSITIVE)
        alias.chmod(0)
        press(button)
    elif args.command == "footer":
        for node in nodes(app):
            if node.get_role_name() == 'scroll bar':
                rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
                if rect.height > rect.width:
                    value = node.get_value_iface()
                    assert value.set_current_value(value.get_maximum_value()), 'Could not reveal footer'
        time.sleep(.3);pump()
        frame = find('frame', 'Game Capture - Powered by VDO.Ninja')
        assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), 'Owned application is not active'
        bounds = geometry(frame)
        def visible(node):
            rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            assert node.get_state_set().contains(Atspi.StateType.SHOWING)
            assert rect.width > 0 and rect.height > 0
            assert bounds[0] <= rect.x and bounds[1] <= rect.y
            assert rect.x+rect.width <= bounds[0]+bounds[2] and rect.y+rect.height <= bounds[1]+bounds[3], 'Footer control is clipped'
            return [rect.x,rect.y,rect.width,rect.height]
        buttons = [n for n in nodes(app) if n.get_role_name() == 'push button' and n.get_name() in ['Go live', 'Go live unavailable']]
        assert len(buttons) == 1, 'Expected one startup control'
        button = buttons[0]
        result = {'frame':bounds,'goLiveBounds':visible(button),'goLiveEnabled':button.get_state_set().contains(Atspi.StateType.SENSITIVE),'goLiveName':button.get_name()}
        if args.name:
            label = find('label', args.name)
            result.update(message=label.get_name(),messageBounds=visible(label))
        print(json.dumps(result))
    elif args.command == "preview":
        for node in nodes(app):
            if node.get_role_name() == "scroll bar":
                rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
                if rect.height > rect.width:
                    value = node.get_value_iface()
                    if not value.set_current_value(value.get_minimum_value()):
                        raise RuntimeError("Could not reveal preview")
        time.sleep(.3); pump()
        matches = [node for node in nodes(app) if node.get_name() == "Selected source preview"]
        if len(matches) != 1:
            raise RuntimeError("Selected preview is absent or ambiguous")
        preview = matches[0]
        frame = find("frame", "Game Capture - Powered by VDO.Ninja")
        if not frame.get_state_set().contains(Atspi.StateType.ACTIVE):
            raise RuntimeError("Owned application is not active")
        interface = preview.get_text_iface()
        rect = preview.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        print(json.dumps({"role": preview.get_role_name(), "description": preview.get_description(), "text": Atspi.Text.get_text(interface, 0, -1) if interface else "",
                          "frame": geometry(frame), "preview": [rect.x,rect.y,rect.width,rect.height]}))
    elif args.command in ["choose", "choose-prefix"]:
        combo = find("combo box", args.name)
        if os.environ.get("QT_QPA_PLATFORM") != "wayland":
            press(combo)
        rows = [node for node in nodes(combo) if node.get_role_name() == "list item"]
        choices = [node for node in rows if (node.get_name().startswith(args.value) if args.command == "choose-prefix" else node.get_name() == args.value)]
        if len(choices) != 1:
            raise RuntimeError("Requested combo choice is absent or ambiguous")
        # Qt's generic list-item action selects without activating QComboBox.
        # Use normal keys only after verifying focus in this owned application.
        selected = choices[0].get_name()
        if os.environ.get("QT_QPA_PLATFORM") == "xcb":
            owner = subprocess.check_output(["xdotool", "getwindowfocus", "getwindowpid"], text=True, timeout=3).strip()
            if owner != str(args.pid):
                raise RuntimeError("Owned application does not hold keyboard focus")
            subprocess.run(["xdotool", "key", "--clearmodifiers", "Home", *(["Down"] * rows.index(choices[0])), "Return"], check=True, timeout=3)
        elif os.environ.get("QT_QPA_PLATFORM") == "wayland":
            if not os.environ.get('GC_QA_KEYBOARD_SOCKET'):
                raise RuntimeError('Wayland GUI requires the owned persistent keyboard fixture')
            keyboard = Path(__file__).with_name('linux-portal-select.py')
            def send(keys):
                if not any(n.get_role_name() == 'frame' and n.get_state_set().contains(Atspi.StateType.ACTIVE) for n in nodes(app)):
                    raise RuntimeError('Owned application is not active')
                subprocess.run([sys.executable, str(keyboard), '--keys', *keys], check=True, timeout=8)
                pump()
            # Qt 6.4's AT-SPI component grab_focus returns false. Hidden list
            # rows also retain FOCUSED, so only the combo itself proves focus.
            # Normal Tab navigation focuses and scrolls the actual widget.
            for _ in range(80):
                if combo.get_state_set().contains(Atspi.StateType.FOCUSED):
                    break
                send(['TAB'])
            else:
                raise RuntimeError('Could not focus the owned combo with Tab')
            fields = [n for n in nodes(combo) if n.get_role_name() == 'text' and n.get_editable_text_iface()]
            if len(fields) == 1:
                assert fields[0].get_editable_text_iface().set_text_contents(selected)
                send(['TAB'])
            else:
                send(['HOME'] + ['DOWN'] * rows.index(choices[0]))

        else:
            raise RuntimeError("Unsupported desktop for keyboard combo fixture")
        time.sleep(.25); pump()
        if not any(node.get_role_name() == "combo box" and node.get_name() == selected for node in nodes(app)):
            raise RuntimeError("Combo did not select the requested value; combo names=" + repr([node.get_name() for node in nodes(app) if node.get_role_name() == "combo box"]) + "; rows=" + repr([node.get_name() for node in rows]))
    elif args.command in ["text", "read-text", "reveal", "paste", "copy"]:
        matches = [node for node in nodes(app) if node.get_role_name() in ["text", "password text"] and node.get_name() == args.name]
        if len(matches) != 1:
            raise RuntimeError("Text control is absent or ambiguous")
        field = matches[0]
        if args.command in ["paste", "copy"]:
            assert field.get_state_set().contains(Atspi.StateType.SENSITIVE), "Paste target is disabled"
            keyboard = Path(__file__).with_name('linux-portal-select.py')
            def send(values):
                frame = find("frame", "Game Capture - Powered by VDO.Ninja")
                assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), "Owned application is not active"
                subprocess.run([sys.executable, str(keyboard), '--keys', *values], check=True, timeout=8)
                pump()
            assert os.environ.get('GC_QA_KEYBOARD_SOCKET'), 'Owned keyboard is required'
            for _ in range(80):
                if field.get_state_set().contains(Atspi.StateType.FOCUSED):
                    break
                send(['TAB'])
            else:
                raise RuntimeError('Could not focus the owned paste target')
            send(['CTRL_A', 'CTRL_C' if args.command == 'copy' else 'CTRL_V'])
            time.sleep(.5); pump()
            print(json.dumps(Atspi.Text.get_text(field.get_text_iface(), 0, -1)))
        elif args.command == "reveal":
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
    elif args.command == "key-press":
        button = find("push button", args.name)
        frame = find("frame", "Game Capture - Powered by VDO.Ninja")
        def send(key):
            assert frame.get_state_set().contains(Atspi.StateType.ACTIVE), 'Owned application is not active'
            if os.environ.get('QT_QPA_PLATFORM') == 'wayland':
                assert os.environ.get('GC_QA_KEYBOARD_SOCKET'), 'Owned keyboard is required'
                subprocess.run([sys.executable, str(Path(__file__).with_name('linux-portal-select.py')), '--keys', key], check=True, timeout=8)
            else:
                subprocess.run(['xdotool', 'key', '--clearmodifiers', {'TAB':'Tab','SPACE':'space'}[key]], check=True, timeout=3)
            pump()
        # Normal keyboard activation supplies the compositor's input serial;
        # an AT-SPI do_action alone does not generate a Wayland input event.
        for _ in range(80):
            if button.get_state_set().contains(Atspi.StateType.FOCUSED):
                break
            send('TAB')
        else:
            raise RuntimeError('Could not focus the owned button with Tab')
        assert button.get_state_set().contains(Atspi.StateType.SENSITIVE), 'Owned button is disabled'
        send('SPACE')
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
