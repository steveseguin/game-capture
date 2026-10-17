#!/usr/bin/env python3
"""Packaged CLI selection refusals using only owned Syphon senders."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--app", required=True, type=Path)
parser.add_argument("--fixture", required=True, type=Path)
parser.add_argument("--reports", required=True, type=Path)
args = parser.parse_args()
report = args.reports.resolve() / str(uuid.uuid4())
report.mkdir(parents=True)
exe = args.app.resolve() / "Contents/MacOS/game-capture"
fixture = args.fixture.resolve()
env = {k: v for k, v in os.environ.items() if not k.startswith(("QT_", "DYLD_", "VERSUS_", "GAME_CAPTURE_"))}
result = {"scope": "Packaged CLI exact-source selection/refusal; media and GUI excluded",
          "executableSha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
          "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "fixtureSha256": hashlib.sha256(fixture.read_bytes()).hexdigest(), "cases": [], "passed": False}
senders = []


def announcement(child):
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        if not selector.select(10):
            raise RuntimeError("Owned Syphon sender did not announce")
        return json.loads(child.stdout.readline())


def sender(name):
    child = subprocess.Popen([str(fixture), name], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, env=env, cwd=report)
    senders.append(child)
    return child, announcement(child)


def refuse(name, options, message):
    started = time.monotonic()
    with (report / (name + ".log")).open("w") as log:
        process = subprocess.run([str(exe), "--headless", "--source=syphon", "--audio-source=none",
                                  "--video-codec=h264", "--video-encoder=videotoolbox",
                                  "--duration-ms=10000", "--stream=selection" + uuid.uuid4().hex,
                                  *options], stdout=log, stderr=subprocess.STDOUT,
                                 timeout=20, env=env, cwd=report)
    content = (report / (name + ".log")).read_text()
    observed = {"name": name, "exitCode": process.returncode, "seconds": time.monotonic() - started,
                "expectedMessage": message, "messageFound": message in content}
    result["cases"].append(observed)
    assert process.returncode == 2, observed
    assert observed["messageFound"], observed


try:
    title = "Owned Syphon Selection " + uuid.uuid4().hex
    first, identity = sender(title)
    second, _ = sender(title)
    refuse("required-selection", [], "Syphon requires --syphon-server")
    refuse("invalid-alpha", ["--syphon-server=" + identity["uuid"], "--syphon-alpha=unknown"],
           "--syphon-alpha requires")
    refuse("missing-uuid", ["--syphon-server=" + str(uuid.uuid4())], "Requested Syphon sender is unavailable")
    refuse("ambiguous-name", ["--syphon-server=" + title], "Ambiguous Syphon name")
    first.stdin.write("restart\n")
    first.stdin.flush()
    replacement = announcement(first)
    assert replacement["uuid"] != identity["uuid"]
    refuse("retired-generation", ["--syphon-server=" + identity["uuid"]], "Requested Syphon sender is unavailable")
    result["passed"] = True
except Exception as error:
    result["error"] = repr(error)
finally:
    result["senderExits"] = []
    for child in senders:
        if child.poll() is None:
            child.stdin.write("quit\n")
            child.stdin.flush()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
        result["senderExits"].append(child.returncode)
    result["passed"] = result["passed"] and all(code == 0 for code in result["senderExits"])
    (report / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    (report / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"report": str(report), "passed": result["passed"], "error": result.get("error")}))
raise SystemExit(0 if result["passed"] else 1)
