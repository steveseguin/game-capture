#!/usr/bin/env python3
"""Check the A/V analyzer against identical media and known +/-150 ms shifts.

Uses a real workflow's source recording. These are offline calibration controls,
not additional packaged application passes. No original recording is modified.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workflow', type=Path)
    parser.add_argument('--reports', required=True, type=Path)
    parser.add_argument('--ffmpeg', default='/opt/homebrew/bin/ffmpeg')
    args = parser.parse_args()
    workflow = json.loads((args.workflow/'results.json').read_text())
    metadata = workflow['phases'][0]['source']
    source = (args.workflow/metadata['path']).resolve()
    assert digest(source) == metadata['sha256'], 'Source recording changed'
    report = args.reports.resolve()/str(uuid.uuid4())
    report.mkdir(parents=True)
    analyzer = Path(__file__).with_name('macos-analyze-av-sync.py')
    for script in [Path(__file__), analyzer]:
        shutil.copyfile(script, report/script.name)
    result = {'scope': __doc__, 'source': str(source), 'sourceSha256': digest(source), 'cases': [], 'passed': False}
    try:
        for delay in [0, 150, -150]:
            folder = report/('delay-'+str(delay))
            folder.mkdir()
            # Hard links only preserve immutable input bytes. The delayed output
            # is a new file created by FFmpeg, with video and audio copied intact.
            (folder/'source.webm').hardlink_to(source)
            received = folder/'receiver.webm'
            if delay:
                subprocess.run([args.ffmpeg, '-nostdin', '-v', 'error', '-i', str(source), '-itsoffset', str(delay/1000),
                    '-i', str(source), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-n', str(received)],
                    check=True, timeout=60, capture_output=True)
            else:
                received.hardlink_to(source)
            manifest = {'seconds': workflow['seconds'], 'holdSeconds': 0, 'phases': [{'name': 'calibration',
                'source': {'path': 'source.webm', 'sha256': digest(source)},
                'receiver': {'path': 'receiver.webm', 'sha256': digest(received)}}]}
            (folder/'results.json').write_text(json.dumps(manifest, indent=2)+'\n')
            with (folder/'analyzer.log').open('x') as log:
                process = subprocess.run(['python3', str(analyzer), str(folder), '--ffmpeg', args.ffmpeg],
                                         stdout=log, stderr=subprocess.STDOUT, timeout=180)
            analysis = json.loads((folder/'av-analysis.json').read_text())
            assert 'error' not in analysis and len(analysis['phases']) == 1, 'Calibration analyzer failed to read media'
            phase = analysis['phases'][0]
            assert phase['source']['mediaPassed'] and phase['receiver']['mediaPassed'], 'Calibration media invalid'
            offsets = [pair['additionalOffsetMs'] for pair in phase['pairs']]
            assert offsets and max(abs(offset-delay) for offset in offsets) <= 15, 'Injected delay measured incorrectly'
            expected_pass = delay == 0
            assert analysis['passed'] == expected_pass and process.returncode == (0 if expected_pass else 1), 'Calibration acceptance/rejection incorrect'
            result['cases'].append({'injectedAudioDelayMs': delay, 'minimumMeasuredMs': min(offsets),
                'maximumMeasuredMs': max(offsets), 'matchedPulses': len(offsets), 'expectedAcceptance': expected_pass,
                'actualAcceptance': analysis['passed'], 'passed': True})
        result['passed'] = True
    except Exception as error:
        result['error'] = repr(error)
        raise
    finally:
        with (report/'calibration.json').open('x') as out:
            json.dump(result, out, indent=2)
            out.write('\n')
        print(json.dumps({'report': str(report), **result}, indent=2))


if __name__ == '__main__':
    main()
