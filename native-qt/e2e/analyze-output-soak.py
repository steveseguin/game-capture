"""Summarize actual packaged playback and process observations over a long run."""
import argparse
import json
import statistics
from pathlib import Path

import numpy as np


def distribution(values):
    return dict(min=min(values), median=statistics.median(values), max=max(values),
                p95=float(np.percentile(values, 95))) if values else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('--minimum-seconds', type=float, default=7200)
    args = parser.parse_args()
    report = json.loads((args.folder / 'results.json').read_text())
    results = []
    for case in report['cases']:
        folder = args.folder / case['id']
        resources = [json.loads(line) for line in (folder / 'resources.jsonl').read_text().splitlines()]
        samples = [json.loads(line) for line in (folder / 'playback-samples.jsonl').read_text().splitlines()]
        events = json.loads((folder / 'resources.events.json').read_text())
        errors = [row for row in samples if 'error' in row]
        valid = [row for row in samples if 'diagnostics' in row]
        start = resources[0]['time']
        steady = [row for row in resources if row['time'] >= start + 60]
        early = [row for row in steady if row['time'] <= start + 300]
        late = [row for row in steady if row['time'] >= resources[-1]['time'] - 300]
        playback = [row for row in valid if row['wall'] >= valid[0]['wall'] + 60000]
        assert early and late and len(playback) > 2, 'Insufficient actual observations'
        duration = (valid[-1]['wall'] - valid[0]['wall']) / 1000
        private_growth = (statistics.median(r['private'] for r in late) -
                          statistics.median(r['private'] for r in early)) / 1048576
        handles_growth = statistics.median(r['handles'] for r in late) - statistics.median(r['handles'] for r in early)
        hours = [(r['time'] - start) / 3600 for r in steady]
        memory_slope = float(np.polyfit(hours, [r['private'] / 1048576 for r in steady], 1)[0])
        tracks = []
        for kind in ['audio', 'video']:
            observations = []
            for row in playback:
                track = next((r for r in row.get('browser', []) if r.get('kind') == kind), None)
                if track:
                    observations.append((row['wall'], track))
            assert len(observations) == len(playback), 'Missing actual browser track observations'
            first, last = observations[0][1], observations[-1][1]
            counters = ['packetsLost', 'framesDecoded', 'framesDropped', 'freezeCount',
                        'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples']
            delta = {k: last[k] - first[k] for k in counters if k in first and k in last}
            resets = sum(x[1]['id'] != y[1]['id'] for x, y in zip(observations, observations[1:]))
            fps = [(y[1]['framesDecoded'] - x[1]['framesDecoded']) * 1000 / (y[0] - x[0])
                   for x, y in zip(observations, observations[1:]) if 'framesDecoded' in x[1] and 'framesDecoded' in y[1]]
            tracks.append(dict(kind=kind, counterDelta=delta, trackResets=resets, intervalDecodedFps=distribution(fps)))
        obs_delta = {k: playback[-1]['obs'][k] - playback[0]['obs'][k]
                     for k in ['renderSkippedFrames', 'outputSkippedFrames', 'renderTotalFrames', 'outputTotalFrames']}
        result = dict(id=case['id'], elapsedSeconds=duration, sampleErrors=errors,
                      largestPlaybackSampleGapSeconds=max((y['wall'] - x['wall']) / 1000 for x, y in zip(valid, valid[1:])),
                      publisherPrivateMiB=distribution([r['private'] / 1048576 for r in steady]),
                      publisherRssMiB=distribution([r['rss'] / 1048576 for r in steady]),
                      privateMedianGrowthMiB=private_growth, privateSlopeMiBPerHour=memory_slope,
                      handles=distribution([r['handles'] for r in steady]), handleMedianGrowth=handles_growth,
                      threads=distribution([r['threads'] for r in steady]),
                      cpuPercentOneCore=distribution([r['cpuPercentOneCore'] for r in steady]),
                      soundCalls=[r for r in events if r.get('kind') == 'sound'],
                      observerErrors=[r for r in events if r.get('type') == 'error'],
                      tracks=tracks, obsCounterDelta=obs_delta,
                      obsCpuPercent=distribution([r['obs']['cpuUsage'] for r in playback]),
                      obsMemoryMiB=distribution([r['obs']['memoryUsage'] for r in playback]),
                      reconnects=case['lastDiagnostics']['output']['reconnects'], shutdown=case['shutdown'])
        result['resourceBoundsPassed'] = private_growth <= 32 and handles_growth <= 10 and memory_slope <= 16
        result['playbackPassed'] = (not errors and all(r['diagnostics']['output']['state'] == 2 for r in valid)
            and result['reconnects'] == 0 and all(t['trackResets'] == 0 for t in tracks)
            and all(t['counterDelta'].get(k, 0) == 0 for t in tracks for k in ['packetsLost', 'freezeCount', 'framesDropped'])
            and tracks[1]['intervalDecodedFps']['median'] >= 55
            and obs_delta['renderSkippedFrames'] == 0 and obs_delta['outputSkippedFrames'] == 0)
        result['passed'] = (duration >= args.minimum_seconds and result['resourceBoundsPassed']
            and result['playbackPassed'] and not result['soundCalls'] and not result['observerErrors']
            and case.get('transportPassed') and not case['shutdown']['forced'] and case['shutdown']['exitCode'] == 0)
        results.append(result)
    output = dict(publisherSha256=report['sha256'], cases=results, passed=all(r['passed'] for r in results),
        limits='Observed bounds for a finite run, not proof of leak freedom. CPU percentage uses one logical core. '
               'GPU allocations are not measured. A/V drift and audio discontinuities require separate recorded-media analysis. '
               'Steady playback/resource observations exclude the first 60 seconds; full raw startup evidence is retained.')
    (args.folder / 'soak-analysis.json').write_text(json.dumps(output, indent=2), encoding='utf-8')
    print(json.dumps(output, indent=2))
    assert output['passed'], 'Long playback/resource qualification failed; inspect preserved observations'


if __name__ == '__main__':
    main()
