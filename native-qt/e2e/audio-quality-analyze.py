"""Analyze decoded Chrome audio saved by audio-quality-packaged-e2e.js.

Requires NumPy and SciPy. Click indicators measure waveform discontinuities;
they do not assert that a human listener would find every residual audible.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile


def analyze(folder):
    report = json.loads((folder / "results.json").read_text())
    output = {"publisherSha256": report["sha256"], "cases": []}
    for case in report["cases"]:
        result = {"name": case["name"], "stages": []}
        for stage in case["stages"]:
            base = folder / case["name"] / stage["label"]
            pcm = np.fromfile(base.with_suffix(".f32"), dtype="<f4").reshape(-1, 2)
            wavfile.write(str(base.with_suffix(".wav")), 48000, pcm)
            # Trim startup and the final partial analysis block.
            x = pcm[48000:-9600]
            n = len(x) // 480 * 480
            x = x[:n]
            blocks = x.reshape(-1, 480, 2)
            t = np.arange(480) / 48000
            marker = np.abs(np.einsum("bsc,s->bc", blocks, np.exp(-2j*np.pi*2000*t))) / 240
            clean = np.max(marker, axis=1) < .01
            # Keep margins around intentional marker attack and release.
            clean = ~np.convolve(~clean, np.ones(7, dtype=int), mode="same").astype(bool)
            high = signal.sosfiltfilt(signal.butter(6, 6000, fs=48000, btype="highpass", output="sos"), x, axis=0)
            high_blocks = high.reshape(-1, 480, 2)
            channels = []
            for ch, hz in enumerate((400, 800)):
                y = x[:, ch]
                residual = y[2:] - 2*np.cos(2*np.pi*hz/48000)*y[1:-1] + y[:-2]
                residual = np.pad(residual, (2, 0)).reshape(-1, 480)
                clean_residual = residual[clean]
                channels.append({
                    "rms": float(np.sqrt(np.mean(y*y))),
                    "dc": float(np.mean(y)),
                    "highFrequencyRms": float(np.sqrt(np.mean(high_blocks[clean, :, ch]**2))),
                    "highFrequencyPeak": float(np.max(np.abs(high_blocks[clean, :, ch]))),
                    "sinePredictorResidualRms": float(np.sqrt(np.mean(clean_residual**2))),
                    "sinePredictorResidualPeak": float(np.max(np.abs(clean_residual))),
                    "discontinuityWindowsAbove002": int(np.count_nonzero(np.max(np.abs(clean_residual), axis=1) > .02)),
                })
            result["stages"].append({"label": stage["label"], "seconds": len(pcm)/48000,
                "clippedSamples": int(np.count_nonzero(np.abs(pcm) >= .999)),
                "peak": float(np.max(np.abs(pcm))), "steadyWindows": int(np.count_nonzero(clean)),
                "channels": channels})
        samples = case.get("samples", [])
        if len(samples) > 1:
            # Discard the first 30 s for the steady-state slope when possible.
            steady = [s for s in samples if "receiver" in s and s["wallMs"] - samples[0]["wallMs"] > 30000]
            if len(steady) < 3:
                steady = samples
            times = np.asarray([s["wallMs"] for s in steady], dtype=float)
            times = (times-times[0])/60000
            memory = np.asarray([s["privateBytes"] for s in steady])/1048576
            intervals = [(b["cpuMs"]-a["cpuMs"])/(b["wallMs"]-a["wallMs"])*100
                         for a,b in zip(samples, samples[1:])]
            result["resources"] = {"seconds": (samples[-1]["wallMs"]-samples[0]["wallMs"])/1000,
                "privateFirstMiB": samples[0]["privateBytes"]/1048576,
                "privateLastMiB": samples[-1]["privateBytes"]/1048576,
                "privatePeakMiB": max(s["privateBytes"] for s in samples)/1048576,
                "steadyPrivateSlopeMiBPerMinute": float(np.polyfit(times, memory, 1)[0]),
                "medianCpuPercentOneCore": float(np.median(intervals)),
                "medianCpuPercentMachine": float(np.median(intervals))/report.get("logicalProcessors", 1),
                "handlesFirstLast": [samples[0]["handles"], samples[-1]["handles"]],
                "threadsFirstLast": [samples[0]["threads"], samples[-1]["threads"]]}
            churn = case.get("churn", [])
            if churn:
                result["resources"]["viewerChurn"] = [{"cycle": s["cycle"],
                    "privateMiB": s["privateBytes"]/1048576,
                    "handles": s["handles"], "threads": s["threads"]} for s in churn]
            if any(s.get("gpu") for s in samples):
                result["resources"]["gpuSamples"] = [{"wallMs": s["wallMs"], "adapters": s.get("gpu", [])} for s in samples]
        output["cases"].append(result)
    (folder / "analysis.json").write_text(json.dumps(output, indent=2))
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    print(json.dumps(analyze(args.folder), indent=2))
