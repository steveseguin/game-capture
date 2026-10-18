#!/usr/bin/env python3
"""Sign a separate deployed bundle for Developer ID distribution.

Uses an existing Keychain identity. No credentials, notarization or publication.
Signature validation is a gate; run packaged workflows against the signed copy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path, help='New directory; input bundle is preserved')
    parser.add_argument('--identity', required=True, help='SHA-1 of a Developer ID Application identity in the Keychain')
    parser.add_argument('--team-id', required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Requires macOS signing tools')
    app, output = args.app.resolve(strict=True), args.output.resolve()
    if app.name != 'Game Capture.app' or output.exists() or output.is_relative_to(app):
        parser.error('Use a deployed Game Capture.app and a new separate output directory')
    if not re.fullmatch(r'[A-Fa-f0-9]{40}', args.identity) or not re.fullmatch(r'[A-Z0-9]{10}', args.team_id):
        parser.error('Invalid identity fingerprint or team ID')
    identities = run('/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning')
    pattern = re.escape(args.identity) + r' "Developer ID Application:[^"\n]+\(' + re.escape(args.team_id) + r'\)"'
    if not re.search(pattern, identities, re.I):
        parser.error('Matching valid Developer ID Application identity unavailable')
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(app))
    entitlements = Path(__file__).parents[1] / 'resources/macos/distribution.entitlements.plist'
    expected = {'com.apple.security.device.camera': True, 'com.apple.security.device.audio-input': True}
    if plistlib.loads(entitlements.read_bytes()) != expected:
        parser.error('Unexpected distribution entitlements')
    # Refuse links outside the signed tree before copying or signing anything.
    for p in app.rglob('*'):
        if p.is_symlink() and not p.resolve(strict=True).is_relative_to(app):
            parser.error('Bundle contains an escaping symlink')
    output.mkdir(parents=True)
    target = output / app.name
    result = {'scope': __doc__, 'identitySha1': args.identity.upper(), 'teamId': args.team_id,
              'inputApp': str(app), 'signedApp': str(target), 'signed': [], 'passed': False}
    try:
        run('/bin/cp', '-cR', str(app), str(target))
        info = plistlib.loads((target / 'Contents/Info.plist').read_bytes())
        executable = target / 'Contents/MacOS' / info['CFBundleExecutable']
        frameworks = sorted(target.rglob('*.framework'), key=lambda p: len(p.parts), reverse=True)
        magic = {bytes.fromhex(s) for s in ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']}
        binaries = []
        for p in sorted(target.rglob('*')):
            if p.is_symlink() or not p.is_file():
                continue
            with p.open('rb') as f:
                if f.read(4) in magic:
                    binaries.append(p)

        def sign(p, main=False):
            command = ['/usr/bin/codesign', '--force', '--sign', args.identity, '--timestamp', '--options', 'runtime']
            if main:
                command += ['--entitlements', str(entitlements), '--generate-entitlement-der']
            run(*command, str(p))
            result['signed'].append(str(p.relative_to(target)) if p != target else '.')

        # Libraries/helpers, nested frameworks, then the outer app. Never use
        # --deep to sign: each component receives its intended entitlement set.
        for binary in binaries:
            if binary != executable and not any(binary.is_relative_to(f) for f in frameworks):
                sign(binary)
        for framework in frameworks:
            sign(framework)
        sign(target, main=True)
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(target))
        result['binaries'] = {}
        for binary in binaries:
            details = run('/usr/bin/codesign', '-d', '--verbose=4', str(binary))
            if not all(s in details for s in ['Authority=Developer ID Application:', 'TeamIdentifier=' + args.team_id, 'runtime', 'Timestamp=']):
                raise ValueError('Incomplete distribution signature: ' + str(binary.relative_to(target)))
            result['binaries'][str(binary.relative_to(target))] = hashlib.sha256(binary.read_bytes()).hexdigest()
        actual = subprocess.check_output(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(target)], stderr=subprocess.DEVNULL)
        if plistlib.loads(actual) != expected:
            raise ValueError('Signed app entitlements differ')
        result['entitlements'] = expected
        result['passed'] = True
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        result['error'] = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            result['toolOutput'] = error.output
    (output / 'signing-report.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'passed': result['passed'], 'signedComponents': len(result['signed']), 'error': result.get('error')}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
