"""Stream-decode a complete receiver recording with bounded analysis memory."""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy import signal


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--audio-stream', type=int, default=1)
    parser.add_argument('--reference-analysis', default='obs-analysis-right.json')
    args = parser.parse_args()
    metadata = json.loads((args.folder / 'obs-receiver.json').read_text())
    reference = json.loads((args.folder / args.reference_analysis).read_text())
    assert reference['recording'] == metadata['recording']
    selected_start = reference['selection'].get('startSeconds', 0)
    offsets = [p['sourcePulseId'] * 2 - p['audioSeconds'] - selected_start for p in reference['pulsePairs']]
    source_offset = float(np.median(offsets))
    filters = [signal.butter(6, 6000, fs=48000, btype='highpass', output='sos'),
               signal.butter(4, [2980, 3020], fs=48000, btype='bandpass', output='sos')]
    states = [np.zeros((len(sos), 2, 2)) for sos in filters]
    sample_count = clipped = unexpected_quiet = discontinuities = beep_windows = 0
    peak = high_peak = beep_peak = 0.0
    anomalies = []
    log_path = args.folder / ('complete-audio-%d-decode.log' % args.audio_stream)
    with log_path.open('wb') as log:
        process = subprocess.Popen([args.ffmpeg, '-hide_banner', '-copyts', '-i', metadata['recording'],
            '-map', '0:a:%d' % args.audio_stream, '-vn', '-af', 'aresample=48000:async=1:first_pts=0',
            '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'], stdout=subprocess.PIPE, stderr=log)
        pending = b''
        while True:
            data = process.stdout.read(48000 * 2 * 4)
            if not data:
                break
            pending += data
            size = len(pending) // (480 * 2 * 4) * (480 * 2 * 4)
            if not size:
                continue
            pcm = np.frombuffer(pending[:size], '<f4').reshape(-1, 2)
            pending = pending[size:]
            blocks = pcm.reshape(-1, 480, 2)
            times = sample_count / 48000 + np.arange(len(blocks)) * .01 + .005
            sample_count += len(pcm)
            rms = np.sqrt(np.mean(blocks ** 2, axis=1)).max(axis=1)
            peak = max(peak, float(np.max(np.abs(pcm))))
            clipped += int(np.count_nonzero(np.abs(pcm) >= .999))
            filtered = []
            for index, sos in enumerate(filters):
                output, states[index] = signal.sosfilt(sos, pcm, axis=0, zi=states[index])
                filtered.append(np.max(np.abs(output.reshape(-1, 480, 2)), axis=(1, 2)))
            high_peak = max(high_peak, float(max(filtered[0])))
            beep_peak = max(beep_peak, float(max(filtered[1])))
            steady = times >= 30  # Preserve startup separately; do not count initial input activation as a dropout.
            phase = (times + source_offset) % 60
            active_expected = steady & ~((phase >= 44.7) & (phase <= 50.3))
            quiet = active_expected & (rms < .001)
            clicks = steady & (filtered[0] > .02)
            beeps = steady & (filtered[1] > .01)
            unexpected_quiet += int(np.count_nonzero(quiet))
            discontinuities += int(np.count_nonzero(clicks))
            beep_windows += int(np.count_nonzero(beeps))
            if len(anomalies) < 200:
                for i in np.flatnonzero(quiet | clicks | beeps)[:200-len(anomalies)]:
                    anomalies.append(dict(seconds=float(times[i]), quiet=bool(quiet[i]),
                                          highFrequency=bool(clicks[i]), systemTone=bool(beeps[i])))
        assert process.wait(timeout=30) == 0, 'Receiver audio decoding failed'
    result = dict(recording=metadata['recording'], audioStream=args.audio_stream,
                  decodedSeconds=sample_count / 48000, sourceClockOffsetSeconds=source_offset,
                  clippedSamples=clipped, peakSample=peak, highFrequencyPeak=high_peak,
                  systemToneBandPeak=beep_peak, unexpectedQuiet10ms=unexpected_quiet,
                  highFrequencyWindowsAbove002=discontinuities, systemToneWindowsAbove001=beep_windows,
                  firstAnomalies=anomalies,
                  passed=sample_count > 48000 * 60 and not any([clipped, unexpected_quiet, discontinuities, beep_windows]),
                  limits='Whole-recording software discontinuity indicators, not human listening. '
                         'Expected 45–50 second fixture silence uses measured source-clock alignment with a 300 ms guard. '
                         'The first 30 seconds remain decoded but are excluded from dropout/click/tone counts.')
    (args.folder / ('complete-audio-%d-analysis.json' % args.audio_stream)).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    assert result['passed'], 'Receiver audio continuity check failed; inspect preserved recording'


if __name__ == '__main__':
    main()
