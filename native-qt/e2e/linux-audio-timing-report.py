#!/usr/bin/env python3
"""Summarize bounded native selected-app audio timing metadata; no PCM analysis.

Positive arrival age means a block's assigned first-sample time precedes its
arrival. Output age includes the intentional mixing hold plus scheduling. These
observations describe one workload and do not by themselves establish a safe
hold for other devices, multiple streams, recovery, or CPU load.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import statistics


def summary(values):
    ordered = sorted(values)
    assert ordered
    return {'count': len(ordered), 'minimum': ordered[0], 'median': statistics.median(ordered),
            'p95': ordered[min(len(ordered)-1, int(len(ordered)*.95))],
            'p99': ordered[min(len(ordered)-1, int(len(ordered)*.99))], 'maximum': ordered[-1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    workflow = json.loads((args.report/'results.json').read_text())
    assert workflow['traceAudio'] and workflow['diagnosticOnly']
    raw = (args.report/'linux-audio-timing.csv').read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    assert sha == workflow['audioTrace']['sha256']
    lines = raw.decode().splitlines()
    end = re.fullmatch(r'# end rows=(\d+) truncated=0 write_error=0', lines[-1])
    assert end, 'Missing complete native trace footer or trace truncated/write failed'
    reader = csv.DictReader(io.StringIO('\n'.join(lines[:-1])))
    expected = ['stage','now100ns','wallMs','estimated100ns','assigned100ns','frames','stream',
                'latencyUs','negative','timed','reset','kept','coveredFrames','outputFrame','activeTaps']
    assert reader.fieldnames == expected
    rows = []
    for raw_row in reader:
        assert raw_row['stage'] in ('input', 'output') and None not in raw_row
        rows.append({'stage': raw_row['stage'], **{k: int(raw_row[k]) for k in expected[1:]}})
    assert 0 < len(rows) == int(end.group(1)) <= 100000
    assert all(b['now100ns'] >= a['now100ns'] for a, b in zip(rows, rows[1:]))
    inputs = [r for r in rows if r['stage'] == 'input']
    outputs = [r for r in rows if r['stage'] == 'output']
    assert inputs and outputs
    assert all(r['frames'] > 0 and 0 <= r['activeTaps'] <= 64 for r in rows)
    assert all(0 <= r['coveredFrames'] <= r['frames']*r['activeTaps'] for r in outputs)
    start = rows[0]['now100ns']
    later_inputs = [r for r in inputs if r['now100ns']-start >= 20000000]
    later_outputs = [r for r in outputs if r['now100ns']-start >= 20000000]
    age = lambda row: (row['now100ns']-row['assigned100ns'])/10000
    result = {'scope': __doc__, 'traceComplete': True, 'traceSha256': sha, 'rows': len(rows),
              'inputBlocks': len(inputs), 'outputBlocks': len(outputs),
              'observedSeconds': (rows[-1]['now100ns']-start)/10000000,
              'inputArrivalAgeMs': summary([age(r) for r in inputs]),
              'inputArrivalAgeAfter2sMs': summary([age(r) for r in later_inputs]),
              'inputEstimatedAgeMs': summary([(r['now100ns']-r['estimated100ns'])/10000 for r in inputs]),
              'outputAgeMs': summary([age(r) for r in outputs]),
              'outputAgeAfter2sMs': summary([age(r) for r in later_outputs]),
              'clockAnchorsIncludingInitial': sum(r['reset'] for r in inputs),
              'untimedInputBlocks': sum(not r['timed'] for r in inputs),
              'discardedInputBlocks': sum(not r['kept'] for r in inputs),
              'discardedInputBlocksAfter2s': sum(not r['kept'] for r in later_inputs),
              'uncoveredTapFramesAfter2s': sum(r['frames']*r['activeTaps']-r['coveredFrames'] for r in later_outputs),
              # The former fixed 20 ms hold emitted 10 ms chunks at >=30 ms
              # age. A 1 ms margin excludes timestamp/rounding boundary effects.
              'outputBlocksYoungerThan29ms': sum(age(r) < 29 for r in outputs),
              'earlyOutputBlocksWithIncompleteCoverage': sum(age(r) < 29 and r['coveredFrames'] < r['frames']*r['activeTaps'] for r in outputs),
              'maximumActiveTaps': max(r['activeTaps'] for r in rows)}
    with (args.report/'linux-audio-timing.json').open('x') as out:
        json.dump(result, out, indent=2)
        out.write('\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
