#!/usr/bin/env python3
"""Exercise a pinned packaged Mac app from an owned window to a real browser receiver.

This uses a fresh macOS 14 VM and the existing window workflow. It does not
qualify physical devices, privacy transitions, audio, endurance, WAN behavior,
independent-machine reception or exact macOS 14.2. No permissions are changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def clean_error(value):
    value = re.sub(r'https?://[^\s"<>]+', '<url>', str(value))
    value = re.sub(r'(?i)bearer\s+\S+', 'Bearer <redacted>', value)
    value = re.sub(r'macdev[0-9a-f]+|\b[0-9a-f]{48}\b', '<owned-session>', value)
    return value[:4000]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['archive', 'archive-sha256', 'executable-sha256', 'revision', 'report']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--encoder', choices=['x264', 'videotoolbox'], required=True)
    args = parser.parse_args()
    report = Path(args.report).resolve()
    report.mkdir(parents=True, exist_ok=False)
    export = report / 'export'
    export.mkdir()
    result = {'scope': __doc__, 'passed': False, 'stage': 'archive-and-startup',
              'encoder': args.encoder, 'archiveSha256': args.archive_sha256,
              'executableSha256': args.executable_sha256, 'runtimeRevision': args.revision,
              'harnessSha256': digest(Path(__file__)), 'cases': []}
    native = Path(__file__).resolve().parents[1]
    env = {k: v for k, v in os.environ.items() if k not in [
        'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']}
    try:
        result['stage'] = 'native-host-capability-gate'
        probe_source = Path(__file__).with_name('macos-vt-host-probe.mm')
        probe = report / 'vt-host-probe'
        with (export / 'vt-host-probe-build.log').open('w') as log:
            subprocess.run(['xcrun', 'clang++', '-std=c++17', '-fobjc-arc', str(probe_source),
                '-framework', 'Foundation', '-framework', 'VideoToolbox', '-framework', 'CoreMedia',
                '-o', str(probe)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=90)
        with (export / 'vt-host-probe.json').open('w') as output, (export / 'vt-host-probe.log').open('w') as log:
            subprocess.run([str(probe)], stdout=output, stderr=log, check=True, timeout=30)
        shutil.copy2(probe_source, export / probe_source.name)
        result['stage'] = 'archive-and-startup'
        # The existing wrapper verifies archive paths, exact binaries, signatures,
        # notarization and dependencies, then actually launches/quits the app.
        startup = report / 'startup'
        with (report / 'startup.log').open('w') as log:
            process = subprocess.run([sys.executable, str(Path(__file__).with_name('macos-hosted-package.py')),
                '--archive', args.archive, '--archive-sha256', args.archive_sha256,
                '--executable-sha256', args.executable_sha256, '--revision', args.revision,
                '--report', str(startup)], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=600)
        shutil.copytree(startup / 'export', export / 'startup')
        preflight = json.loads((startup / 'export/results.json').read_text())
        result['host'] = preflight.get('host')
        result['startupPassed'] = preflight['passed']
        assert process.returncode == 0 and preflight['passed'], 'Packaged startup prerequisite failed'
        app = startup / 'Relocated Applications/Game Capture.app'
        result['stage'] = 'window-to-browser'
        workflow = native / 'e2e/macos-window-publish.js'
        result['windowHarnessSha256'] = digest(workflow)
        commands = ['node', str(workflow), '--app=' + str(app), '--reports=' + str(report / 'media'),
                    '--encoder=' + args.encoder, '--codec=h264', '--audio=none',
                    '--width=640', '--height=360', '--fps=30', '--bitrate-kbps=1500']
        with (report / 'media.log').open('w') as log:
            child = subprocess.Popen(commands, cwd=native, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            try:
                child.wait(timeout=300)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
        result['workflowExitCode'] = child.returncode
        result_files = list((report / 'media').glob('*/results.json'))
        assert len(result_files) == 1, 'Expected exactly one retained media workflow'
        observed_path = result_files[0]
        observed = json.loads(observed_path.read_text())
        assert observed['executableSha256'] == args.executable_sha256
        result['rawResultsSha256'] = digest(observed_path)
        result['requested'] = observed['requested']
        result['browserVersions'] = observed.get('browserVersions')
        result['workflowError'] = clean_error(observed.get('error', ''))
        for case in observed['cases']:
            entry = {key: case[key] for key in ['encoder', 'passed', 'functionalPassed',
                     'activeEncoder', 'hardwareEncoder', 'distinctFrames', 'exitCode', 'exitSignal',
                     'sourceClosureReported', 'closedSourceBrowser'] if key in case}
            # Content identity/timing arrays contain no session URLs or control
            # data. Keep them for independent review, not just pass booleans.
            entry['phases'] = {}
            for phase in ['moving', 'static', 'resized', 'lateViewer']:
                if phase in case:
                    observed_phase = case[phase]
                    entry['phases'][phase] = {key: observed_phase[key] for key in [
                        'started', 'ended', 'observations', 'width', 'height', 'identityReadFailures', 'rowDisagreements', 'identityObserved', 'observerError']
                        if key in observed_phase}
                    entry['phases'][phase]['tracks'] = [{k: track[k] for k in [
                        'codec', 'framesDecoded', 'framesReceived', 'framesDropped', 'packetsReceived',
                        'packetsLost', 'bytesReceived', 'jitter', 'totalDecodeTime', 'totalProcessingDelay',
                        'jitterBufferDelay', 'jitterBufferEmittedCount', 'frameWidth', 'frameHeight',
                        'framesPerSecond', 'freezeCount', 'totalFreezesDuration'] if k in track}
                        for track in observed_phase.get('tracks', [])]
            entry['initialSourceTrace'] = case.get('initialSourceTrace', [])
            entry['publisher'] = {}
            for phase in ['initialBeforeDiagnostics', 'initialAfterDiagnostics']:
                diagnostics = case.get(phase, {})
                entry['publisher'][phase] = {
                    'generatedSteadyMs': diagnostics.get('generated_steady_ms'),
                    'observationError': clean_error(diagnostics.get('observationError', '')),
                    'video': {k: diagnostics['video'][k] for k in [
                        'active_encoder', 'hardware_encoder', 'frames_captured', 'frames_sent', 'frames_dropped',
                        'encode_failures', 'encode_timeouts', 'encode_hard_failures', 'send_failures',
                        'frames_skipped_before_readback'] if k in diagnostics.get('video', {})}}
            result['cases'].append(entry)
        log_path = observed_path.parent / (args.encoder + '.log')
        if log_path.exists():
            # Export only native capture/encoder messages, never signaling logs,
            # arguments, settings, discovery files or raw diagnostics.
            messages = [clean_error(line) for line in log_path.read_text(errors='replace').splitlines()
                        if re.search(r'\[(VideoToolbox|MacEncoder|ScreenCaptureKit)\]', line)]
            (export / 'native-media.log').write_text('\n'.join(messages[:200]) + '\n')
        for name in ['source.png', args.encoder + '-receiver.png']:
            source = observed_path.parent / name
            if source.exists():
                shutil.copy2(source, export / name)
        for name in ['macos-window-publish.js', 'macos-media-receiver.js',
                     'macos-window-suspension.js', 'macos-continuous-audio.js']:
            shutil.copy2(native / 'e2e' / name, export / name)
        assert child.returncode == 0 and observed['passed'], 'Window-to-browser workflow failed'
        assert len(result['cases']) == 1 and result['cases'][0]['passed']
        assert result['cases'][0]['hardwareEncoder'] == (args.encoder == 'videotoolbox')
        result['passed'] = True
        result['stage'] = 'complete'
    except Exception as error:
        result['error'] = clean_error(repr(error))
    finally:
        (export / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        shutil.copy2(__file__, export / Path(__file__).name)
        print(json.dumps({key: result.get(key) for key in ['passed', 'stage', 'encoder', 'host',
                          'startupPassed', 'workflowExitCode', 'workflowError', 'error']}, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
