"""Compare corresponding source/receiver pulses recorded by one OBS clock.

First run analyze-obs-quality.py twice: --half=left --audio-stream=0, then
--half=right --audio-stream=1. Both analyses must come from --sync-pair=true.
"""
import argparse
import json
from pathlib import Path
import statistics

import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('--maximum-skew-ms', type=float, default=50)
    parser.add_argument('--start-seconds', type=float, default=0)
    args = parser.parse_args()
    suffix = '-%gs' % args.start_seconds if args.start_seconds else ''
    metadata = json.loads((args.folder / 'obs-receiver.json').read_text())
    assert metadata.get('pairedReference'), 'A simultaneous reference recording is required'
    source = json.loads((args.folder / ('obs-analysis' + suffix + '-left.json')).read_text())
    receiver = json.loads((args.folder / ('obs-analysis' + suffix + '-right.json')).read_text())
    assert source['recording'] == receiver['recording'] == metadata['recording']
    for key in ['startSeconds', 'durationSeconds']:
        assert source['selection'].get(key) == receiver['selection'].get(key), 'Mismatched analysis windows'
    assert source['mediaPassed'] and receiver['mediaPassed']
    pairs = []
    for remote in receiver['pulsePairs']:
        if remote['audioSeconds'] < 10:
            continue
        if 'sourcePulseId' in remote:
            matches = [p for p in source['pulsePairs'] if p.get('sourcePulseId') == remote['sourcePulseId']]
            if len(matches) != 1:
                continue
            local = matches[0]
        else:
            local = min(source['pulsePairs'], key=lambda p: abs(p['audioSeconds'] - remote['audioSeconds']))
            if abs(local['audioSeconds'] - remote['audioSeconds']) >= 1:
                continue
        pairs.append({
            'atSeconds': remote['audioSeconds'],
            'additionalOffsetMs': remote['offsetMs'] - local['offsetMs'],
            'additionalSourceClockOffsetMs': remote.get('sourceClockOffsetMs',remote['offsetMs']) - local.get('sourceClockOffsetMs',local['offsetMs']),
            'additionalAudioDelayMs': 1000 * (remote['audioSeconds'] - local['audioSeconds']),
            'additionalVideoDelayMs': 1000 * (remote.get('sourceClockVideoSeconds',remote['videoSeconds']) - local.get('sourceClockVideoSeconds',local['videoSeconds'])),
        })
    assert len(pairs) >= 20, 'Too few corresponding steady playback pulses'
    result = {'pairs': pairs, 'maximumAllowedSkewMs': args.maximum_skew_ms,
              'startSeconds': args.start_seconds,
              'limitations': f"Relative to simultaneous OBS source capture; {source.get('analysisFps', 30)}-fps video and 10-ms audio windows. Not physical playback latency."}
    for key in ['additionalOffsetMs', 'additionalSourceClockOffsetMs', 'additionalAudioDelayMs', 'additionalVideoDelayMs']:
        values = [pair[key] for pair in pairs]
        result[key] = {'n': len(values), 'median': statistics.median(values),
                       'min': min(values), 'max': max(values), 'p95': float(np.percentile(values, 95))}
    result['passed'] = all(abs(pair['additionalOffsetMs']) <= args.maximum_skew_ms + 1e-6 for pair in pairs)
    (args.folder / ('paired-sync-analysis' + suffix + '.json')).write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key != 'pairs'}, indent=2))
    assert result['passed'], 'Simultaneous output synchronization exceeded the allowed skew'


if __name__ == '__main__':
    main()
