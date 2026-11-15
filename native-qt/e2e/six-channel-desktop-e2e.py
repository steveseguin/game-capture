"""Use the packaged GUI to select six-channel audio: PCM and RED lock out, the choice survives a restart,
and a live stream advertises six-channel playback in its share link."""
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

from pywinauto import Application, keyboard
import win32con
import win32gui

spec = importlib.util.spec_from_file_location("desktop_workflow", Path(__file__).with_name("desktop-ui-e2e.py"))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)

SIX = "6 channels (experimental)"
STEREO = "Stereo (2 channels)"
PCM = "PCM (experimental)"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--publisher", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--no-live", action="store_true", help="Skip the hosted VDO.Ninja go-live portion")
    args = parser.parse_args()
    exe, output = args.publisher.resolve(), args.output.resolve()
    assert (exe.parent / "platforms/qwindows.dll").is_file(), "Complete package required"
    output.mkdir(parents=True)
    saved = desktop.snapshot(desktop.SETTINGS_KEY)
    report = {"publisher": str(exe), "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(), "checks": [],
              "hostedVdoNinja": not args.no_live}
    children, logs = [], []
    window = None
    stream = "sixgui" + uuid.uuid4().hex

    def launch(command, name):
        log = open(output / (name + ".log"), "w", encoding="utf-8")
        logs.append(log)
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
            env=dict(os.environ, LOCALAPPDATA=str(output), GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING="1"),
            creationflags=subprocess.CREATE_NO_WINDOW)
        children.append(child)
        return child

    def check(name, condition, detail=None):
        entry = {"name": name, "passed": bool(condition)}
        if detail is not None:
            entry["detail"] = detail
        report["checks"].append(entry)
        print(name, bool(condition), "" if detail is None else detail, flush=True)
        assert condition, name

    def control(discovery, route, body=None):
        info = json.loads(discovery.read_text(encoding="utf-8"))
        request = Request(info["base_url"] + route,
            data=json.dumps(body).encode() if body else None,
            headers={"Authorization": "Bearer " + info["token"], "Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    try:
        # Start from a saved stereo PCM selection so the six-channel switch has something to override.
        for group, name, value in [
            ("video", "sourceMode", "window"), ("video", "codec", "h264"),
            ("video", "encoderMode", "auto"), ("video", "alphaWorkflow", "false"),
            ("video", "resolution", "960x540"), ("video", "fps", "30"),
            ("video", "ffmpegPath", ""), ("video", "ffmpegOptions", ""),
            ("audio", "source", "default-output"), ("audio", "includeMicrophone", "false"),
            ("audio", "bitrateKbps", "192"), ("audio", "channels", "2"),
            ("audio", "primaryGainPercent", "100"), ("audio", "limiterEnabled", "true"),
            ("audio", "codec", "pcm"), ("audio", "red", "false"),
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
            window.maximize()
            win32gui.SetWindowPos(window.handle, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                 win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
            window.set_focus()
            desktop.wait_for(discovery.exists, "local control discovery")
            time.sleep(1)
            return process, app, discovery

        def named(suffix):
            return next(c for c in window.descendants() if
                (c.element_info.automation_id or "").endswith("." + suffix))

        def reveal(control):
            window.set_focus()
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

        def popup_option(text):
            return next((c for w in app.windows() for c in w.descendants(control_type="ListItem")
                         if c.window_text() == text and c.is_visible()), None)

        def select(combo, text):
            reveal(combo)
            combo.click_input()
            desktop.wait_for(lambda: popup_option(text) is not None, "menu option " + text)
            popup_option(text).click_input()
            time.sleep(.3)

        def try_select_pcm():
            """Open the codec menu, record whether PCM is greyed out, click it anyway, and close the menu."""
            codec = named("audioCodecSelect")
            reveal(codec)
            codec.click_input()
            desktop.wait_for(lambda: popup_option(PCM) is not None, "codec menu")
            option = popup_option(PCM)
            enabled = option.is_enabled()
            option.click_input()
            time.sleep(.3)
            if popup_option(PCM) is not None:
                keyboard.send_keys("{ESC}")
                time.sleep(.3)
            return enabled

        process, app, discovery = open_app("select")
        bitrate, channels = audio_controls()
        codec, red = named("audioCodecSelect"), named("audioRedCheck")
        check("saved-stereo-pcm-restored", codec.selected_text().startswith("PCM") and channels.selected_text() == STEREO)
        select(channels, SIX)
        check("six-channel-switches-pcm-to-opus", named("audioCodecSelect").selected_text().startswith("Opus"))
        check("six-channel-disables-red", not named("audioRedCheck").is_enabled())
        check("six-channel-keeps-bitrate-editable", named("audioBitrateSpin").is_enabled())
        pcm_enabled = try_select_pcm()
        check("six-channel-keeps-opus-after-clicking-pcm", named("audioCodecSelect").selected_text().startswith("Opus"),
              {"pcmMenuItemEnabled": pcm_enabled})
        bitrate = named("audioBitrateSpin")
        reveal(bitrate)
        bitrate.type_keys("^a384{TAB}", set_foreground=True)
        window.capture_as_image().save(output / "six-channel-settings.png")
        control(discovery, "/commands", {"command": "quit"})
        check("settings-save-exits-cleanly", process.wait(timeout=15) == 0)

        process, app, discovery = open_app("restore")
        bitrate, channels = audio_controls()
        check("restart-restores-six-channels", channels.selected_text() == SIX)
        check("restart-restores-opus", named("audioCodecSelect").selected_text().startswith("Opus"))
        check("restart-keeps-red-disabled", not named("audioRedCheck").is_enabled())
        check("restart-restores-bitrate", "384" in bitrate.window_text())
        select(channels, STEREO)
        check("stereo-restores-red", named("audioRedCheck").is_enabled())
        pcm_enabled = try_select_pcm()
        check("stereo-allows-pcm-again", named("audioCodecSelect").selected_text().startswith("PCM"),
              {"pcmMenuItemEnabled": pcm_enabled})
        select(named("audioCodecSelect"), "Opus (48 kHz)")
        select(named("audioChannelsSelect"), SIX)
        check("six-channels-reselected", named("audioChannelsSelect").selected_text() == SIX)
        window.capture_as_image().save(output / "six-channel-reselected.png")

        if args.no_live:
            control(discovery, "/commands", {"command": "quit"})
            check("exits-cleanly", process.wait(timeout=15) == 0)
        else:
            launch([sys.executable, str(Path(__file__).with_name("desktop-ui-e2e.py")), "--source-window"], "source")
            launch(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                str(Path(__file__).with_name("audio-test-tone.ps1")), "-RightFrequencyHz", "880",
                "-DurationMs", "180000", "-Amplitude", "0.08"], "tone")
            window.wheel_mouse_input(coords=(window.rectangle().width() - 8, 150), wheel_dist=45)
            time.sleep(.5)
            item = window.child_window(title_re=desktop.SOURCE_TITLE + ".*", control_type="ListItem")
            source_list = named("sourceList")
            if source_list.element_info.control_type == "ListItem":
                source_list = source_list.parent()
            center = source_list.rectangle().mid_point()
            source_list.move_mouse_input(coords=(center.x, center.y), absolute=True)
            import win32api
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
            audio_controls()
            reveal(named("goLiveButton"))
            named("goLiveButton").click_input()
            desktop.wait_for(lambda: control(discovery, "/diagnostics")["app"]["live"], "GUI stream live", 30)
            diagnostics = control(discovery, "/diagnostics")
            (output / "live-diagnostics.json").write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
            bitrate, channels = audio_controls()
            check("live-locks-audio-settings", not bitrate.is_enabled() and not channels.is_enabled())
            link = html.unescape(re.search(r'https://[^<"\s]+', named("shareLinkLabel").window_text())[0])
            report["shareLink"] = link
            check("share-link-requests-six-channel-playback", re.search(r"[?&]stereo=4(&|$)", link) is not None, link)
            audio = diagnostics.get("audio", {})
            check("diagnostics-report-six-output-channels", audio.get("output_channels") == 6,
                  {"output_channels": audio.get("output_channels"), "codec": audio.get("codec")})
            check("diagnostics-report-opus-384", audio.get("codec") == "opus" and audio.get("configured_opus_bitrate_kbps") == 384,
                  {"configured_opus_bitrate_kbps": audio.get("configured_opus_bitrate_kbps")})
            window.capture_as_image().save(output / "six-channel-live.png")
            reveal(named("goLiveButton"))
            named("goLiveButton").click_input()
            desktop.wait_for(lambda: named("audioChannelsSelect").is_enabled(), "audio settings unlocked after stop", 20)
            check("stop-unlocks-audio-settings", named("audioCodecSelect").is_enabled())
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
