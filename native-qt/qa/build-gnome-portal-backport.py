#!/usr/bin/env python3
"""Build an isolated GNOME 46.2 cancellation-fix candidate, without installing it.

This is a dependency diagnostic/build gate, not application testing or a supported
desktop update. Use a local clone of https://github.com/GNOME/xdg-desktop-portal-gnome
containing the pinned objects below. The source checkout is never modified.

Ubuntu 24.04 build prerequisites: meson, ninja-build, gettext,
xdg-desktop-portal-dev, libgtk-4-dev, libadwaita-1-dev,
libgnome-desktop-4-dev and libgnome-bg-4-dev. Review the package manager's plan;
installing development dependencies can otherwise upgrade graphics libraries.

Example:
  python3 native-qt/qa/build-gnome-portal-backport.py \
    --source=/path/to/xdg-desktop-portal-gnome --output=/tmp/portal46-candidate

The output contains upstream LGPL source and COPYING, exact patches with author
metadata, logs, the candidate binary and a provenance manifest. No system package,
service, D-Bus owner or active desktop capture is changed by this command.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile


BASE = '72d01648ab872c8d849c298fdd9f4d33b5eb820d'  # Upstream 46.2
# Clear the freed session dialog pointer; disconnect callbacks before freeing data.
PATCHES = [
    ('9a4dffaf775f6bdb372768f568167fa2c1187257',
     '35157a537ad059df6269fda7f3c3e3ebf5abab89b7a6c0518ac9d99ed4cdfab4'),
    ('056029c6506dd1e7bd285943099e9fcc091cff8b',
     'dfcaae5ab02e5dbc1cb0b1c5d800e5e6995cd20a0ccc49d5c8ab728795e0e681'),
]
UPSTREAM = 'https://github.com/GNOME/xdg-desktop-portal-gnome'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    for tool in ['git', 'meson', 'ninja', 'pkg-config', 'cc']:
        if not shutil.which(tool):
            parser.error('Missing build prerequisite: ' + tool)
    if output.exists():
        parser.error('Output must be a new directory; existing artifacts are preserved')

    def git(*arguments):
        return subprocess.check_output(['git', '-C', str(source), *arguments])

    # Validate pinned content before creating the output or building anything.
    archive = git('archive', '--format=tar', BASE)
    patches = []
    for commit, expected in PATCHES:
        patch = git('show', '--format=', '--binary', commit, '--', 'src/screencast.c')
        if sha(patch) != expected:
            raise RuntimeError('Unexpected upstream patch bytes: ' + commit)
        metadata = git('show', '-s', '--format=fuller', commit).decode()
        patches.append((commit, patch, metadata))

    output.mkdir(parents=True)
    tree = output / 'source'
    tree.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(tree, filter='data')
    patch_dir = output / 'patches'
    patch_dir.mkdir()
    # Keep git apply independent of a repository containing the output directory.
    patch_env = {key: value for key, value in os.environ.items()
                 if key not in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE')}
    patch_env['GIT_CEILING_DIRECTORIES'] = str(output)
    for commit, patch, metadata in patches:
        (patch_dir / (commit + '.patch')).write_bytes(patch)
        (patch_dir / (commit + '.txt')).write_text(metadata)
        subprocess.run(['git', 'apply', '--check', '-'], cwd=tree, env=patch_env,
                       input=patch, check=True)
        subprocess.run(['git', 'apply', '-'], cwd=tree, env=patch_env, input=patch, check=True)

    build = output / 'build'
    commands = [
        ['meson', 'setup', str(build), str(tree), '--buildtype=debugoptimized',
         '--prefix=/usr', '-Dsystemd=disabled'],
        ['ninja', '-C', str(build), '-j4'],
    ]
    for command, name in zip(commands, ['configure.log', 'build.log']):
        with (output / name).open('wb') as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    binary = build / 'src/xdg-desktop-portal-gnome'
    dependencies = ['xdg-desktop-portal', 'libadwaita-1', 'gtk4', 'glib-2.0',
                    'gnome-desktop-4', 'gnome-bg-4']
    manifest = {
        'classification': 'Build gate only; not application testing or a deployed desktop fix.',
        'upstream': UPSTREAM, 'baseCommit': BASE, 'sourceArchiveSha256': sha(archive),
        'patches': [{'commit': commit, 'url': UPSTREAM + '/commit/' + commit,
                     'sha256': sha(patch)} for commit, patch, _ in patches],
        'builderSha256': sha(Path(__file__).read_bytes()),
        'architecture': platform.machine(), 'commands': commands,
        'dependencies': {name: subprocess.check_output(
            ['pkg-config', '--modversion', name], text=True).strip() for name in dependencies},
        'binary': str(binary), 'binarySha256': sha(binary.read_bytes()),
        'screencastSourceSha256': sha((tree / 'src/screencast.c').read_bytes()),
        'logs': {name: sha((output / name).read_bytes())
                 for name in ['configure.log', 'build.log']},
    }
    (output / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
