#!/usr/bin/env python3
"""Launch the packaged GUI against owned update caches and inspect its actual footer.

Synthetic release metadata exercises the normal cached-launch workflow. It does
not publish a release, download/install an update, or qualify the network path.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import urllib.request
import uuid


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--ui-helper", type=Path, required=True)
    parser.add_argument("--reports", type=Path, required=True)
    parser.add_argument("--case", choices=["missing", "windows", "intel", "source", "development", "incomplete", "eligible", "current", "failed-refresh"])
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This workflow requires macOS")
    app, helper = args.app.resolve(), args.ui_helper.resolve()
    executable = app / "Contents/MacOS/game-capture"
    if not executable.is_file() or not (app / "Contents/Frameworks").is_dir():
        parser.error("Use the deployed .app")
    report = args.reports.resolve() / str(uuid.uuid4())
    report.mkdir(parents=True)
    (report / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    version = plistlib.loads((app / "Contents/Info.plist").read_bytes())["CFBundleShortVersionString"]
    newer = f"{int(version.split('.')[0]) + 1}.0.0"
    result = {"scope": __doc__, "executableSha256": sha(executable), "harnessSha256": sha(Path(__file__)),
              "helperSha256": sha(helper), "installedVersion": version, "cases": [], "passed": False}
    env = {k: v for k, v in os.environ.items() if not k.startswith(("QT_", "DYLD_", "GAME_CAPTURE_", "VERSUS_"))}
    process = None

    def release(tag, kind):
        name = f"game-capture-macos-arm64-{tag}.zip"
        if kind == "windows":
            name = f"game-capture-windows-x64-{tag}.zip"
        if kind == "intel":
            name = f"game-capture-macos-x64-{tag}.zip"
        if kind == "source":
            name = f"game-capture-macos-arm64-{tag}-source.zip"
        if kind == "development":
            name = f"game-capture-macos-arm64-{tag}-development.zip"
        asset = {"name": name, "state": "starter" if kind == "incomplete" else "uploaded", "size": 1234,
                 "browser_download_url": f"https://github.com/steveseguin/Game-capture/releases/download/v{tag}/{name}"}
        return {"tag_name": f"v{tag}", "draft": False, "prerelease": False,
                "assets": [] if kind == "missing" else [asset]}

    def api(control, route, body=None):
        payload = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(control["base_url"] + route, data=payload,
                                         headers={"Authorization": "Bearer " + control["token"], "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    try:
        print("Reports:", report, flush=True)
        cases = [(kind, newer, True, "Latest release has no Apple Silicon download", False)
                 for kind in ("missing", "windows", "intel", "source", "development", "incomplete")]
        cases += [("eligible", newer, True, f"New version available: v{newer}", True),
                  ("current", version, True, "You’re up to date", False),
                  ("failed-refresh", newer, False, "Update check unavailable", False)]
        if args.case:
            cases = [case for case in cases if case[0] == args.case]
        for name, tag, success, expected, link_expected in cases:
            case_dir = report / name
            settings = case_dir / "settings"
            settings.mkdir(parents=True)
            cache = settings / "update-check.ini"
            metadata = release(tag, name)
            encoded = "".join(f"\\x{byte:02x}" for byte in json.dumps(metadata, separators=(",", ":")).encode())
            now = int(time.time())
            cache.write_text(f"[General]\nLastAttempt={now}\nLastSuccess={now}\n"
                             f"LastAttemptSucceeded={'true' if success else 'false'}\nRelease=@ByteArray({encoded})\n")
            cache_hash = sha(cache)
            discovery = case_dir / "control.json"
            entry = {"name": name, "expected": expected, "syntheticRelease": metadata, "launches": [], "passed": False}
            result["cases"].append(entry)
            # Relaunch the eligible case with the same cache/settings to check
            # that normal persistence does not lose asset eligibility.
            for launch in range(2 if name == "eligible" else 1):
                with (case_dir / f"launch-{launch}.log").open("w") as log:
                    process = subprocess.Popen([str(executable), f"--settings-dir={settings}", "--local-control",
                                                "--local-control-port=0", f"--local-control-discovery={discovery}"],
                                               cwd=case_dir, env=env, stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 20
                    rows = []
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            raise RuntimeError(f"{name}: app exited before footer observation")
                        subprocess.run([str(helper), str(process.pid), "scroll-bottom"], capture_output=True, timeout=5)
                        observed = subprocess.run([str(helper), str(process.pid), "dump"], capture_output=True, text=True, timeout=5)
                        if observed.returncode == 0:
                            all_rows = json.loads(observed.stdout)
                            rows = [row for row in all_rows if any(str(row.get("AXIdentifier", "")).endswith(key)
                                    for key in ("updateStatusLabel", "releasesLink"))]
                            if discovery.exists() and any(expected in row.values() for row in rows):
                                break
                        time.sleep(.25)
                    assert any(expected in row.values() for row in rows), f"{name}: footer mismatch: {rows}"
                    links = [row for row in rows if str(row.get("AXIdentifier", "")).endswith("releasesLink")]
                    assert bool(links) == link_expected, f"{name}: Releases link visibility mismatch: {links}"
                    control = json.loads(discovery.read_text())
                    assert control["pid"] == process.pid
                    diagnostics = api(control, "/diagnostics")
                    assert not diagnostics["source"]["has_frame"], "Update workflow unexpectedly started capture"
                    entry["launches"].append({"footer": rows, "pid": process.pid, "captureStarted": False})
                    api(control, "/commands", {"command": "quit"})
                    assert process.wait(timeout=10) == 0, "App did not quit normally"
                    process = None
                    assert not discovery.exists(), "Discovery file survived quit"
                    assert sha(cache) == cache_hash, "Warm update cache was unexpectedly rewritten"
            entry["passed"] = True
            print(name + ": passed", flush=True)
            (report / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        result["passed"] = True
    except Exception as error:
        result["error"] = repr(error)
        print(result["error"], file=sys.stderr)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        (report / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"report": str(report), "passed": result["passed"]}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
