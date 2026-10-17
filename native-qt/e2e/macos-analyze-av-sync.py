#!/usr/bin/env python3
"""Measure paired software-source/received-media A/V timing, preserving PTS.

This measures paired pulse timing in recorded media, not physical display/speaker
latency or HTML/OBS presentation. Source calibration and receiver use the same
analysis. Browser recording timestamps can have gaps: map each detected sample
through its own decoded frame PTS, never through a presumed gapless PCM clock.
This does not establish continuous recording coverage between pulses.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

import numpy as np


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def analyze(file, ffmpeg):
    ffprobe = str(Path(ffmpeg).with_name('ffprobe'))
    frames = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-select_streams', 'v:0',
        '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(file)], timeout=60))['frames']
    timestamps = [float(f['best_effort_timestamp_time']) for f in frames]
    logfile = file.with_suffix('.video-decode.log')
    observations = []
    with logfile.open('xb') as log:
        process = subprocess.Popen([ffmpeg, '-v', 'error', '-copyts', '-i', str(file), '-map', '0:v:0',
            '-vf', 'scale=320:180', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
            stdout=subprocess.PIPE, stderr=log)
        try:
            for timestamp in timestamps:
                raw = process.stdout.read(320*180*3)
                if len(raw) != 320*180*3:
                    raise AssertionError('Missing decoded video frame')
                picture = np.frombuffer(raw, np.uint8).reshape(180, 320, 3)
                cyan = (picture[:, :, 0] < 70) & (picture[:, :, 1] > 170) & (picture[:, :, 2] > 170)
                magenta = (picture[:, :, 0] > 170) & (picture[:, :, 1] < 70) & (picture[:, :, 2] > 170)
                cy, cx = np.nonzero(cyan)
                my, mx = np.nonzero(magenta)
                observation = {'pts': timestamp, 'valid': False}
                if len(cx) > 20 and len(mx) > 20:
                    w = ((mx.min()+mx.max())/2-(cx.min()+cx.max())/2)/.86
                    h = (cy.max()-cy.min()+1)/.6
                    left = (cx.min()+cx.max())/2-.07*w
                    top = cy.min()-.2*h
                    def pixel(x, y):
                        ix, iy = round(left+x*w), round(top+y*h)
                        if not (0 <= ix < 320 and 0 <= iy < 180):
                            raise ValueError('Marker outside recording')
                        return int(picture[iy, ix, 0])
                    try:
                        stamp, valid = 0, True
                        for bit in range(24):
                            a, b = pixel(.15+(bit+.5)*.7/24, .5), pixel(.15+(bit+.5)*.7/24, .7)
                            va = 1 if a > 170 else 0 if a < 85 else -1
                            vb = 1 if b > 170 else 0 if b < 85 else -1
                            if va < 0 or vb < 0 or va == vb:
                                valid = False
                                break
                            stamp |= va << bit
                        if valid and stamp % 256 < 200:
                            observation.update(valid=True, pulseId=stamp >> 8, phaseMs=(stamp % 256)*10,
                                               flash=pixel(.5, .3) > 170)
                    except ValueError:
                        pass
                observations.append(observation)
            if process.stdout.read(1):
                raise AssertionError('Unexpected extra decoded video frames')
            if process.wait(timeout=10):
                raise AssertionError('Video decode failed')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
    pulses = []
    previous = None
    for frame in observations:
        if frame['valid'] and frame['flash'] and (not previous or not previous.get('flash') or previous.get('pulseId') != frame['pulseId']):
            # Subtract the encoded source phase to compensate video-frame onset
            # quantization, while retaining the unadjusted onset separately.
            pulses.append({'id': frame['pulseId'], 'videoSeconds': frame['pts'],
                           'videoClockSeconds': frame['pts']-frame['phaseMs']/1000, 'phaseMs': frame['phaseMs']})
        previous = frame
    decoded = subprocess.run([ffmpeg, '-hide_banner', '-copyts', '-i', str(file), '-map', '0:a:0',
        '-af', 'aresample=48000,asettb=1/48000,ashowinfo', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], capture_output=True, timeout=90)
    file.with_suffix('.audio-decode.log').write_bytes(decoded.stderr)
    if decoded.returncode:
        raise AssertionError('Audio decode failed')
    audio_frames = [(int(a)/48000, int(b)) for a, b in re.findall(
        r'\[Parsed_ashowinfo[^\]]*\].*?pts:(-?\d+)\s.*?nb_samples:(\d+)', decoded.stderr.decode(errors='replace'))]
    if not audio_frames:
        raise AssertionError('Audio PTS unavailable')
    pcm = np.frombuffer(decoded.stdout, '<f4').reshape(-1, 2)
    if len(pcm) != sum(f[1] for f in audio_frames) or not np.isfinite(pcm).all():
        raise AssertionError('Audio sample coverage mismatch')
    timeline_gaps = [1000*(b[0]-a[0]-a[1]/48000) for a, b in zip(audio_frames, audio_frames[1:])]
    maximum_gap = max(map(abs, timeline_gaps), default=0)
    nonmonotonic = sum(b[0] <= a[0] for a, b in zip(audio_frames, audio_frames[1:]))
    frame_ends = np.cumsum([frame[1] for frame in audio_frames])
    frame_starts = np.concatenate(([0], frame_ends[:-1]))
    def sample_time(index):
        frame = int(np.searchsorted(frame_ends, index, side='right'))
        return audio_frames[frame][0] + (index-int(frame_starts[frame]))/48000
    # Detect the 1 kHz pulse in successive 10 ms windows. A Hann window limits
    # leakage from the continuous 440/880 Hz stereo reference tones.
    n = len(pcm)//480
    window = np.hanning(480)
    spectrum = np.fft.rfft(pcm[:n*480, 0].reshape(n, 480)*window, axis=1)
    amplitude = 2*np.abs(spectrum[:, 10])/window.sum()
    active = amplitude > .03
    starts = np.flatnonzero(active & ~np.concatenate(([False], active[:-1])))
    beeps = [sample_time(int(i)*480+240) for i in starts
             if i+8 <= n and np.count_nonzero(active[i:i+8]) >= 6]
    pairs, used = [], set()
    for pulse in pulses:
        # Omit only recording-edge pulses; startup is retained in raw evidence.
        if pulse['videoSeconds'] < timestamps[0]+2 or pulse['videoSeconds'] > timestamps[-1]-2:
            continue
        candidates = [(abs(t-pulse['videoSeconds']), index, t) for index, t in enumerate(beeps)]
        if not candidates:
            continue
        distance, index, audio = min(candidates)
        if distance > .5 or index in used:
            continue
        used.add(index)
        pairs.append({**pulse, 'audioSeconds': audio, 'offsetMs': (audio-pulse['videoClockSeconds'])*1000,
                      'unadjustedOffsetMs': (audio-pulse['videoSeconds'])*1000})
    windows = len(pcm)//4800
    rms = np.sqrt(np.mean(pcm[:windows*4800].reshape(windows, 4800, 2)**2, axis=1))
    invalid = sum(not f['valid'] for f in observations)
    silent = int(np.count_nonzero(np.min(rms[10:-1], axis=1) < .001))
    clipped = int(np.count_nonzero(np.abs(pcm) >= .999))
    return {'file': file.name, 'sha256': digest(file), 'videoFrames': len(observations), 'invalidVideoFrames': invalid,
            'firstVideoPts': timestamps[0], 'firstAudioPts': audio_frames[0][0], 'audioFrames': len(pcm),
            'maximumAudioPtsDiscontinuityMs': maximum_gap, 'audioPulseCount': len(beeps), 'videoPulseCount': len(pulses),
            'nonmonotonicAudioFrames': nonmonotonic,
            'recordingClockContinuousWithin3ms': maximum_gap <= 3+1e-6,
            'silent100msWindowsAfterStartup': silent,
            'clippedSamples': clipped, 'pairs': pairs,
            'mediaPassed': bool(invalid/max(1, len(observations)) < .01 and nonmonotonic == 0 and len(pairs) >= 8 and silent == clipped == 0),
            'videoObservations': observations, 'audioPulseTimes': beeps}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--maximum-skew-ms', type=float, default=50)
    parser.add_argument('--maximum-drift-ms', type=float, default=30)
    args = parser.parse_args()
    workflow = json.loads((args.report/'results.json').read_text())
    result = {'passed': False, 'maximumSkewMs': args.maximum_skew_ms, 'maximumMedianDriftMs': args.maximum_drift_ms,
              'scope': __doc__, 'phases': [], 'longRunDriftQualified': False}
    try:
        for phase in workflow['phases']:
            for kind in ('source', 'receiver'):
                if digest(args.report/phase[kind]['path']) != phase[kind]['sha256']:
                    raise AssertionError('Recording changed after capture')
            source, receiver = [analyze(args.report/phase[k]['path'], args.ffmpeg) for k in ('source', 'receiver')]
            source_pairs = {p['id']: p for p in source['pairs']}
            pairs = [{'pulseId': p['id'], 'sourceOffsetMs': source_pairs[p['id']]['offsetMs'],
                      'receiverOffsetMs': p['offsetMs'], 'additionalOffsetMs': p['offsetMs']-source_pairs[p['id']]['offsetMs']}
                     for p in receiver['pairs'] if p['id'] in source_pairs]
            offsets = [p['additionalOffsetMs'] for p in pairs]
            passed = bool(source['mediaPassed'] and receiver['mediaPassed'] and len(pairs) >= max(8, workflow['seconds']//2-4)
                          and max(map(abs, offsets), default=float('inf')) <= args.maximum_skew_ms+1e-6)
            entry = {'name': phase['name'], 'source': source, 'receiver': receiver, 'pairs': pairs,
                     'medianAdditionalOffsetMs': float(np.median(offsets)) if offsets else None, 'passed': passed}
            result['phases'].append(entry)
        result['passed'] = bool(result['phases']) and all(p['passed'] for p in result['phases'])
        if len(result['phases']) == 2:
            medians = [p['medianAdditionalOffsetMs'] for p in result['phases']]
            result['medianDriftMs'] = medians[-1]-medians[0] if all(m is not None for m in medians) else None
            result['passed'] &= result['medianDriftMs'] is not None and abs(result['medianDriftMs']) <= args.maximum_drift_ms+1e-6
            result['longRunDriftQualified'] = bool(result['passed'] and workflow['holdSeconds']+workflow['seconds'] >= 1800)
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        with (args.report/'av-analysis.json').open('x') as out:
            json.dump(result, out, indent=2)
            out.write('\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'phases'}, indent=2))
    for p in result['phases']:
        print(json.dumps({k: p[k] for k in ['name', 'passed', 'medianAdditionalOffsetMs']}, indent=2))
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
