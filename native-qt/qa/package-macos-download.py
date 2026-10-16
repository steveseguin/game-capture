#!/usr/bin/env python3
"""Package an audited arm64 app with its matching source archive and checksums.

Packaging and signature/source verification are gates, not application testing.
Development ZIPs deliberately differ from the updater's distribution filenames.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require(condition, message):
    # Packaging/distribution checks must also run under python -O.
    if not condition:
        raise ValueError(message)


def inventory(app):
    result = {}
    for path in sorted(app.rglob('*')):
        name = path.relative_to(app).as_posix()
        if path.is_symlink():
            require(path.resolve(strict=True).is_relative_to(app), 'Escaping bundle link: ' + name)
            result[name] = {'type': 'link', 'target': os.readlink(path)}
        elif path.is_dir():
            result[name] = {'type': 'directory', 'mode': stat.S_IMODE(path.stat().st_mode)}
        elif path.is_file():
            result[name] = {'type': 'file', 'mode': stat.S_IMODE(path.stat().st_mode),
                            'bytes': path.stat().st_size, 'sha256': digest(path)}
        else:
            raise ValueError('Unsupported bundle entry: ' + name)
    return result


def verify_source(archive, binaries):
    actual, manifest = {}, None
    with tarfile.open(archive, mode='r|gz') as tar:
        for entry in tar:
            name = entry.name
            if name in actual or Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('Invalid source archive member: ' + name)
            if name == 'manifest.json':
                require(manifest is None and entry.isfile() and entry.size <= 16 * 1024 * 1024,
                        'Invalid source manifest')
                manifest = json.load(tar.extractfile(entry))
                continue
            require(entry.isfile() or entry.issym(), 'Unexpected source entry type')
            if entry.issym():
                require(not Path(entry.linkname).is_absolute(), 'Absolute source symlink')
                resolved = os.path.normpath(str(Path(name).parent / entry.linkname))
                require(resolved != '..' and not resolved.startswith('../'), 'Escaping source symlink')
                data = entry.linkname.encode()
            else:
                data = tar.extractfile(entry).read()
            actual[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                            'link': entry.linkname if entry.issym() else None,
                            'executable': bool(entry.mode & stat.S_IXUSR)}
    require(manifest and manifest['format'] == 1 and actual == manifest['files'], 'Source payload verification failed')
    require(manifest['binaries'] == binaries, 'Source archive does not match every packaged binary')
    for name in ['repository/LICENSE', 'repository/native-qt/CMakeLists.txt', 'README.txt']:
        require(name in actual, 'Missing source/build material: ' + name)
    return {'verifiedPayloads': len(actual), 'nativeRepositories': len(manifest['nativeComponents']),
            'upstreamArchives': len(manifest['upstream']), 'matchedBinaries': len(binaries)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--source-archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New directory; never overwrites an existing candidate')
    parser.add_argument('--distribution', action='store_true', help='Require Developer ID, Gatekeeper assessment and a valid stapled notarization ticket')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Run this packager on macOS')
    app, source, output = args.app.resolve(), args.source_archive.resolve(), args.output.resolve()
    require(app.name == 'Game Capture.app' and app.is_dir(), 'Expected deployed Game Capture.app')
    require(source.is_file() and source.name.endswith('.tar.gz'), 'Use the matching package-macos-source.py archive')
    require(not output.exists(), 'Use a new output directory')
    require(not output.is_relative_to(app), 'Output cannot be inside the input app')
    output.mkdir(parents=True, exist_ok=False)
    try:
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        version = info['CFBundleShortVersionString']
        require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Unsupported bundle version')
        require(info['CFBundleExecutable'] == 'game-capture', 'Unexpected bundle executable')
        require(info['CFBundleIdentifier'] == 'ninja.vdo.game-capture', 'Unexpected bundle identifier')
        subprocess.run([sys.executable, str(Path(__file__).with_name('audit-macos-bundle.py')),
                        '--app', str(app), '--report', str(output / 'bundle-audit.json')], check=True)
        audit = json.loads((output / 'bundle-audit.json').read_text())
        require(audit['passed'] and audit['files'], 'Bundle audit did not pass')
        binaries = {entry['path']: entry['sha256'] for entry in audit['files']}
        signature = subprocess.check_output(['/usr/bin/codesign', '-d', '--verbose=4', str(app)],
                                            stderr=subprocess.STDOUT, text=True)
        (output / 'signature.txt').write_text(signature)
        if args.distribution:
            require(re.search(r'^Authority=Developer ID Application:', signature, re.M),
                    'Distribution requires a Developer ID Application signature')
            for name, command in [
                ('gatekeeper.txt', ['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=4', str(app)]),
                ('notarization.txt', ['/usr/bin/xcrun', 'stapler', 'validate', str(app)])]:
                check = subprocess.run(command, capture_output=True, text=True)
                (output / name).write_text(check.stdout + check.stderr)
                require(check.returncode == 0, name + ' verification failed')

        source_check = verify_source(source, binaries)
        stem = f'game-capture-macos-arm64-{version}'
        zip_name = stem + ('' if args.distribution else '-development') + '.zip'
        source_name = stem + '-source.tar.gz'
        before = inventory(app)
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent',
                        str(app), str(output / zip_name)], check=True)
        # Clone when supported; fall back to a normal copy on other filesystems.
        copied = subprocess.run(['/bin/cp', '-c', str(source), str(output / source_name)], capture_output=True)
        if copied.returncode:
            shutil.copyfile(source, output / source_name)
        require(digest(source) == digest(output / source_name), 'Source copy differs')
        require(inventory(app) == before, 'App changed during packaging')
        mode = 'distribution' if args.distribution else 'development'
        readme = f'''Game Capture {version} — Apple Silicon ({mode})

Extract {zip_name} to obtain Game Capture.app. Requires macOS {info['LSMinimumSystemVersion']} or later on Apple Silicon.
'''
        if not args.distribution:
            readme += '\nThis is a local development candidate. Distribution signing/notarization and clean-machine installation qualification are unfinished.\n'
        readme += f'''
Source/build materials: {source_name}. See README.txt inside that archive for rebuild instructions.
The app is AGPL-3.0; bundled component notices are in Game Capture.app/Contents/Resources/licenses.
Keep the source archive with the app archive. SHA256SUMS covers this delivery set.
Manifest verification does not replace packaged application testing or license/distribution review.
'''
        (output / 'README.txt').write_text(readme)
        manifest = {'format': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'packagerSha256': digest(Path(__file__)),
                    'mode': mode, 'version': version, 'architecture': 'arm64',
                    'minimumOS': info['LSMinimumSystemVersion'], 'appName': app.name,
                    'scope': 'Archive/source/signature gates; packaged and clean-machine execution are separate',
                    'archive': {'name': zip_name, 'sha256': digest(output / zip_name), 'bytes': (output / zip_name).stat().st_size},
                    'source': {'name': source_name, 'sha256': digest(output / source_name), 'bytes': source.stat().st_size,
                               **source_check}, 'binaries': binaries, 'appFiles': before}
        (output / 'delivery-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (output / 'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(output.iterdir()) if p.is_file()))
        print(json.dumps({'output': str(output), 'mode': mode, 'archive': zip_name,
                          'source': source_name, 'matchedBinaries': len(binaries), 'passed': True}))
        return 0
    except Exception as error:
        (output / 'FAILED.json').write_text(json.dumps({'passed': False, 'error': repr(error)}, indent=2) + '\n')
        print(json.dumps({'output': str(output), 'passed': False, 'error': repr(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
