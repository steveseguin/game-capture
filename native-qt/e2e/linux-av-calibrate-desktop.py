#!/usr/bin/env python3
"""Validate the response of real A/V references to controlled stimulus delays.

Consumes three completed exact-package X11 workflows, not synthesized recordings.
This checks positive/negative delay response and the independent browser control.
It does not establish the absolute zero offset, physical latency, or application
A/V qualification. A 30 ms median-response tolerance covers one 60 Hz image period
plus the fixture's 10 ms phase quantization; it does not relax application limits.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import uuid


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def read_case(report, expected):
    report = report.resolve()
    workflow = json.loads((report/'results.json').read_text())
    assert workflow['backend'] == 'x11' and workflow['sourceReference'] == 'desktop'
    assert workflow['diagnosticOnly'] and not workflow['passed']
    assert workflow['fixtureTimingControl'] == expected
    assert workflow['recordingWorkflowPassed'] and workflow['audioCleanupPassed']
    assert not workflow.get('error') and not workflow.get('cleanupErrors')
    assert workflow['holdSeconds'] == 0 and workflow['seconds'] == 30
    assert len(workflow['samples']) == 6 and all(s['passed'] for s in workflow['samples'])
    for name, sha in workflow['harnesses'].items():
        assert Path(name).name == name and digest(report/name) == sha
    assert digest(report/'linux-av-source.html') == workflow['sourceFixtureSha256']
    for sample in workflow['samples']:
        assert Path(sample['file']).name == sample['file']
        assert digest(report/sample['file']) == sample['sha256']
    assert len(workflow['phases']) == 1
    for kind in ('source', 'browserSource', 'receiver'):
        recording = workflow['phases'][0][kind]
        assert Path(recording['path']).name == recording['path']
        assert digest(report/recording['path']) == recording['sha256']
    analysis = json.loads((report/'av-analysis.json').read_text())
    comparison = json.loads((report/'reference-comparison.json').read_text())
    assert analysis == workflow['analysis'] and comparison == workflow['referenceComparison']
    assert workflow['referenceComparisonExitCode'] == 0 and comparison['comparisonComplete']
    assert not comparison['calibrated'] and len(comparison['phases']) == 1
    return workflow, comparison['phases'][0], {
        'report': str(report), 'reportSha256': digest(report/'results.json'),
        'analysisSha256': digest(report/'av-analysis.json'),
        'comparisonSha256': digest(report/'reference-comparison.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--audio-delay', type=Path, required=True)
    parser.add_argument('--video-delay', type=Path, required=True)
    parser.add_argument('--reports', type=Path, required=True)
    args = parser.parse_args()
    destination = args.reports.resolve()/str(uuid.uuid4())
    destination.mkdir(parents=True, mode=0o700)
    shutil.copyfile(__file__, destination/Path(__file__).name)
    result = {'scope': __doc__, 'delayResponsePassed': False, 'absoluteTimingCalibrated': False,
              'maximumMedianResponseErrorMs': 30, 'cases': {}, 'comparisons': [],
              'analyzerSha256': digest(destination/Path(__file__).name)}
    try:
        cases = {}
        for name, report, expected in [
                ('zero', args.baseline, {'outputAudioDelayMs': 0, 'videoDelayMs': 0}),
                ('audio-delay', args.audio_delay, {'outputAudioDelayMs': 150, 'videoDelayMs': 0}),
                ('video-delay', args.video_delay, {'outputAudioDelayMs': 0, 'videoDelayMs': 150})]:
            workflow, phase, provenance = read_case(report, expected)
            cases[name] = workflow, phase
            result['cases'][name] = {**provenance, 'fixtureTimingControl': expected,
                'sourceMedianOffsetMs': statistics.median(p['desktopReferenceOffsetMs'] for p in phase['pairs']),
                'browserMedianOffsetMs': statistics.median(p['browserReferenceOffsetMs'] for p in phase['pairs'])}
        baseline, baseline_phase = cases['zero']
        baseline_pairs = {p['pulseId']: p for p in baseline_phase['pairs']}
        for name, desktop_expected, browser_expected in [('audio-delay', 150, 0), ('video-delay', -150, -150)]:
            workflow, phase = cases[name]
            for field in ('manifestSha256', 'executableSha256', 'harnesses', 'requested', 'browserVersion', 'sourceSize', 'defaultSink'):
                assert workflow[field] == baseline[field], f'Uncontrolled difference: {name} {field}'
            pairs = [{'pulseId': p['pulseId'],
                      'desktopDeltaMs': p['desktopReferenceOffsetMs']-baseline_pairs[p['pulseId']]['desktopReferenceOffsetMs'],
                      'browserDeltaMs': p['browserReferenceOffsetMs']-baseline_pairs[p['pulseId']]['browserReferenceOffsetMs']}
                     for p in phase['pairs'] if p['pulseId'] in baseline_pairs]
            assert len(pairs) >= 8, 'Insufficient common pulse identities'
            entry = {'case': name, 'pairs': pairs, 'passed': True}
            for kind, expected in [('desktop', desktop_expected), ('browser', browser_expected)]:
                measured = statistics.median(p[kind+'DeltaMs'] for p in pairs)
                error = measured-expected
                entry[kind] = {'expectedDeltaMs': expected, 'medianMeasuredDeltaMs': measured,
                               'medianResponseErrorMs': error}
                entry['passed'] &= abs(error) <= result['maximumMedianResponseErrorMs']
            result['comparisons'].append(entry)
        result['delayResponsePassed'] = all(c['passed'] for c in result['comparisons'])
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        with (destination/'calibration.json').open('x') as out:
            json.dump(result, out, indent=2)
            out.write('\n')
        print(json.dumps({'report': str(destination), 'delayResponsePassed': result['delayResponsePassed'],
                          'absoluteTimingCalibrated': False, 'error': result.get('error')}))
    if not result['delayResponsePassed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
