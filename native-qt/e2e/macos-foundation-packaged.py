#!/usr/bin/env python3
"""Exercise the packaged Mac development UI's diagnostics workflow.

This does not qualify media capture, encoding, playback or Windows regressions.
It requires a logged-in macOS desktop and a macdeployqt-deployed .app.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This workflow requires macOS")
    app = args.app.resolve()
    executable = app / "Contents/MacOS/game-capture"
    if not executable.is_file() or not (app / "Contents/Frameworks").is_dir():
        parser.error("Use the deployed .app from the macos-dev-bundle target")
    report = args.report_dir.resolve()
    report.mkdir(parents=True, exist_ok=True)
    discovery = report / "control.json"
    if discovery.exists():
        parser.error("Use a fresh report directory; it already contains control discovery")
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("QT_", "DYLD_", "GAME_CAPTURE_LOCAL_CONTROL"))}
    control = None
    checks = []
    process = None
    result = {"scope": "Mac packaged UI diagnostics; media coverage is recorded separately",
              "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
              "checks": checks, "passed": False}

    def request(path, body=None, authenticated=True):
        headers = {}
        if authenticated:
            headers["Authorization"] = "Bearer " + control["token"]
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        query = urllib.request.Request(control["base_url"] + path, data=data, headers=headers)
        with urllib.request.urlopen(query, timeout=5) as response:
            return json.load(response)

    try:
        with (report / "launch.log").open("w") as output:
            process = subprocess.Popen(
                [str(executable), "--temporary-settings", "--local-control", "--local-control-port=0",
                 f"--local-control-discovery={discovery}"],
                cwd=report, env=env, stdout=output, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"Packaged app exited with {process.returncode} before local control was ready; see launch.log")
                if discovery.exists():
                    control = json.loads(discovery.read_text())
                    break
                time.sleep(0.1)
            if control is None:
                raise RuntimeError("Packaged app did not publish control discovery")
            assert control["pid"] == process.pid
            assert request("/health", authenticated=False)["ok"]
            checks.append("Cocoa GUI process launched from deployed bundle")
            try:
                request("/diagnostics", authenticated=False)
                raise AssertionError("Unauthenticated diagnostics were accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            checks.append("Diagnostics require authentication")

            diagnostics = request("/diagnostics")
            capabilities = diagnostics["platform_capabilities"]
            assert capabilities["platform"] == "macOS"
            assert capabilities["can_publish"] is True
            assert capabilities["video_encoding"] is True
            assert capabilities["window_capture"] is True
            assert capabilities["camera_capture"] is True
            assert capabilities["audio_capture"] is True
            assert capabilities["microphone_capture"] is True
            assert capabilities["communications_audio_capture"] is False
            checks.append("Implemented and unavailable media backends reported explicitly")

            # Exercise production sampling through the packaged app API. The
            # first CPU sample has no interval, so wait for a later snapshot.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                diagnostics = request("/diagnostics")
                if diagnostics["system"]["cpu_percent"] >= 0:
                    break
                time.sleep(0.3)
            resources = diagnostics["system"]
            physical = int(subprocess.check_output(["/usr/sbin/sysctl", "-n", "hw.memsize"], text=True))
            assert 0 <= resources["cpu_percent"] <= 100
            assert resources["memory_total_bytes"] == physical
            assert 0 < resources["memory_used_bytes"] <= physical
            assert abs(resources["memory_percent"] - 100 * resources["memory_used_bytes"] / physical) < 0.001
            result["system_resources"] = resources
            checks.append("Native CPU sampling and physical memory values are available through diagnostics")

            destination = report / "exported-diagnostics.json"
            exported = request("/commands", {"command": "export_diagnostics", "path": str(destination)})
            assert exported["ok"]
            saved = json.loads(destination.read_text())
            assert saved["platform_capabilities"] == capabilities
            assert control["token"] not in destination.read_text()
            checks.append("Exported diagnostics contain capabilities without the control token")

            logs = request("/logs/recent?lines=20")
            log_path = Path(logs["path"])
            assert log_path.parent == Path.home() / "Library/Logs/GameCapture"
            assert log_path.is_file()
            checks.append("Logs are written outside the launch working directory")
            assert request("/commands", {"command": "quit"})["ok"]
            assert process.wait(timeout=10) == 0
            assert not discovery.exists()
            checks.append("Quit closes the application and removes its discovery file")

        headless_diagnostics = report / "headless-diagnostics.json"
        headless = subprocess.run(
            [str(executable), "--headless", "--window=GameCaptureNonexistentSource0123456789",
             "--duration-ms=5000", f"--diagnostics-out={headless_diagnostics}"],
            cwd=report, env=env, capture_output=True, text=True, timeout=10)
        (report / "headless.log").write_text(headless.stdout + headless.stderr)
        assert headless.returncode == 2
        assert json.loads(headless_diagnostics.read_text())["platform_capabilities"]["can_publish"] is True
        checks.append("An explicitly missing source fails without publishing and exports diagnostics")
        for device_id, expected_message in [("game-capture-explicitly-missing-camera", "No camera has the exact requested --camera-id"),
                                             ("", "--camera-id requires an exact, nonempty device ID")]:
            camera = subprocess.run(
                [str(executable), "--headless", "--source=camera", f"--camera-id={device_id}",
                 "--audio-source=none", "--duration-ms=5000"],
                cwd=report, env=env, capture_output=True, text=True, timeout=10)
            camera_log = camera.stdout + camera.stderr
            (report / ("missing-camera.log" if device_id else "empty-camera.log")).write_text(camera_log)
            assert camera.returncode == 2 and expected_message in camera_log
        checks.append("Missing and empty exact camera IDs fail without default-device substitution")
        for index, options in enumerate([
                ["--settings-dir="],
                ["--settings-dir=" + str(report / "unused-settings"), "--temporary-settings"],
                ["--settings-dir=" + str(report / "unused-settings"), "--headless"]]):
            invalid = subprocess.run([str(executable)] + options, cwd=report, env=env,
                                     capture_output=True, text=True, timeout=10)
            (report / f"invalid-settings-{index}.log").write_text(invalid.stdout + invalid.stderr)
            assert invalid.returncode == 2
        assert not (report / "unused-settings").exists()
        checks.append("Empty or conflicting isolated-settings options fail before creating preferences")
        result["passed"] = True
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        if process is not None and process.poll() is None:
            if control is not None:
                try:
                    request("/commands", {"command": "quit"})
                except Exception:
                    pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        (report / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
