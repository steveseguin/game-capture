#!/usr/bin/env python3
"""Analyze same-host source-draw to decoded-track delivery from packaged workflows.

This includes capture, encoding, transport, receiver buffering and observer queue
delay. It is not isolated encoder time, physical display latency or A/V sync.
Clock origins must be recorded explicitly; never infer them from the last frame.
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


def finite(value):
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Missing or nonfinite clock value')
    return value


def stats(values):
    ordered = sorted(values)
    if not ordered:
        raise ValueError('No matched latency observations')
    def percentile(fraction):
        return ordered[max(0, math.ceil(len(ordered)*fraction)-1)]
    return {'count': len(values), 'minimumMs': ordered[0], 'medianMs': statistics.median(ordered),
            'meanMs': statistics.mean(ordered), 'p95Ms': percentile(.95),
            'p99Ms': percentile(.99), 'maximumMs': ordered[-1]}


def analyze(chunk):
    observation = chunk['observation']
    if observation['method'] != 'MediaStreamTrackProcessor':
        raise ValueError('Requires decoded-track observations')
    if observation['identityReadFailures'] or observation['rowDisagreements']:
        raise ValueError('Picture identity is not reliable in this interval')
    clock = observation.get('clock')
    if not clock or 'timeOrigin' not in clock or 'sourceClock' not in chunk:
        raise ValueError('Missing recorded browser clock origin/source cross-check; historical timing cannot be inferred')
    origin = finite(clock['timeOrigin'])
    samples = [clock[k] for k in ('start', 'end')]
    samples += [chunk['sourceClock'][k] for k in ('start', 'end')]
    offsets = [finite(s['epochMs'])-finite(s['wallMs']) for s in samples]
    # Date.now() has millisecond granularity. This is a cross-check of epoch
    # alignment, not a calibrated bound on physical end-to-end measurement.
    if max(map(abs, offsets)) > 2 or max(offsets)-min(offsets) > 2:
        raise ValueError('Browser epoch/wall-clock cross-check exceeds 2 ms')
    source = {}
    previous = -math.inf
    for frame in chunk['sourceFrames']:
        identity, timestamp = frame['id'], finite(frame['time'])
        if not isinstance(identity, int) or not 0 <= identity <= 65535:
            raise ValueError('Invalid source identity')
        if identity in source or timestamp <= previous:
            raise ValueError('Ambiguous source identity or nonmonotonic source clock')
        source[identity] = timestamp
        previous = timestamp
    # Trace collection begins anew each interval. Exclude its first two seconds
    # explicitly, so pre-existing in-flight images cannot bias matching. Any
    # unmatched identity after this boundary is an error, never silently dropped.
    boundary = finite(observation['started'])+2000
    end = finite(observation['ended'])
    matched, seen = [], set()
    excluded = duplicates = 0
    previous = -math.inf
    for frame in observation['observations']:
        relative = finite(frame['receivedTime'])
        arrival = origin+relative
        processed = finite(frame['time'])
        if arrival < previous or processed < relative or arrival > end+1:
            raise ValueError('Nonmonotonic or inconsistent receiver observation')
        previous = arrival
        if arrival < boundary:
            excluded += 1
            continue
        identity = frame['id']
        if identity not in source:
            raise ValueError('Unmatched identity after the explicit interval boundary')
        delta = arrival-source[identity]
        if delta < -2:
            raise ValueError('Receiver appears to precede source draw')
        if identity in seen:
            duplicates += 1
            continue
        seen.add(identity)
        matched.append({'id': identity, 'sourceEpochMs': source[identity],
                        'receivedEpochMs': arrival, 'latencyMs': delta,
                        'identityProcessingMs': processed-relative})
    if len(matched) < 30:
        raise ValueError('Insufficient distinct matched images')
    return {'elapsed': chunk['elapsed'], 'boundaryExcludedFrames': excluded,
            'duplicateReceivedIdentities': duplicates, 'sourceFrames': len(source),
            'clockOffsetsMs': offsets, 'statistics': stats([m['latencyMs'] for m in matched]),
            'identityProcessing': stats([m['identityProcessingMs'] for m in matched]),
            'matches': matched}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Use a new output file; preserve earlier evidence')
    raw = (args.report/'results.json').read_bytes()
    workflow = json.loads(raw)
    result = {'scope': __doc__, 'workflowSha256': sha(raw),
              'analyzerSha256': sha(Path(__file__).read_bytes()),
              'executableSha256': workflow['executableSha256'],
              'applicationWorkflowPassed': workflow['passed'],
              'excludedStartOfEachIntervalMs': 2000, 'cases': [], 'passed': False}
    try:
        for case in workflow['cases']:
            current = {'encoder': case['encoder'], 'intervals': [], 'measurementPassed': False}
            result['cases'].append(current)
            for summary in case['performance']['chunks']:
                evidence = summary['evidence']
                path = (args.report/evidence['path']).resolve()
                if path.parent != args.report.resolve() or evidence['compression'] != 'gzip':
                    raise ValueError('Unexpected retained interval path or format')
                compressed = path.read_bytes()
                if sha(compressed) != evidence['sha256']:
                    raise ValueError('Retained interval hash mismatch')
                data = gzip.decompress(compressed)
                if sha(data) != evidence['uncompressedSha256']:
                    raise ValueError('Decoded interval hash mismatch')
                measured = analyze(json.loads(data))
                measured['evidence'] = evidence
                current['intervals'].append(measured)
            current['statistics'] = stats([m['latencyMs'] for interval in current['intervals']
                                           for m in interval['matches']])
            current['measurementPassed'] = True
        result['passed'] = bool(result['cases']) and workflow['passed'] and all(
            case['measurementPassed'] for case in result['cases'])
    except Exception as error:
        result['error'] = str(error)
    with args.output.open('x') as output:
        output.write(json.dumps(result, indent=2)+'\n')
    print(json.dumps({'passed': result['passed'], 'error': result.get('error'),
                      'cases': [{k: c.get(k) for k in ('encoder', 'measurementPassed', 'statistics')}
                                for c in result['cases']]}))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
