#!/usr/bin/env python3
"""Independently inspect recorded received audio and verify interval evidence.

Run after the application workflow finishes. Decoding is streamed in 100 ms
blocks so a long recording does not require gigabytes of memory. This is an
offline evidence check, not a separate application workflow or A/V-sync test.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading

import numpy as np


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(report, case, ffmpeg):
    performance = case['performance']
    intervals = sorted(performance['chunks'] + performance.get('failedIntervals', []), key=lambda c: c['elapsed'])
    evidence = {'intervals': 0, 'windows': 0, 'clockGaps': 0, 'failedIntervals': [], 'errors': []}
    previous, first_wall, last_wall, observed_seconds = None, None, None, 0.
    for interval in intervals:
        spec = interval['evidence']
        compressed = (report/spec['path']).read_bytes()
        assert digest(compressed) == spec['sha256'], 'Compressed evidence changed'
        raw = gzip.decompress(compressed)
        assert digest(raw) == spec['uncompressedSha256'], 'Raw evidence changed'
        chunk = json.loads(raw)
        for key, value in interval.items():
            if key not in ('evidence', 'error'):
                assert chunk[key] == value, 'Interval summary differs: ' + key
        batch = chunk['continuousAudioObservation']
        if first_wall is None:
            first_wall = batch['started']
        last_wall = batch['ended']
        if previous is not None and previous != batch['previousEndFrame']:
            evidence['errors'].append('Observer boundary differs from preceding interval')
        for row in batch['rows']:
            evidence['clockGaps'] += int(previous is not None and row['frame'] != previous)
            previous = row['frame'] + row['frames']
            observed_seconds += row['frames']/batch['sampleRate']
            evidence['windows'] += 1
        if not chunk.get('meetsTarget', False):
            evidence['failedIntervals'].append(chunk['elapsed'])
        evidence['intervals'] += 1
    evidence['observedSeconds'] = observed_seconds
    evidence['wallSeconds'] = (last_wall-first_wall)/1000 if first_wall is not None else 0.
    evidence['clockCoverageDeltaSeconds'] = observed_seconds-evidence['wallSeconds']
    if not evidence['windows'] or abs(evidence['clockCoverageDeltaSeconds']) > .35:
        evidence['errors'].append('Continuous observer total clock coverage differs from wall time')
    recording = case['independentAudioRecording']
    file = report/recording['path']
    assert digest(file.read_bytes()) == recording['sha256'], 'Independent recording changed'
    # Evaluate all complete windows except explicitly recorded codec startup and
    # final padding. Keep the raw stream and first two rejected blocks on disk.
    rate, size = 48000, 4800
    indices = np.arange(size)
    basis = np.exp(-2j*np.pi*np.outer([440, 880, 2000], indices)/rate)
    statistics = {'windows': 0, 'analyzedWindows': 0, 'silentWindows': 0, 'clippedSamples': 0,
                  'nonfiniteSamples': 0, 'toneWindowsRejected': 0, 'badWindows': [], 'minimumRms': [1., 1.]}
    sample_count, pending = 0, None
    def block(pcm, index):
        if index < 10:  # One second at recording start; included in raw evidence.
            return
        statistics['analyzedWindows'] += 1
        finite = np.isfinite(pcm)
        invalid = int(np.count_nonzero(~finite))
        values = np.where(finite, pcm, 0).astype(np.float64)
        rms = np.sqrt(np.mean(values**2, axis=0))
        amplitude = 2*np.abs(basis @ values).T/size
        silent = bool(np.min(rms) < .001)
        clipped = int(np.count_nonzero(np.abs(values) >= .999))
        tone_bad = any(amplitude[ch, ch] < .005 or amplitude[ch, ch] < 10*amplitude[ch, 1-ch]
                       or amplitude[ch, 2] > amplitude[ch, ch]/10**(25/20) for ch in range(2))
        statistics['minimumRms'] = np.minimum(statistics['minimumRms'], rms).tolist()
        statistics['silentWindows'] += int(silent)
        statistics['clippedSamples'] += clipped
        statistics['nonfiniteSamples'] += invalid
        statistics['toneWindowsRejected'] += int(tone_bad)
        if silent or clipped or invalid or tone_bad:
            bad = {'window': index, 'secondsFromDecodedStart': index/10, 'rms': rms.tolist(),
                   'amplitude': amplitude.tolist(), 'silent': silent, 'clippedSamples': clipped, 'nonfiniteSamples': invalid}
            if len(statistics['badWindows']) < 2:
                path = file.with_name(file.stem+'-rejected-'+str(index)+'.f32le')
                with path.open('xb') as output:
                    output.write(pcm.tobytes())
                bad['pcm'] = {'path': path.name, 'sha256': digest(pcm.tobytes()), 'format': '48000 Hz interleaved stereo float32 little endian'}
            statistics['badWindows'].append(bad)
    logfile = file.with_suffix('.continuous-decode.log.gz')
    frames, log_errors = [], []
    with gzip.open(logfile, 'xb') as log:
        decoder = subprocess.Popen([ffmpeg, '-hide_banner', '-copyts', '-i', str(file), '-map', '0:a:0',
            '-af', 'aresample=48000,asettb=1/48000,ashowinfo', '-ac', '2', '-ar', str(rate), '-f', 'f32le', '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def drain_log():
            try:
                for line in decoder.stderr:
                    log.write(line)
                    if match := re.search(rb'\[Parsed_ashowinfo[^\]]*\].*?pts:(-?\d+)\s.*?nb_samples:(\d+)', line):
                        frames.append((int(match[1])/rate, int(match[2])))
            except Exception as error:
                log_errors.append(repr(error))
                decoder.kill()
        reader = threading.Thread(target=drain_log)
        reader.start()
        try:
            while raw := decoder.stdout.read(size*2*4):
                assert len(raw) % 8 == 0, 'Partial audio sample'
                sample_count += len(raw)//8
                if len(raw) != size*8:
                    break
                pcm = np.frombuffer(raw, '<f4').reshape(size, 2)
                if pending is not None:
                    block(pending, statistics['windows']-1)
                pending = pcm
                statistics['windows'] += 1
            assert decoder.wait(timeout=10) == 0, 'Independent audio decode failed'
        finally:
            if decoder.poll() is None:
                decoder.kill()
                decoder.wait()
            decoder.stdout.close()
            reader.join(timeout=10)
            decoder.stderr.close()
            assert not reader.is_alive() and not log_errors, 'Could not preserve decoder evidence'
    assert frames and sum(n for _, n in frames) == sample_count, 'Decoded audio PTS/sample count mismatch'
    statistics['maximumPtsDiscontinuityMs'] = max((abs(b[0]-a[0]-a[1]/rate)*1000 for a, b in zip(frames, frames[1:])), default=0)
    statistics['decodedSeconds'] = sample_count/rate
    statistics['recordingWallSeconds'] = (recording['ended']-recording['started'])/1000
    statistics['excludedEdgeWindows'] = 'First ten complete 100 ms windows and final complete/partial window'
    statistics['pcmContentPassed'] = bool(statistics['analyzedWindows'] > 0 and not any(statistics[key] for key in
        ['silentWindows', 'clippedSamples', 'nonfiniteSamples', 'toneWindowsRejected']))
    statistics['recordingClockPassed'] = bool(statistics['maximumPtsDiscontinuityMs'] <= 3+1e-6 and
        abs(statistics['decodedSeconds']-statistics['recordingWallSeconds']) < .5)
    statistics['passed'] = statistics['pcmContentPassed'] and statistics['recordingClockPassed']
    statistics['scope'] = 'Decoded recording PCM and its container clock checked separately; recorder gaps do not identify a publisher defect. Continuous received playback uses the separate worklet evidence.'
    evidence['passed'] = not (evidence['clockGaps'] or evidence['errors'] or evidence['failedIntervals'])
    return {'encoder': case['encoder'], 'intervalEvidence': evidence, 'independentRecording': statistics,
            'passed': bool(evidence['passed'] and statistics['passed'] and case['passed'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--ffmpeg', default='/opt/homebrew/bin/ffmpeg')
    args = parser.parse_args()
    source = args.report/'results.json'
    workflow = json.loads(source.read_text())
    result = {'scope': __doc__, 'resultsSha256': digest(source.read_bytes()), 'analyzerSha256': digest(Path(__file__).read_bytes()),
              'passed': False, 'cases': []}
    try:
        for case in workflow['cases']:
            result['cases'].append(inspect(args.report, case, args.ffmpeg))
        result['passed'] = bool(result['cases']) and all(c['passed'] for c in result['cases'])
    except Exception as error:
        result['error'] = repr(error)
        raise
    finally:
        with (args.report/'continuous-audio-analysis.json').open('x') as out:
            json.dump(result, out, indent=2)
            out.write('\n')
    print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
