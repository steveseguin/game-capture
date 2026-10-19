#!/usr/bin/env python3
"""Audit a completed macos-window-publish.js endurance report.

This analyzes retained packaged-application evidence; it does not launch a new
application workflow. Run only after the publisher and observer have exited.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics


def sha(data):
    return hashlib.sha256(data).hexdigest()


def describe(values):
    return dict(first=values[0], last=values[-1], minimum=min(values),
                maximum=max(values), median=statistics.median(values))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--expected-executable-sha256', required=True)
    parser.add_argument('--expected-seconds', type=int, default=1800)
    args = parser.parse_args()
    if args.expected_seconds <= 0 or args.expected_seconds % 10:
        parser.error('--expected-seconds must be a positive multiple of ten')
    if len(args.expected_executable_sha256) != 64 or any(
            c not in '0123456789abcdef' for c in args.expected_executable_sha256):
        parser.error('Supply a lowercase SHA-256 from the intended release artifact')
    if args.output.exists():
        parser.error('Refusing to overwrite an audit')

    content = args.report.read_bytes()
    data = json.loads(content)
    errors = []

    def require(condition, message, elapsed=None):
        if not condition:
            errors.append(dict(check=message, elapsed=elapsed))

    require(data['executableSha256'] == args.expected_executable_sha256, 'artifact hash')
    require(data['passed'] is True, 'completed application workflow passed')
    require(data['requested']['performanceSeconds'] == args.expected_seconds, 'requested duration')
    require(data['requested'].get('continuousAudio') is True, 'continuous audio enabled')
    cases = []
    for case in data['cases']:
        performance = case['performance']
        chunks = performance['chunks']
        require(case.get('functionalPassed') is True, 'post-endurance functional controls')
        require(not performance.get('failedIntervals'), 'no retained failed intervals')
        require([c['elapsed'] for c in chunks] == list(range(0, args.expected_seconds, 10)),
                'complete ordered interval coverage')
        frame_count = audio_windows = audio_frames = wraps = 0
        last_audio_frame = None
        evidence = []
        for chunk in chunks:
            elapsed = chunk['elapsed']
            binding = chunk['evidence']
            path = (args.report.parent / binding['path']).resolve()
            if path.parent != args.report.parent.resolve():
                raise ValueError('Evidence escaped report directory')
            compressed = path.read_bytes()
            raw_bytes = gzip.decompress(compressed)
            require(sha(compressed) == binding['sha256'], 'compressed evidence hash', elapsed)
            require(sha(raw_bytes) == binding['uncompressedSha256'], 'raw evidence hash', elapsed)
            raw = json.loads(raw_bytes)
            require(raw['elapsed'] == elapsed, 'interval identity', elapsed)
            observation = raw['observation']
            frames = observation['observations']
            frame_count += len(frames)
            require(not observation.get('observerError'), 'decoded observer error', elapsed)
            require(observation.get('identityReadFailures') == 0, 'readable frame identities', elapsed)
            require(observation.get('rowDisagreements') == 0, 'barcode row agreement', elapsed)
            require(any(t.get('codec', '').lower() == 'video/h264' for t in observation['tracks']),
                    'received H.264', elapsed)
            steps = [(b['id'] - a['id']) % 65536 for a, b in zip(frames, frames[1:])]
            require(all(step <= 90 for step in steps), 'ordered bounded frame progression', elapsed)
            wraps += sum(a['id'] > 65000 and b['id'] < 500 for a, b in zip(frames, frames[1:]))
            seconds = (observation['ended'] - observation['started']) / 1000
            if seconds <= 0 or len(frames) < 2:
                raise ValueError('Missing decoded timing observations')
            source_count = len({f['id'] for f in raw['sourceFrames']})
            received_count = len({f['id'] for f in frames})
            fps = data['requested']['fps']
            expected = min(source_count, fps * seconds)
            ratio = received_count / expected if expected else 0
            gaps = sorted((b['mediaTime'] - a['mediaTime']) * 1000 for a, b in zip(frames, frames[1:]))
            p95 = gaps[math.floor(len(gaps) * .95)]
            require(all(g > 0 for g in gaps), 'increasing received timestamps', elapsed)
            require(source_count / seconds >= fps * .95 and ratio >= .95 and p95 <= 2000 / fps + 2,
                    'recomputed source/cadence/delivery target', elapsed)
            for key, value in [('sourceDistinct', source_count), ('receivedDistinct', received_count),
                               ('receivedFps', received_count / seconds), ('deliveryRatio', ratio),
                               ('p95MediaGapMs', p95)]:
                require(abs(chunk[key] - value) < 1e-7, 'reproduced ' + key, elapsed)
            require((observation['width'], observation['height']) ==
                    (data['requested']['width'], data['requested']['height']), 'received dimensions', elapsed)
            require(chunk['audioCheck']['passed'] and chunk['continuousAudioCheck']['passed'],
                    'live audio assertions', elapsed)
            batch = raw['continuousAudioObservation']
            require(batch['previousEndFrame'] == last_audio_frame, 'audio continuity across intervals', elapsed)
            require(batch['state'] == 'running' and batch['trackState'] == 'live' and not batch['error'],
                    'audio observer active', elapsed)
            batch_seconds = sum(row['frames'] for row in batch['rows']) / batch['sampleRate']
            require(batch_seconds >= 9.65 and
                    abs(batch_seconds - (batch['ended'] - batch['started']) / 1000) <= .35,
                    'recomputed continuous audio duration', elapsed)
            for row in batch['rows']:
                if last_audio_frame is not None:
                    require(row['frame'] == last_audio_frame, 'contiguous PCM windows', elapsed)
                last_audio_frame = row['frame'] + row['frames']
                audio_windows += 1
                audio_frames += row['frames']
                require(row['frames'] == 4800 and batch['sampleRate'] == 48000,
                        '100 ms stereo observation windows', elapsed)
                require(not any(row[k] for k in ['clipped', 'missing', 'invalid']), 'valid unclipped PCM', elapsed)
                require(all(v >= .001 for v in row['rms']), 'no silent channel', elapsed)
                amplitudes = row['amplitude']
                require(all(channel[i] >= .005 and channel[i] >= 10 * channel[1-i]
                            and channel[2] <= channel[i] / 10**(25/20)
                            for i, channel in enumerate(amplitudes)), 'stereo tones and application isolation', elapsed)
            evidence.append(dict(path=binding['path'], sha256=binding['sha256'],
                                 uncompressedSha256=binding['uncompressedSha256']))
        samples = performance['samples']
        if not samples:
            raise ValueError('Missing publisher resource samples')
        counters = {name: max(s['video'][name] for s in samples)
                    for name in ['encode_failures', 'encode_hard_failures', 'encode_timeouts', 'send_failures']}
        require(not any(counters.values()), 'no sustained encode/send failures')
        require(audio_frames / 48000 >= args.expected_seconds - .35,
                'continuous audio spans requested duration')
        require(all(s['video']['hardware_encoder'] == (case['encoder'] == 'videotoolbox')
                    and s['video']['active_codec'] == 'H.264' for s in samples),
                'requested hardware/software H.264 path remains active')
        dimensions = {}
        for label, prefix in [('sourceCaptureDimensions', 'last_capture'),
                              ('encodedDimensions', 'last_sent')]:
            observed = sorted({(s['video'][prefix + '_width'], s['video'][prefix + '_height'])
                               for s in samples})
            require(all(w > 0 and h > 0 for w, h in observed), 'valid ' + label)
            dimensions[label] = [dict(width=w, height=h) for w, h in observed]
        require(dimensions['encodedDimensions'] == [dict(width=data['requested']['width'],
                                                        height=data['requested']['height'])],
                'publisher output dimensions remain requested size')
        recording = case['independentAudioRecording']
        audio_path = args.report.parent / recording['path']
        if audio_path.resolve().parent != args.report.parent.resolve():
            raise ValueError('Recording escaped report directory')
        require(sha(audio_path.read_bytes()) == recording['sha256'], 'independent audio recording hash')
        cases.append(dict(encoder=case['encoder'], intervals=len(chunks), observedFrames=frame_count,
                          continuousAudioWindows=audio_windows, identityWraps=wraps, failureCounts=counters,
                          continuousAudioSeconds=audio_frames / 48000,
                          receivedFps=describe([c['receivedFps'] for c in chunks]),
                          **dimensions,
                          publisherRssMiB=describe([s['rssKiB']/1024 for s in samples]),
                          wholeHostCpuPercent=describe([s['system']['cpu_percent'] for s in samples]),
                          independentAudioRecording=recording, evidence=evidence))
    require(bool(cases), 'at least one completed case')
    require(args.report.read_bytes() == content, 'completed report unchanged during audit')
    result = dict(scope=__doc__, applicationReportSha256=sha(content),
                  expectedExecutableSha256=args.expected_executable_sha256,
                  cases=cases, errors=errors, passed=not errors)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as output:
        output.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(output=str(args.output), passed=result['passed'], errors=errors)))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
