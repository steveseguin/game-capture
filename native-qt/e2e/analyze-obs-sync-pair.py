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
    args = parser.parse_args()
    metadata = json.loads((args.folder / 'obs-receiver.json').read_text())
    assert metadata.get('pairedReference'), 'A simultaneous reference recording is required'
    source = json.loads((args.folder / 'obs-analysis-left.json').read_text())
    receiver = json.loads((args.folder / 'obs-analysis-right.json').read_text())
    assert source['recording'] == receiver['recording'] == metadata['recording']
    assert source['mediaPassed'] and receiver['mediaPassed']
    pairs = []
    for remote in receiver['pulsePairs']:
        if remote['audioSeconds'] < 10:
            continue
        local = min(source['pulsePairs'], key=lambda p: abs(p['audioSeconds'] - remote['audioSeconds']))
        if abs(local['audioSeconds'] - remote['audioSeconds']) >= 1:
            continue
        pairs.append({
            'atSeconds': remote['audioSeconds'],
            'additionalOffsetMs': remote['offsetMs'] - local['offsetMs'],
            'additionalAudioDelayMs': 1000 * (remote['audioSeconds'] - local['audioSeconds']),
            'additionalVideoDelayMs': 1000 * (remote['videoSeconds'] - local['videoSeconds']),
        })
    assert len(pairs) >= 20, 'Too few corresponding steady playback pulses'
    result = {'pairs': pairs, 'maximumAllowedSkewMs': args.maximum_skew_ms,
              'limitations': 'Relative to simultaneous OBS source capture; 30-fps video and 10-ms audio windows. Not physical playback latency.'}
    for key in ['additionalOffsetMs', 'additionalAudioDelayMs', 'additionalVideoDelayMs']:
        values = [pair[key] for pair in pairs]
        result[key] = {'n': len(values), 'median': statistics.median(values),
                       'min': min(values), 'max': max(values), 'p95': float(np.percentile(values, 95))}
    result['passed'] = all(abs(pair['additionalOffsetMs']) <= args.maximum_skew_ms for pair in pairs)
    (args.folder / 'paired-sync-analysis.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key != 'pairs'}, indent=2))
    assert result['passed'], 'Simultaneous output synchronization exceeded the allowed skew'


if __name__ == '__main__':
    main()
