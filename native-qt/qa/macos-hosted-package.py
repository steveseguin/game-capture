#!/usr/bin/env python3
"""Run bounded startup/diagnostics workflows on a deployed Mac app on a fresh host.

Signature, archive and dependency audits are gates. The two application launches
exercise local diagnostics/export, authentication, resource reporting, graceful
quit and invalid-source refusal. Media, physical devices, browser quarantine and
the exact macOS 14.2 minimum remain separate qualifications. No permissions,
trust settings, devices or system preferences are changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import posixpath
import shutil
import stat
import subprocess
import sys
import zipfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--executable-sha256', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    report = args.report.resolve()
    report.mkdir(parents=True, exist_ok=False)
    public = report / 'export'
    public.mkdir()
    result = {'scope': __doc__, 'passed': False, 'gatesPassed': False,
              'applicationWorkflowsCompleted': 0, 'launches': [],
              'expectedExecutableSha256': args.executable_sha256,
              'archiveSha256': args.archive_sha256, 'stage': 'host-and-archive',
              'runtimeRevision': args.revision, 'harnessSha256': digest(Path(__file__))}
    try:
        assert sys.platform == 'darwin' and platform.machine() == 'arm64'
        result['host'] = {
            'architecture': platform.machine(),
            'os': subprocess.check_output(['/usr/bin/sw_vers'], text=True),
            'hardware': subprocess.check_output(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip(),
            'imageVersion': os.environ.get('ImageVersion'),
            'imageOS': os.environ.get('ImageOS'),
            'pythonVersion': platform.python_version(),
            'runId': os.environ.get('GITHUB_RUN_ID'),
        }
        archive = args.archive.resolve(strict=True)
        assert digest(archive) == args.archive_sha256, 'Archive hash mismatch'
        with zipfile.ZipFile(archive) as source:
            assert sum(entry.file_size for entry in source.infolist()) < 1024**3
            for entry in source.infolist():
                name = PurePosixPath(entry.filename)
                assert not name.is_absolute() and '..' not in name.parts
                assert name.parts[0] in ['Game Capture.app', '__MACOSX']
                if stat.S_ISLNK(entry.external_attr >> 16):
                    target = source.read(entry).decode()
                    assert not posixpath.isabs(target)
                    resolved = posixpath.normpath(posixpath.join(str(name.parent), target))
                    assert resolved.startswith('Game Capture.app/'), 'Escaping bundle link'
        unpacked = report / 'Relocated Applications'
        unpacked.mkdir()
        subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(unpacked)], check=True)
        app = unpacked / 'Game Capture.app'
        exe = app / 'Contents/MacOS/game-capture'
        assert digest(exe) == args.executable_sha256
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        assert info['CFBundleIdentifier'] == 'ninja.vdo.game-capture'
        assert info['GameCaptureQualificationRevision'] == args.revision
        result['bundleVersion'] = info['CFBundleShortVersionString']
        result['declaredMinimumOS'] = info['LSMinimumSystemVersion']
        commands = [
            ['codesign', '--verify', '--deep', '--strict', str(app)],
            ['xcrun', 'stapler', 'validate', str(app)],
            ['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=4', str(app)],
            [str(app / 'Contents/Helpers/ffmpeg'), '-version'],
            [sys.executable, str(Path(__file__).with_name('audit-macos-bundle.py')),
             '--app', str(app), '--report', str(public / 'bundle-audit.json')],
        ]
        with (public / 'distribution-gates.log').open('w') as log:
            for command in commands:
                result['stage'] = 'distribution-gate: ' + Path(command[0]).name
                subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
        result['gatesPassed'] = True
        workflow = Path(__file__).parents[1] / 'e2e/macos-foundation-packaged.py'
        result['foundationHarnessSha256'] = digest(workflow)
        env = {k: v for k, v in os.environ.items() if k not in [
            'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']}
        for index in range(2):
            result['stage'] = 'packaged-workflow-' + str(index)
            case = report / ('launch-' + str(index))
            with (report / ('launch-' + str(index) + '.log')).open('w') as log:
                completed = subprocess.run([sys.executable, str(workflow), '--app', str(app),
                    '--report-dir', str(case)], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
            entry = {'launch': index, 'exitCode': completed.returncode, 'passed': False}
            result['launches'].append(entry)
            if (case / 'results.json').exists():
                observed = json.loads((case / 'results.json').read_text())
                entry.update(passed=observed['passed'], checks=observed['checks'], error=observed.get('error'),
                             resultsSha256=digest(case / 'results.json'),
                             availableCameraCount=observed.get('availableCameraCount'),
                             cameraRefusals=observed.get('cameraRefusals'))
                assert observed['executable_sha256'] == args.executable_sha256
                if (case / 'exported-diagnostics.json').exists():
                    diagnostics = json.loads((case / 'exported-diagnostics.json').read_text())
                    entry['platformPermissions'] = diagnostics.get('platform_permissions')
            assert completed.returncode == 0 and entry['passed'], 'Packaged startup workflow did not complete'
            result['applicationWorkflowsCompleted'] += 1
        assert digest(exe) == args.executable_sha256, 'Packaged executable changed'
        result['passed'] = True
        result['stage'] = 'complete'
    except Exception as error:
        result['error'] = repr(error)
    finally:
        # Export summaries and gates only: no control tokens, settings, raw AX
        # snapshots or raw application logs are uploaded from the hosted VM.
        (public / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        shutil.copy2(__file__, public / Path(__file__).name)
        print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
