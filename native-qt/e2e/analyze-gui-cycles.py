"""Summarize actual packaged GUI cycle evidence without inferring leak freedom."""
import argparse
import json
from pathlib import Path
import statistics


def describe(values):
    return {"min": min(values), "median": statistics.median(values), "max": max(values)} if values else None


def analyze(folder):
    report = json.loads((folder / "results.json").read_text(encoding="utf-8"))
    cycles = report["cycles"]
    samples = [json.loads(line) for line in (folder / "resources.jsonl").read_text().splitlines()]
    late = cycles[len(cycles) // 2:]
    idle = [s for s in samples if s["phase"] == "final-idle"]
    live = [s for s in samples if s["phase"].startswith("live-")]
    receiver = json.loads((folder / "receiver-1/receiver.json").read_text(encoding="utf-8"))
    offer = receiver["sdp"]["offer"].splitlines()
    cnames = sorted({line.split(" cname:", 1)[1] for line in offer if " cname:" in line})
    result = {
        "folder": str(folder), "sha256": report["sha256"], "mode": report["mode"],
        "baseline": report["baseline"], "passed": report.get("ok", False),
        "settingsRestored": report["settingsRestored"], "exitCode": report.get("exitCode"),
        "cycles": len(cycles), "decodedPlaybackPasses": sum(c["decodedPlaybackPassed"] for c in cycles),
        "elapsedSeconds": report["finished"] - report["started"],
        "startMs": describe([c["startMs"] for c in cycles]),
        "stopMs": describe([c["stopMs"] for c in cycles]),
        "initialPrivateMiB": report["initialResources"]["private"] / 1048576,
        "firstStoppedPrivateMiB": cycles[0]["stoppedResources"]["private"] / 1048576,
        "lastStoppedPrivateMiB": cycles[-1]["stoppedResources"]["private"] / 1048576,
        "lateStoppedPrivateMiB": describe([c["stoppedResources"]["private"] / 1048576 for c in late]),
        "firstLastStoppedHandles": [cycles[i]["stoppedResources"]["handles"] for i in (0, -1)],
        "lateStoppedHandles": describe([c["stoppedResources"]["handles"] for c in late]),
        "peakPrivateMiB": max(s["private"] for s in samples) / 1048576,
        "liveCpuPercentOneCore": describe([s["cpuPercentOneCore"] for s in live]),
        "systemCpuPercent": describe([s["systemCpuPercent"] for s in samples if "systemCpuPercent" in s]),
        "availableMemoryMiB": describe([s["availableMemoryMiB"] for s in samples if "availableMemoryMiB" in s]),
        "finalResources": report.get("finalResources"),
        "finalIdleSeconds": idle[-1]["wall"] - idle[0]["wall"] if len(idle) > 1 else 0,
        "lateIdlePrivateMiB": describe([s["private"] / 1048576 for s in idle[-30:]]),
        "lateIdleHandles": describe([s["handles"] for s in idle[-30:]]),
        "soundHooks": report.get("soundHooks", True),
        "appSoundCalls": len(report["soundCalls"]) if report.get("soundHooks", True) else None,
        "syncSignaling": {"cnames": cnames, "singleCname": len(cnames) == 1,
                          "mediaStreamIds": [line for line in offer if line.startswith("a=msid:")]},
        "limitations": "Observed resource retention and bounds for a finite GUI workflow, not proof of a leak or leak freedom. Check soundHooks for injected observer overhead. Baseline uses explicit stereo/ab receiver preferences to match the review. Playback passes do not imply synchronization-signaling conformance.",
    }
    (folder / "analysis.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folders", nargs="+", type=Path)
    args = parser.parse_args()
    print(json.dumps([analyze(folder) for folder in args.folders], indent=2))
