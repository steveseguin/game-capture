"""Exercise the packaged Windows GUI and observe OS side effects without muting them."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid
import urllib.request
import winreg


SOURCE_TITLE = "Game Capture Desktop Workflow Source"
SETTINGS_KEY = r"Software\VDO.Ninja\Game Capture"


def source_window():
    import tkinter
    root = tkinter.Tk()
    root.title(SOURCE_TITLE)
    root.geometry("640x360+10+10")
    label = tkinter.Label(root, font=("Arial", 22))
    label.pack()
    def tick():
        label.config(text="Desktop workflow source\n" + str(time.monotonic()))
        root.after(100, tick)
    tick()
    root.mainloop()


def snapshot(path):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            children, values, _ = winreg.QueryInfoKey(key)
            return {
                "values": [winreg.EnumValue(key, i) for i in range(values)],
                "children": {winreg.EnumKey(key, i): snapshot(path + "\\" + winreg.EnumKey(key, i))
                             for i in range(children)},
            }
    except FileNotFoundError:
        return {}


def restore(path, saved):
    current = snapshot(path)
    if not current and not saved:
        return
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, path) as key:
        expected = {v[0] for v in saved.get("values", [])}
        for name, _, _ in current.get("values", []):
            if name not in expected:
                winreg.DeleteValue(key, name)
        for name, value, kind in saved.get("values", []):
            winreg.SetValueEx(key, name, 0, kind, value)
    for name in set(current.get("children", {})) | set(saved.get("children", {})):
        restore(path + "\\" + name, saved.get("children", {}).get(name, {}))
    if not saved:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)


def setting(group, name, value):
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, SETTINGS_KEY + "\\" + group) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)


def wait_for(predicate, description, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.1)
    raise AssertionError("Timed out: " + description)


OBSERVER = r"""
const hooked = new Set();
Process.attachModuleObserver({ onAdded(module) {
    for (const name of ['PlaySoundW', 'PlaySoundA', 'MessageBeep', 'Beep']) {
        const addr = module.findExportByName(name);
        if (!addr || hooked.has(addr.toString())) continue;
        hooked.add(addr.toString());
        Interceptor.attach(addr, { onEnter(args) {
            let sound = null;
            if (name.startsWith('PlaySound') && args[0].compare(ptr(65535)) > 0) {
                try { sound = name.endsWith('W') ? args[0].readUtf16String() : args[0].readUtf8String(); } catch (_) {}
            }
            send({kind:'sound', api:name, sound:sound});
        }});
        send({kind:'hook', api:name});
    }
    if (module.name.toLowerCase() === 'shell32.dll') {
        Interceptor.attach(module.getExportByName('Shell_NotifyIconW'), { onEnter(args) {
            const data = args[1];
            if (data.readU32() < 952) return;
            if (args[0].toUInt32() === 0) {
                send({kind:'tray_handle', hwnd:data.add(8).readPointer().toString(),
                      callback:data.add(24).readU32(), id:data.add(16).readU32()});
            }
            if (data.add(20).readU32() & 0x10) {
                send({kind:'tray', message:data.add(304).readUtf16String(), flags:data.add(948).readU32()});
            }
        }});
    }
    if (module.name.toLowerCase() === 'qt6gui.dll') {
        const exp = module.enumerateExports().find(e => e.name.includes('updateAccessibility@QAccessible'));
        if (!exp) throw Error('Qt accessibility observer could not attach');
        Interceptor.attach(exp.address, { onEnter(args) {
            const type = args[0].add(Process.pointerSize).readU32();
            if (type === 2 || type === 0x80d0) send({kind:'accessibility', event:type});
        }});
        send({kind:'hook', api:'QAccessible::updateAccessibility'});
    }
}});
"""


def main():
    import frida
    import win32api
    import win32con
    import win32event
    import win32process
    from pywinauto import Application
    from pywinauto.keyboard import send_keys

    parser = argparse.ArgumentParser()
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--probe-helper", required=True)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    exe = Path(args.publisher).resolve(strict=True)
    helper = Path(args.probe_helper).resolve(strict=True)
    if not (exe.parent / "platforms/qwindows.dll").is_file():
        raise RuntimeError("A complete Windows package is required")
    run_dir = Path(args.report_dir).resolve() / str(uuid.uuid4())
    run_dir.mkdir(parents=True)
    device = frida.get_local_device()
    if any(p.name.lower() == "game-capture.exe" for p in device.enumerate_processes()):
        raise RuntimeError("Close existing Game Capture sessions before the desktop workflow")
    saved = snapshot(SETTINGS_KEY)
    events, checks = [], []
    phase = "startup"
    pid = None
    source = None
    failure = None
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
                                        wintypes.LPARAM, wintypes.UINT, wintypes.UINT,
                                        ctypes.POINTER(ctypes.c_size_t)]
    user32.SendMessageTimeoutW.restype = wintypes.LPARAM
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    stop_monitor = threading.Event()
    monitor_thread = None
    samples = []

    def check(name, passed, detail=None):
        checks.append({"name": name, "passed": bool(passed), "detail": detail})
        print(("PASS " if passed else "FAIL ") + name, flush=True)
        if not passed:
            raise AssertionError(name + (": " + str(detail) if detail else ""))

    try:
        for group, name, value in [("video", "sourceMode", "window"), ("video", "codec", "h264"),
                                   ("video", "encoderMode", "auto"), ("video", "alphaWorkflow", "false"),
                                   ("video", "resolution", "960x540"), ("video", "fps", "30"),
                                   ("video", "ffmpegPath", ""), ("audio", "source", "none"),
                                   ("audio", "includeMicrophone", "false"), ("ui", "advancedVisible", "false"),
                                   ("stream", "target", "desktop-ui-" + run_dir.name),
                                   ("stream", "room", ""), ("stream", "password", "false"),
                                   ("ui", "minimizeToTrayOnClose", "true")]:
            setting(group, name, value)
        source = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--source-window"],
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        time.sleep(1)
        env = dict(os.environ, GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING="1", LOCALAPPDATA=str(run_dir))
        env.pop("QT_QPA_PLATFORM", None)
        discovery = run_dir / "local-control.json"
        pid = device.spawn([str(exe), "--local-control", "--local-control-discovery=" + str(discovery)],
                           cwd=str(exe.parent), env=env)
        session = device.attach(pid)
        script = session.create_script(OBSERVER)
        def on_message(message, data):
            events.append({"phase": phase, "time": time.time(), **message.get("payload", message)})
        script.on("message", on_message)
        script.load()
        device.resume(pid)
        app = Application(backend="uia").connect(process=pid, timeout=20)
        window = app.window(title="Game Capture - Powered by VDO.Ninja")
        window.wait("visible", timeout=20)
        window.maximize()
        window.set_focus()
        hwnd = window.handle
        time.sleep(1)

        def named(suffix):
            return next(c for c in window.descendants() if c.element_info.automation_id.endswith("." + suffix))

        def status():
            return named("statusLabel").window_text()

        def ffmpeg_status():
            return named("ffmpegStatusLabel").window_text()

        check("sound-observers-attached", {"PlaySoundW", "MessageBeep", "Beep", "QAccessible::updateAccessibility"}
              <= {e.get("api") for e in events if e.get("kind") == "hook"})
        phase = "source-selection"
        combo = named("sourceModeSelect")
        combo.click_input()
        send_keys("{END}{ENTER}", pause=.05)
        wait_for(lambda: "Spout2" in status(), "Spout source status")
        combo.click_input()
        send_keys("{HOME}{ENTER}", pause=.05)
        wait_for(lambda: status() == "Select a window to capture", "window source status")
        item = window.child_window(title_re=SOURCE_TITLE + ".*", control_type="ListItem")
        item.click_input()
        wait_for(lambda: status() == "Ready to go live", "selected window status")
        check("source-selection-enables-start", named("goLiveButton").is_enabled())
        named("refreshSourcesButton").click_input()
        check("refresh-preserves-selection", status() == "Ready to go live")

        phase = "ffmpeg-timeout"
        named("advancedToggle").click_input()
        window.wheel_mouse_input(coords=(window.rectangle().width() - 25, 150), wheel_dist=-25)
        time.sleep(.5)
        codec = named("codecSelect")
        codec.click_input()
        send_keys("{HOME}{DOWN}{DOWN}{ENTER}", pause=.05)
        wait_for(lambda: "AV1" in codec.selected_text(), "AV1 codec selection")
        check("av1-selected", "AV1" in codec.selected_text(), codec.selected_text())
        wait_for(lambda: not ffmpeg_status().startswith("Checking"), "initial FFmpeg probe")
        field = named("ffmpegPathInput")

        def monitor():
            while not stop_monitor.is_set():
                value = ctypes.c_size_t()
                started = time.perf_counter()
                ok = user32.SendMessageTimeoutW(hwnd, 0, 0, 0, 2, 250, ctypes.byref(value))
                samples.append({"phase": phase, "responsive": bool(ok),
                                "elapsedMs": (time.perf_counter() - started) * 1000})
                stop_monitor.wait(.05)

        monitor_thread = threading.Thread(target=monitor)
        monitor_thread.start()
        started = time.perf_counter()
        field.set_edit_text(str(helper))
        check("path-edit-does-not-wait-for-probe", time.perf_counter() - started < 1.5)
        time.sleep(.5)
        control = json.loads(discovery.read_text(encoding="utf-8-sig"))
        request = urllib.request.Request(control["base_url"] + "/diagnostics",
                                         headers={"Authorization": "Bearer " + control["token"]})
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=8) as response:
            json.loads(response.read())
        check("diagnostics-do-not-wait-for-settings-probe", time.perf_counter() - started < 1.5)
        wait_for(lambda: "timed out" in ffmpeg_status(), "FFmpeg timeout displayed")
        check("failed-probe-is-not-presented-as-usable", "Using" not in ffmpeg_status())

        phase = "ffmpeg-failed-start"
        # The startup preflight must also remain responsive and report the error.
        named("goLiveButton").invoke()
        wait_for(lambda: "timed out" in status(), "startup failure status")
        wait_for(lambda: named("goLiveButton").is_enabled(), "start controls restored")
        check("failed-start-restores-editing", named("ffmpegPathInput").is_enabled())

        phase = "ffmpeg-stale-result"
        field.set_edit_text("")
        wait_for(lambda: "Using" in ffmpeg_status(), "bundled FFmpeg restored")
        # A different executable path avoids the previous probe's cache entry.
        import shutil
        second_helper = run_dir / "slow-ffmpeg.exe"
        shutil.copy2(helper, second_helper)
        field.set_edit_text(str(second_helper))
        time.sleep(.5)
        field.set_edit_text("")
        wait_for(lambda: "Using" in ffmpeg_status(), "new path wins over old probe")
        check("stale-timeout-does-not-replace-current-result", "timed out" not in ffmpeg_status()
              and str(second_helper) not in ffmpeg_status())

        phase = "ffmpeg-no-longer-needed"
        third_helper = run_dir / "slow-ffmpeg-two.exe"
        shutil.copy2(helper, third_helper)
        field.set_edit_text(str(third_helper))
        time.sleep(.5)
        codec.click_input()
        send_keys("{HOME}{ENTER}", pause=.05)
        wait_for(lambda: "H.264" in codec.selected_text(), "return to H.264")
        time.sleep(3.5)
        check("unused-probe-cannot-overwrite-h264-status", ffmpeg_status().startswith("Needed for"))
        stop_monitor.set()
        monitor_thread.join(timeout=2)
        streak = maximum = 0
        for sample in samples:
            streak = 0 if sample["responsive"] else streak + 1
            maximum = max(maximum, streak)
        check("window-responsive-during-probes-and-startup", maximum < 2, {"maxConsecutiveTimeouts": maximum})

        phase = "gui-streaming"
        codec.click_input()
        send_keys("{END}{ENTER}", pause=.05)
        wait_for(lambda: "VP9" in codec.selected_text(), "VP9 before clearing path")
        field.set_edit_text("")
        # Exercise both the ordinary startup and successful external-FFmpeg
        # preflight through the GUI, with actual browser decoding at each stop.
        stream_id = "desktop-ui-" + run_dir.name
        for selected_codec, keys in [("H.264", "{HOME}{ENTER}"), ("VP9", "{END}{ENTER}")]:
            codec.click_input()
            send_keys(keys, pause=.05)
            wait_for(lambda: selected_codec in codec.selected_text(), selected_codec + " selected")
            if selected_codec == "VP9":
                wait_for(lambda: "Using" in ffmpeg_status(), "working FFmpeg before start")
            named("goLiveButton").invoke()
            wait_for(lambda: status().startswith("LIVE"), selected_codec + " live", timeout=30)
            viewer = subprocess.run(["node", str(Path(__file__).with_name("desktop-ui-viewer.js")),
                                     stream_id, str(run_dir / selected_codec.replace(".", ""))],
                                    capture_output=True, text=True, timeout=85,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            print(viewer.stdout, flush=True)
            check(selected_codec + "-gui-start-decodes-in-browser", viewer.returncode == 0, viewer.stderr)
            named("goLiveButton").invoke()
            wait_for(lambda: status() == "Stopped"
                     and named("goLiveButton").is_enabled(), selected_codec + " stopped", timeout=20)
            check(selected_codec + "-gui-stop-restores-settings", codec.is_enabled())

        phase = "background-source-disappears"
        window.wheel_mouse_input(coords=(window.rectangle().width() - 25, 150), wheel_dist=30)
        source.terminate()
        source.wait(timeout=5)
        wait_for(lambda: status() == "Select a window to capture", "automatic source removal")
        check("source-removal-disables-start", not named("goLiveButton").is_enabled())
        time.sleep(4)
        check("ordinary-workflows-request-no-sounds", not any(e.get("kind") == "sound" for e in events))
        check("ordinary-workflows-request-no-system-alerts", not any(e.get("event") == 2 for e in events))
        check("status-accessibility-announcements-preserved", any(e.get("event") == 0x80d0 for e in events))

        phase = "close-to-tray"
        tray = next(e for e in events if e.get("kind") == "tray_handle")
        for _ in range(2):
            window.close()
            wait_for(lambda: not user32.IsWindowVisible(hwnd), "window hides to tray")
            # Deliver the same shell notification as activating this tray icon.
            user32.PostMessageW(int(tray["hwnd"], 16), tray["callback"], 0, (tray["id"] << 16) | 0x400)
            wait_for(lambda: bool(user32.IsWindowVisible(hwnd)), "tray activation restores window")
        reminders = [e for e in events if e.get("kind") == "tray" and "Still running" in e.get("message", "")]
        check("tray-reminder-once-per-session", len(reminders) == 1, len(reminders))
        check("observer-had-no-errors", not any(e.get("type") == "error" for e in events))

        phase = "quit-during-probe"
        window.wheel_mouse_input(coords=(window.rectangle().width() - 25, 150), wheel_dist=-25)
        time.sleep(.5)
        codec.click_input()
        send_keys("{HOME}{DOWN}{DOWN}{ENTER}", pause=.05)
        wait_for(lambda: "AV1" in codec.selected_text(), "AV1 before quit")
        last_helper = run_dir / "slow-ffmpeg-on-quit.exe"
        shutil.copy2(helper, last_helper)
        named("ffmpegPathInput").set_edit_text(str(last_helper))
        time.sleep(.5)
        process_handle = win32api.OpenProcess(win32con.SYNCHRONIZE | win32con.PROCESS_QUERY_INFORMATION, False, pid)
        try:
            window.set_focus()
            window.menu_select("File->Quit")
            exited = win32event.WaitForSingleObject(process_handle, 8000) == win32con.WAIT_OBJECT_0
            exit_code = win32process.GetExitCodeProcess(process_handle)
            check("quit-during-probe-finishes-without-crash", exited and exit_code == 0, {"exited": exited, "exitCode": exit_code})
        finally:
            process_handle.Close()
    except BaseException as error:
        failure = str(error)
        try:
            window.capture_as_image().save(run_dir / "failure.png")
        except Exception:
            pass
        raise
    finally:
        stop_monitor.set()
        if monitor_thread:
            monitor_thread.join(timeout=2)
        if pid:
            try:
                device.kill(pid)
            except frida.ProcessNotFoundError:
                pass
        if source and source.poll() is None:
            source.terminate()
            source.wait(timeout=5)
        restore(SETTINGS_KEY, saved)
        restored = snapshot(SETTINGS_KEY) == saved
        report = {"ok": failure is None and restored, "error": failure, "publisher": str(exe),
                  "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(), "settingsRestored": restored,
                  "checks": checks, "events": events, "responsiveness": samples}
        (run_dir / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("Desktop workflow report: " + str(run_dir / "results.json"), flush=True)
        if not restored:
            raise RuntimeError("Settings were not restored")


if __name__ == "__main__":
    if "--source-window" in sys.argv:
        source_window()
    else:
        main()
