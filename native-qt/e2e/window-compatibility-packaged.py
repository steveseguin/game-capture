"""Packaged GUI -> window capture -> actual VDO.Ninja browser playback.

Default mode reparents the selected window to exercise child-window rejection.
--inject-wgc-rejection injects only CreateForWindow's E_INVALIDARG for the
selected top-level window. PrintWindow frames, encoding and playback are real.
Also covers a slow WM_PRINT handler, stop/restart, resize, source closure and
capture exclusion. Requires an interactive desktop and pywinauto/pywin32.
"""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import urllib.request
import psutil

import win32api
import win32con
import win32gui

TITLE = "Window Compatibility Moving Source"
COMMAND = win32con.WM_APP + 10


def fixture(folder):
    ctypes.windll.user32.SetProcessDPIAware()
    host = target = None

    def paint(hwnd, dc):
        rect = win32gui.GetClientRect(hwnd)
        brush = win32gui.CreateSolidBrush(win32api.RGB(0, 220, 220) if hwnd == target else win32api.RGB(255, 0, 0))
        win32gui.FillRect(dc, rect, brush)
        win32gui.DeleteObject(brush)
        if hwnd == target:
            x = int(time.monotonic() * 130) % max(1, rect[2] - 100)
            brush = win32gui.CreateSolidBrush(win32api.RGB(240, 0, 240))
            win32gui.FillRect(dc, (x, 50, x + 100, 150), brush)
            win32gui.DeleteObject(brush)
            win32gui.SetBkMode(dc, win32con.TRANSPARENT)
            win32gui.DrawText(dc, f"Selected source {time.monotonic():.2f}", -1,
                              (20, 180, rect[2], rect[3]), win32con.DT_LEFT)

    def proc(hwnd, msg, wp, lp):
        if msg == win32con.WM_PAINT:
            dc, ps = win32gui.BeginPaint(hwnd)
            paint(hwnd, dc)
            win32gui.EndPaint(hwnd, ps)
            return 0
        if msg in (win32con.WM_PRINT, win32con.WM_PRINTCLIENT):
            while (folder / "stall").exists():
                (folder / "stalled").touch()
                time.sleep(.02)
            paint(hwnd, wp)
            return 0
        if msg == win32con.WM_TIMER:
            while (folder / "stall").exists():
                (folder / "stalled").touch()
                time.sleep(.02)
            win32gui.InvalidateRect(hwnd, None, False)
            return 0
        if msg == COMMAND:
            if wp == 1:
                win32gui.SetParent(target, host)
                win32gui.SetWindowLong(target, win32con.GWL_STYLE, win32con.WS_CHILD | win32con.WS_VISIBLE)
                win32gui.SetWindowPos(target, 0, 20, 40, 640, 360, win32con.SWP_FRAMECHANGED | win32con.SWP_NOZORDER)
            elif wp == 2:
                win32gui.SetParent(target, 0)
                win32gui.SetWindowLong(target, win32con.GWL_STYLE, win32con.WS_OVERLAPPEDWINDOW | win32con.WS_VISIBLE)
            elif wp in (3, 4, 6, 7):
                if not ctypes.windll.user32.SetWindowDisplayAffinity(
                        target if wp in (6, 7) else host, 0x11 if wp in (3, 6) else 0):
                    raise ctypes.WinError()
            elif wp == 5:
                win32gui.DestroyWindow(target)
            return 0
        return win32gui.DefWindowProc(hwnd, msg, wp, lp)

    wc = win32gui.WNDCLASS()
    wc.lpszClassName = "GameCaptureCompatibilityFixture"
    wc.lpfnWndProc = proc
    wc.hInstance = win32api.GetModuleHandle(None)
    atom = win32gui.RegisterClass(wc)
    host = win32gui.CreateWindow(atom, "Compatibility host (must not be captured)",
                                win32con.WS_OVERLAPPEDWINDOW | win32con.WS_VISIBLE,
                                20, 20, 800, 500, 0, 0, wc.hInstance, None)
    target = win32gui.CreateWindow(atom, TITLE, win32con.WS_OVERLAPPEDWINDOW | win32con.WS_VISIBLE,
                                  50, 50, 640, 360, 0, 0, wc.hInstance, None)
    ctypes.windll.user32.SetTimer(target, 1, 33, None)
    (folder / "fixture.json").write_text(json.dumps({"target": target, "host": host}))
    win32gui.PumpMessages()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fixture", type=Path)
    p.add_argument("--publisher", type=Path)
    p.add_argument("--output", type=Path)
    p.add_argument("--expect-failure", action="store_true")
    player = p.add_mutually_exclusive_group()
    player.add_argument("--dvbviewer", type=Path, help="Optional extracted official DVBViewer demo executable")
    player.add_argument("--player-hwnd", type=lambda value: int(value, 0),
                   help="Attach to a prepared player window; restore it and leave it running afterward")
    p.add_argument("--media", type=Path, help="Synthetic video to open with the demo")
    p.add_argument("--normal-window", action="store_true", help="Verify the normal WGC path without reparenting")
    p.add_argument("--inject-wgc-rejection", action="store_true",
                   help="Use Frida to return E_INVALIDARG for the selected top-level HWND; real fallback/playback")
    a = p.parse_args()
    if a.fixture:
        return fixture(a.fixture)
    assert not (a.normal_window and a.inject_wgc_rejection)
    from pywinauto import Desktop
    spec = importlib.util.spec_from_file_location("desktop", Path(__file__).with_name("desktop-ui-e2e.py"))
    desktop = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(desktop)
    exe, out = a.publisher.resolve(), a.output.resolve()
    assert (exe.parent / "platforms/qwindows.dll").is_file(), "Complete package required"
    out.mkdir(parents=True, exist_ok=False)
    saved = desktop.snapshot(desktop.SETTINGS_KEY)
    children, handles = [], []
    report = {"publisher": str(exe), "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
              "passed": False, "checks": []}
    discovery = out / "control.json"
    stream = "compat" + uuid.uuid4().hex
    external_handle = 0
    external_style = 0
    external_rect = None
    external_menu = None
    injection_session = None
    injection_events = []
    protect_on, protect_off = (6, 7) if a.inject_wgc_rejection else (3, 4)
    report["wgc_rejection"] = ("none" if a.normal_window else
                               "injected-E_INVALIDARG" if a.inject_wgc_rejection else "natural-child-window")

    def launch(command, name):
        log = open(out / (name + ".log"), "w", encoding="utf-8")
        handles.append(log)
        child = subprocess.Popen(command, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW,
                                 env=dict(os.environ, LOCALAPPDATA=str(out), GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING="1"))
        children.append(child)
        return child

    def api(route, body=None):
        c = json.loads(discovery.read_text())
        req = urllib.request.Request(c["base_url"] + route,
                                     data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": "Bearer " + c["token"], "Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=5))

    def check(name, passed):
        report["checks"].append({"name": name, "passed": bool(passed)})
        print(name, bool(passed), flush=True)
        assert passed, name

    def wait(fn, timeout=12):
        desktop.wait_for(fn, "compatibility workflow", timeout=timeout)

    try:
        for group, name, value in [
            ("video", "sourceMode", "window"), ("video", "codec", "h264"),
            ("video", "encoderMode", "auto"), ("video", "alphaWorkflow", "false"),
            ("video", "packedAlpha", "false"), ("video", "alphaBackgroundMode", "none"),
            ("video", "resolution", "640x360"), ("video", "fps", "30"),
            ("audio", "source", "none"), ("audio", "includeMicrophone", "false"),
            ("audio", "codec", "opus"), ("audio", "red", "false"), ("audio", "channels", "2"),
            ("stream", "target", stream), ("stream", "password", "false"), ("stream", "room", ""),
            ("ui", "advancedVisible", "false")]:
            desktop.setting(group, name, value)
        source = launch([sys.executable, __file__, "--fixture", str(out)], "fixture")
        wait((out / "fixture.json").exists)
        f = json.loads((out / "fixture.json").read_text())
        title = TITLE
        if a.dvbviewer:
            assert a.media and a.media.is_file()
            player = launch([str(a.dvbviewer.resolve()), str(a.media.resolve())], "dvbviewer")
            title = "DVB Viewer Pro Demo"
            def find_player():
                nonlocal external_handle
                matches = Desktop(backend="win32").windows(process=player.pid, class_name="TfrmMain", visible_only=False)
                if matches:
                    external_handle = matches[0].handle
                return external_handle
            wait(find_player)
            win32gui.ShowWindow(external_handle, win32con.SW_SHOW)
            external_style = win32gui.GetWindowLong(external_handle, win32con.GWL_STYLE)
            f["target"] = external_handle
            time.sleep(2)
        elif a.player_hwnd:
            external_handle = a.player_hwnd
            assert win32gui.IsWindow(external_handle) and win32gui.IsWindowVisible(external_handle)
            assert win32gui.GetAncestor(external_handle, win32con.GA_ROOT) == external_handle
            title = win32gui.GetWindowText(external_handle)
            assert title
            external_style = win32gui.GetWindowLong(external_handle, win32con.GWL_STYLE)
            external_rect = win32gui.GetWindowRect(external_handle)
            external_menu = win32gui.GetMenu(external_handle)
            f["target"] = external_handle
        command = [str(exe), "--local-control", "--local-control-discovery=" + str(discovery)]
        if a.inject_wgc_rejection:
            import frida
            device = frida.get_local_device()
            pid = device.spawn(command, cwd=str(exe.parent),
                               env=dict(os.environ, LOCALAPPDATA=str(out), GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING="1"))
            publisher = psutil.Process(pid)
            children.append(publisher)
            injection_session = device.attach(pid)
            code = "const TARGET_HWND = " + json.dumps(hex(f["target"])) + ";\n"
            code += Path(__file__).with_name("window-capture-rejection.js").read_text()
            injection_script = injection_session.create_script(code)
            injection_script.on("message", lambda message, data: injection_events.append(message))
            injection_script.load()
            device.resume(pid)
        else:
            publisher = launch(command, "publisher")
        wait(discovery.exists)
        w = desktop.application_window(publisher.pid)
        w.maximize()
        w.set_focus()

        def button(suffix):
            nonlocal w
            w.set_focus()
            # Reparenting the fixture can invalidate Qt's UIA provider tree.
            # Rebind to the live HWND before enumerating controls again.
            w = Desktop(backend="uia").window(handle=w.handle).wrapper_object()
            matches = []
            def ready():
                nonlocal matches
                matches = [c for c in w.descendants(control_type="Button")
                           if (c.element_info.automation_id or "").endswith("." + suffix)]
                return bool(matches)
            try:
                wait(ready)
            except Exception:
                (out / "button-failure.json").write_text(json.dumps({
                    "suffix": suffix,
                    "windows": [{"title": item.window_text(), "handle": item.handle}
                                for item in Desktop(backend="uia").windows(process=publisher.pid)],
                    "controls": [{"type": item.element_info.control_type,
                                  "name": item.window_text(),
                                  "id": item.element_info.automation_id}
                                 for item in w.descendants()]
                }, indent=2))
                raise
            return matches[0]

        idle_go_rect = None
        def select_then_child(protect=False):
            nonlocal idle_go_rect
            # live=false precedes the GUI's teardown and preview refresh.
            # Wait for the user-facing controls before mutating the source.
            wait(lambda: button("refreshSourcesButton").is_enabled())
            if external_handle:
                win32gui.SetParent(external_handle, 0)
                win32gui.SetWindowLong(external_handle, win32con.GWL_STYLE, external_style)
            else:
                win32gui.SendMessage(f["host"], COMMAND, 2, 0)
            # Qt exposes only the visible list rows through UIA. Put the source
            # near the front of EnumWindows before refreshing this short list.
            win32gui.SetWindowPos(f["target"], win32con.HWND_TOP, 0, 0, 0, 0,
                                 win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE)
            button("refreshSourcesButton").invoke()
            rows = []
            w.set_focus()
            first_row = w.descendants(control_type="ListItem")[0]
            parent = first_row
            chain = []
            for _ in range(5):
                chain.append({"type": parent.element_info.control_type, "name": parent.window_text(),
                              "class": parent.element_info.class_name, "id": parent.element_info.automation_id,
                              "rect": str(parent.rectangle())})
                parent = parent.parent()
            (out / "list-accessibility.json").write_text(json.dumps(chain, indent=2))
            first_row.click_input()
            w.type_keys("{HOME}")
            def source_list_ready():
                nonlocal rows
                rows = [c for c in w.descendants(control_type="ListItem") if title in c.window_text()]
                if not rows:
                    w.type_keys("{PGDN}")
                return bool(rows)
            try:
                wait(source_list_ready)
            except Exception:
                (out / "source-list-failure.json").write_text(json.dumps({
                    "expected_title": title,
                    "fixture_title": win32gui.GetWindowText(f["target"]),
                    "fixture_visible": bool(win32gui.IsWindowVisible(f["target"])),
                    "fixture_minimized": bool(win32gui.IsIconic(f["target"])),
                    "rows": [c.window_text() for c in w.descendants(control_type="ListItem")]
                }, indent=2))
                w.capture_as_image().save(str(out / "source-list-failure.png"))
                raise
            row = rows[0]
            w.set_focus()
            row.select()
            go = button("goLiveButton")
            idle_go_rect = go.rectangle()
            check("source-selected-before-window-transition", go.is_enabled())
            w.capture_as_image().save(str(out / "before-start.png"))
            if a.normal_window or a.inject_wgc_rejection:
                pass
            elif external_handle:
                win32gui.SetParent(external_handle, f["host"])
                win32gui.SetWindowLong(external_handle, win32con.GWL_STYLE, win32con.WS_CHILD | win32con.WS_VISIBLE)
                win32gui.SetWindowPos(external_handle, 0, 20, 40, 640, 360, win32con.SWP_FRAMECHANGED | win32con.SWP_NOZORDER)
            else:
                win32gui.SendMessage(f["host"], COMMAND, 1, 0)
            if protect:
                win32gui.SendMessage(f["host"], COMMAND, protect_on, 0)
            go.invoke()

        select_then_child()
        time.sleep(3)
        logs = api("/logs/recent?lines=2000")
        (out / "initial-logs.json").write_text(json.dumps(logs, indent=2))
        raw = json.dumps(logs)
        if not a.normal_window:
            check("selected-window-rejected-by-wgc", "CreateForWindow failed with hr=0x80070057" in raw or "Invalid capture item size 0x0" in raw)
            if a.inject_wgc_rejection:
                check("exact-error-injected", any(e.get("payload", {}).get("kind") == "wgc-rejection-injected" for e in injection_events))
        else:
            check("normal-wgc-starts", "Graphics capture started successfully" in raw)
        d = api("/diagnostics")
        if a.expect_failure:
            check("capture-rejected-without-streaming", not d["app"]["live"] and not d["source"]["has_frame"])
            w.capture_as_image().save(str(out / "baseline-failure.png"))
            report["passed"] = True
            return
        check("capture-starts", d["app"]["live"] and d["source"]["has_frame"])
        check("expected-backend-selected", ("Using PrintWindow compatibility" in json.dumps(logs)) != a.normal_window)
        w.capture_as_image().save(str(out / "compatibility-live.png"))
        receiver = subprocess.run(["node", str(Path(__file__).with_name("window-compatibility-receiver.js")), stream,
                                   str(out / "receiver"), "player" if external_handle else "fixture"], capture_output=True, text=True, timeout=80)
        (out / "receiver.log").write_text(receiver.stdout + receiver.stderr)
        playback = out / "receiver/playback.json"
        if playback.exists():
            check("browser-excludes-parent", json.loads(playback.read_text())["isolationPassed"])
        check("browser-receives-moving-source-without-host", receiver.returncode == 0)
        if a.normal_window:
            button("goLiveButton").invoke()
            wait(lambda: not api("/diagnostics")["app"]["live"])
            report["passed"] = True
            return
        win32gui.SetWindowPos(f["target"], 0, 20, 40, 480, 270, win32con.SWP_NOZORDER)
        wait(lambda: api("/diagnostics")["source"]["width"] == 480)
        check("resize-delivered", api("/diagnostics")["source"]["height"] == 270)
        if external_handle:
            button("goLiveButton").invoke()
            wait(lambda: not api("/diagnostics")["app"]["live"])
            report["passed"] = True
            return
        # Block the foreign WM_PRINT call, then stop via the actual GUI.
        (out / "stall").touch()
        wait((out / "stalled").exists)
        start = time.monotonic()
        button("goLiveButton").invoke()
        wait(lambda: not api("/diagnostics")["app"]["live"])
        check("stop-does-not-wait-for-player", time.monotonic() - start < 3)
        (out / "stall").unlink()
        time.sleep(.3)
        select_then_child()
        wait(lambda: api("/diagnostics")["app"]["live"])
        check("restart-after-stall", api("/diagnostics")["source"]["has_frame"])
        win32gui.SendMessage(f["host"], COMMAND, protect_on, 0)
        wait(lambda: not api("/diagnostics")["app"]["live"])
        check("capture-exclusion-stops-existing-stream", True)
        win32gui.SendMessage(f["host"], COMMAND, protect_off, 0)
        select_then_child(protect=True)
        time.sleep(2)
        check("capture-exclusion-blocks-start", not api("/diagnostics")["app"]["live"])
        win32gui.SendMessage(f["host"], COMMAND, protect_off, 0)
        if a.inject_wgc_rejection:
            select_then_child()
            wait(lambda: api("/diagnostics")["app"]["live"])
            win32gui.SendMessage(f["host"], COMMAND, 1, 0)
            wait(lambda: not api("/diagnostics")["app"]["live"])
            check("reparented-source-stops-stream", True)
            # Qt's UIA tree disappears after this synthetic reparent transition
            # although the actual controls and event loop remain functional.
            # Exercise the visible Go Live button at its recorded idle position.
            # The selected HWND is unchanged; no source selection is necessary.
            win32gui.SendMessage(f["host"], COMMAND, 2, 0)
            time.sleep(1)
            native_window = Desktop(backend="win32").window(handle=w.handle).wrapper_object()
            native_window.set_focus()
            assert win32gui.GetForegroundWindow() == native_window.handle
            native_window.capture_as_image().save(str(out / "before-reparent-restart.png"))
            from pywinauto import mouse
            mouse.click(coords=(idle_go_rect.mid_point().x, idle_go_rect.mid_point().y))
            wait(lambda: api("/diagnostics")["app"]["live"])
            check("restart-after-reparent", api("/diagnostics")["source"]["has_frame"])
        else:
            select_then_child()
        wait(lambda: api("/diagnostics")["app"]["live"])
        win32gui.SendMessage(f["host"], COMMAND, 5, 0)
        wait(lambda: not api("/diagnostics")["app"]["live"])
        check("source-closure-stops-stream", True)
        (out / "final-diagnostics.json").write_text(json.dumps(api("/diagnostics"), indent=2))
        report["passed"] = True
    except Exception as error:
        import traceback
        report["error"] = str(error)
        (out / "failure.txt").write_text(traceback.format_exc())
        if injection_session:
            try:
                (out / "failure-threads.json").write_text(json.dumps(injection_script.exports_sync.threadstacks(), indent=2))
            except Exception:
                pass
        try:
            (out / "failure-diagnostics.json").write_text(json.dumps(api("/diagnostics"), indent=2))
        except Exception as diagnostic_error:
            report["diagnostic_error"] = str(diagnostic_error)
        try:
            w.capture_as_image().save(str(out / "failure.png"))
        except Exception:
            pass
        raise
    finally:
        (out / "stall").unlink(missing_ok=True)
        if discovery.exists():
            try:
                api("/commands", {"command": "quit"})
            except Exception:
                pass
        if external_handle and win32gui.IsWindow(external_handle):
            win32gui.SetParent(external_handle, 0)
            win32gui.SetWindowLong(external_handle, win32con.GWL_STYLE, external_style)
            if external_menu:
                win32gui.SetMenu(external_handle, external_menu)
                win32gui.DrawMenuBar(external_handle)
            if external_rect:
                left, top, right, bottom = external_rect
                win32gui.SetWindowPos(external_handle, 0, left, top, right-left, bottom-top,
                                     win32con.SWP_FRAMECHANGED | win32con.SWP_NOZORDER)
            if not a.player_hwnd:
                win32gui.PostMessage(external_handle, win32con.WM_CLOSE, 0, 0)
        for child in reversed(children):
            try:
                child.wait(timeout=3)
            except (subprocess.TimeoutExpired, psutil.TimeoutExpired):
                child.terminate()
                child.wait(timeout=5)
        if injection_session:
            try:
                injection_session.detach()
            except Exception:
                pass
            (out / "fault-injection.json").write_text(json.dumps(injection_events, indent=2))
        for handle in handles:
            handle.close()
        desktop.restore(desktop.SETTINGS_KEY, saved)
        (out / "results.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
