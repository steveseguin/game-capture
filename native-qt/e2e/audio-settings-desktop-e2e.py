"""Use the packaged GUI to save audio settings, restart, and stream decoded audio."""
import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import Request, urlopen
import uuid

from pywinauto import Application
import win32api
import win32con
import win32gui

spec = importlib.util.spec_from_file_location("desktop_workflow", Path(__file__).with_name("desktop-ui-e2e.py"))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--publisher", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--codec", choices=["opus", "pcm"], default="opus")
    parser.add_argument("--red", action="store_true")
    parser.add_argument("--window-size", help="Review settings at a specific size, for example 760x520; playback uses a maximized window")
    args = parser.parse_args()
    exe, output = args.publisher.resolve(), args.output.resolve()
    assert (exe.parent / "platforms/qwindows.dll").is_file(), "Complete package required"
    output.mkdir(parents=True)
    saved = desktop.snapshot(desktop.SETTINGS_KEY)
    report = {"publisher": str(exe), "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(), "checks": []}
    children, logs = [], []
    window = None
    stream = "audiogui" + uuid.uuid4().hex

    def launch(command, name):
        log = open(output / (name + ".log"), "w", encoding="utf-8")
        logs.append(log)
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
            env=dict(os.environ, LOCALAPPDATA=str(output), GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING="1"),
            creationflags=subprocess.CREATE_NO_WINDOW)
        children.append(child)
        return child

    def check(name, condition):
        report["checks"].append({"name": name, "passed": bool(condition)})
        print(name, bool(condition), flush=True)
        assert condition, name

    def control(discovery, route, body=None):
        info = json.loads(discovery.read_text(encoding="utf-8"))
        request = Request(info["base_url"] + route,
            data=json.dumps(body).encode() if body else None,
            headers={"Authorization": "Bearer " + info["token"], "Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    try:
        for group, name, value in [
            ("video", "sourceMode", "window"), ("video", "codec", "h264"),
            ("video", "encoderMode", "auto"), ("video", "alphaWorkflow", "false"),
            ("video", "resolution", "960x540"), ("video", "fps", "30"),
            ("video", "ffmpegPath", ""), ("video", "ffmpegOptions", ""),
            ("audio", "source", "default-output"), ("audio", "includeMicrophone", "false"),
            ("audio", "bitrateKbps", "192"), ("audio", "channels", "2"),
            ("audio", "primaryGainPercent", "100"), ("audio", "limiterEnabled", "true"),
            ("audio", "codec", "opus"), ("audio", "red", "false"),
            ("ui", "advancedVisible", "false"), ("stream", "target", stream),
            ("stream", "room", ""), ("stream", "password", "false"),
            ("control", "enabled", "false"), ("network", "iceMode", "all")]:
            desktop.setting(group, name, value)

        def open_app(name):
            nonlocal window
            discovery = output / (name + "-control.json")
            process = launch([str(exe), "--local-control", "--local-control-discovery=" + str(discovery)], name)
            app = Application(backend="uia").connect(process=process.pid, timeout=20)
            window = desktop.application_window(process.pid)
            window.wait("visible", timeout=20)
            if args.window_size:
                width, height = map(int, args.window_size.split("x"))
                window.restore()
                win32gui.SetWindowPos(window.handle, 0, 40, 40, width, height, win32con.SWP_NOZORDER)
            else:
                window.maximize()
            # Keep the temporary QA window visible if another desktop task
            # raises a terminal while physical mouse clicks are in progress.
            win32gui.SetWindowPos(window.handle, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                 win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
            window.set_focus()
            desktop.wait_for(discovery.exists, "local control discovery")
            time.sleep(1)  # Let the Windows maximize animation settle before capture.
            return process, app, discovery

        def named(suffix):
            return next(c for c in window.descendants() if
                (c.element_info.automation_id or "").endswith("." + suffix))

        def reveal(control):
            window.set_focus()
            # Point at the outer scrollbar, outside combo boxes that consume
            # wheel events. Offscreen UIA rectangles alone do not prove visibility.
            window.wheel_mouse_input(coords=(window.rectangle().width() - 8, 150), wheel_dist=50)
            time.sleep(.35)
            for _ in range(70):
                time.sleep(.05)
                rect, viewport = control.rectangle(), window.rectangle()
                if viewport.top + 80 < rect.mid_point().y < viewport.bottom - 60:
                    time.sleep(.35)
                    if control.rectangle() == rect:
                        return
                window.wheel_mouse_input(coords=(viewport.width() - 8, 150), wheel_dist=-2)
            raise AssertionError("Could not reveal " + control.window_text())

        def audio_controls():
            advanced = named("advancedToggle")
            if not advanced.get_toggle_state():
                reveal(advanced)
                advanced.click_input()
            toggle = named("audioEncodingToggle")
            if not toggle.get_toggle_state():
                reveal(toggle)
                toggle.click_input()
            window.wheel_mouse_input(coords=(window.rectangle().width() - 8, 150), wheel_dist=-35)
            time.sleep(.5)
            return named("audioBitrateSpin"), named("audioChannelsSelect")

        def select(combo, text):
            reveal(combo)
            combo.click_input()
            def option():
                return next((c for w in app.windows() for c in w.descendants(control_type="ListItem")
                             if c.window_text() == text and c.is_visible()), None)
            desktop.wait_for(lambda: option() is not None, "menu option " + text)
            option().click_input()

        process, app, discovery = open_app("save")
        check("advanced-hidden-by-default", not named("advancedToggle").get_toggle_state())
        window.capture_as_image().save(output / "default-collapsed.png")
        bitrate, channels = audio_controls()
        reveal(bitrate)
        bitrate.type_keys("^a128{TAB}", set_foreground=True)
        select(channels, "Mono (1 channel)")
        if args.red:
            reveal(named("audioRedCheck"))
            named("audioRedCheck").click_input()
        if args.codec == "pcm":
            select(named("audioCodecSelect"), "PCM (experimental)")
            check("pcm-shows-fixed-bandwidth", not bitrate.is_enabled() and not named("audioRedCheck").is_enabled())
        check("gui-selects-mono", channels.selected_text() == "Mono (1 channel)")
        window.capture_as_image().save(output / "settings.png")
        control(discovery, "/commands", {"command": "quit"})
        check("settings-save-exits-cleanly", process.wait(timeout=15) == 0)

        source = launch([sys.executable, str(Path(__file__).with_name("desktop-ui-e2e.py")), "--source-window"], "source")
        tone = launch(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(Path(__file__).with_name("audio-test-tone.ps1")), "-RightFrequencyHz", "880",
            "-DurationMs", "240000", "-Amplitude", "0.08"], "tone")
        process, app, discovery = open_app("restore")
        check("audio-encoding-collapsed-on-restart", not named("audioEncodingToggle").get_toggle_state())
        bitrate, channels = audio_controls()
        check("restart-restores-codec", named("audioCodecSelect").selected_text().startswith(args.codec.upper() if args.codec == "pcm" else "Opus"))
        check("restart-restores-red", bool(named("audioRedCheck").get_toggle_state()) == args.red)
        check("restart-restores-bitrate", "128" in bitrate.window_text())
        check("restart-restores-mono", channels.selected_text() == "Mono (1 channel)")
        if args.window_size:
            report["settingsWindowSize"] = args.window_size
            report["playbackWindowSize"] = "maximized"
            # The requested compact size covers settings, persistence and
            # screenshots. Use the normal full form for capture navigation.
            window.maximize()
            time.sleep(.5)
        window.wheel_mouse_input(coords=(window.rectangle().width() - 8, 150), wheel_dist=45)
        time.sleep(.5)
        item = window.child_window(title_re=desktop.SOURCE_TITLE + ".*", control_type="ListItem")
        source_list = named("sourceList")
        if source_list.element_info.control_type == "ListItem":
            source_list = source_list.parent()
        center = source_list.rectangle().mid_point()
        source_list.move_mouse_input(coords=(center.x, center.y), absolute=True)
        for _ in range(80):
            if item.exists(timeout=.1):
                row, viewport = item.rectangle(), source_list.rectangle()
                bounds = window.rectangle()
                if max(viewport.top, bounds.top + 32) < row.mid_point().y < min(viewport.bottom, bounds.bottom - 10):
                    break
            win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL, 0, 0, -40, 0)
            time.sleep(.1)
        else:
            raise AssertionError("Source fixture not reachable")
        window.set_focus()
        time.sleep(.35)
        item.click_input()
        desktop.wait_for(lambda: named("goLiveButton").is_enabled(), "source selected")
        # The main form scrolls as a whole; bring the start button into view.
        audio_controls()
        reveal(named("goLiveButton"))
        named("goLiveButton").click_input()
        desktop.wait_for(lambda: control(discovery, "/diagnostics")["app"]["live"], "GUI stream live", 30)
        bitrate, channels = audio_controls()
        check("live-locks-audio-settings", not bitrate.is_enabled() and not channels.is_enabled())
        check("live-locks-codec-and-red", not named("audioCodecSelect").is_enabled() and not named("audioRedCheck").is_enabled())
        link = html.unescape(re.search(r'https://[^<"\s]+', named("shareLinkLabel").window_text())[0])
        receiver = subprocess.run(["node", str(Path(__file__).with_name("audio-settings-packaged-e2e.js")),
            "--stream=" + stream, "--bitrate=128", "--channels=1", "--discovery=" + str(discovery),
            "--viewer-url=" + link,
            "--codec=" + args.codec, "--red=" + str(args.red).lower(),
            "--output=" + str(output / "receiver")], timeout=85, capture_output=True, text=True)
        (output / "receiver.log").write_text(receiver.stdout + receiver.stderr, encoding="utf-8")
        check("saved-settings-reach-browser", receiver.returncode == 0)
        reveal(named("goLiveButton"))
        named("goLiveButton").click_input()
        desktop.wait_for(lambda: named("audioCodecSelect").is_enabled(), "audio settings unlocked after stop", 20)
        check("stop-unlocks-audio-settings", named("audioChannelsSelect").is_enabled())
        control(discovery, "/commands", {"command": "quit"})
        check("stream-exits-cleanly", process.wait(timeout=15) == 0)
        report["ok"] = True
    except BaseException as error:
        report["error"] = str(error)
        if window:
            try:
                window.capture_as_image().save(output / "failure.png")
            except Exception:
                pass
        raise
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)
        for log in logs:
            log.close()
        desktop.restore(desktop.SETTINGS_KEY, saved)
        report["settingsRestored"] = desktop.snapshot(desktop.SETTINGS_KEY) == saved
        (output / "results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        assert report["settingsRestored"], "Original settings were not restored"


if __name__ == "__main__":
    main()
