#!/usr/bin/env python3
"""Compare simultaneous desktop/Pulse and canvas/WebAudio references.

This is diagnostic evidence, not independent absolute timing calibration. A
positive referenceDifferenceMs means the browser reference's audio appears later
relative to its video than the desktop/Pulse reference for the same pulse.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import statistics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--ffmpeg', required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location(
        'shared_av_analysis', Path(__file__).with_name('macos-analyze-av-sync.py'))
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    workflow = json.loads((args.report/'results.json').read_text())
    analysis = json.loads((args.report/'av-analysis.json').read_text())
    assert workflow['sourceReference'] == 'desktop' and workflow['diagnosticOnly']
    result = {'scope': __doc__, 'calibrated': False, 'comparisonComplete': False, 'phases': []}
    try:
        for phase in workflow['phases']:
            measured = next(p for p in analysis['phases'] if p['name'] == phase['name'])
            for kind in ('source', 'receiver', 'browserSource'):
                meta = phase[kind]
                assert Path(meta['path']).name == meta['path']
                assert analyzer.digest(args.report/meta['path']) == meta['sha256']
                if kind != 'browserSource':
                    assert measured[kind]['sha256'] == meta['sha256']
            browser = analyzer.analyze(args.report/phase['browserSource']['path'], args.ffmpeg)
            desktop_metadata = phase['source']
            desktop_analysis = measured['source']
            assert desktop_metadata['calibrated'] is False and desktop_metadata['closed']
            assert desktop_metadata['exitCode'] == 0
            span = (desktop_metadata['ended']-desktop_metadata['anchorMs'])/1000
            ready = (desktop_metadata['ready']-desktop_metadata['anchorMs'])/1000
            # Catch an unapplied epoch offset or timestamps outside the bounded
            # recording. This sanity check cannot prove relative input origins
            # or absolute A/V accuracy; initial buffered audio may precede launch.
            first_video = desktop_analysis['firstVideoPts']
            first_audio = desktop_analysis['firstAudioPts']
            last_video = desktop_analysis['videoObservations'][-1]['pts']
            origin_valid = (0 <= first_video <= ready+1 and -2 <= first_audio <= ready+1
                            and first_video < last_video <= span+1)
            assert origin_valid, 'Desktop reference PTS do not fit its common wall-clock origin'
            desktop_pairs = {p['id']: p for p in measured['source']['pairs']}
            receiver_pairs = {p['id']: p for p in measured['receiver']['pairs']}
            source_events = {e['pulse']: e for e in workflow['sourceFixture']['events']}
            pairs = []
            for pulse in browser['pairs']:
                pid = pulse['id']
                if pid not in desktop_pairs or pid not in receiver_pairs:
                    continue
                desktop, receiver = desktop_pairs[pid]['offsetMs'], receiver_pairs[pid]['offsetMs']
                pairs.append({'pulseId': pid, 'browserReferenceOffsetMs': pulse['offsetMs'],
                              'desktopReferenceOffsetMs': desktop, 'receiverOffsetMs': receiver,
                              'referenceDifferenceMs': pulse['offsetMs']-desktop,
                              'receiverMinusBrowserMs': receiver-pulse['offsetMs'],
                              'receiverMinusDesktopMs': receiver-desktop})
                event = source_events.get(pid, {})
                timestamp = event.get('outputTimestamp', {})
                if timestamp.get('contextTime', 0) > 0 and timestamp.get('performanceTime', 0) > 0:
                    target = workflow['sourceFixture']['epoch'] + pid*2 + workflow.get('fixtureTimingControl', {}).get('outputAudioDelayMs', 0)/1000
                    estimate = event['timeOrigin'] + timestamp['performanceTime'] + (target-timestamp['contextTime'])*1000
                    measured_audio = desktop_metadata['anchorMs'] + desktop_pairs[pid]['audioSeconds']*1000
                    pairs[-1]['browserEstimatedOutputWallMs'] = estimate
                    pairs[-1]['desktopAudioMinusBrowserOutputEstimateMs'] = measured_audio-estimate
            summary = {}
            for key in ('referenceDifferenceMs', 'receiverMinusBrowserMs', 'receiverMinusDesktopMs'):
                values = [p[key] for p in pairs]
                summary[key] = {'median': statistics.median(values) if values else None,
                                'minimum': min(values, default=None), 'maximum': max(values, default=None)}
            valid = (browser['mediaPassed'] and measured['source']['mediaPassed']
                     and measured['receiver']['mediaPassed']
                     and len(pairs) >= max(8, workflow['seconds']//2-4))
            result['phases'].append({'name': phase['name'], 'browserSource': browser,
                                     'pairs': pairs, 'summary': summary, 'recordingTimelineBoundsPassed': origin_valid,
                                     'desktopAudioClockContinuousWithin3ms': desktop_analysis['recordingClockContinuousWithin3ms'],
                                     'comparisonComplete': bool(valid)})
        result['comparisonComplete'] = bool(result['phases']) and all(p['comparisonComplete'] for p in result['phases'])
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        with (args.report/'reference-comparison.json').open('x') as out:
            json.dump(result, out, indent=2)
            out.write('\n')
    print(json.dumps({'comparisonComplete': result['comparisonComplete'], 'calibrated': False}))
    if not result['comparisonComplete']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
