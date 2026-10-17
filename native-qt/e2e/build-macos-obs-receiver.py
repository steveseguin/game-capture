#!/usr/bin/env python3
"""Build only the isolated QA receiver, using OBS 32.2.2 headers and runtime.

Does not install a plugin or modify OBS/user preferences. The Game Capture
application has no build/runtime dependency on this optional receiver fixture.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('--obs-source', type=Path, required=True)
parser.add_argument('--obs-app', type=Path, default=Path('/Applications/OBS.app'))
parser.add_argument('--qt-frameworks', type=Path, default=Path('/opt/homebrew/opt/qt/lib'))
parser.add_argument('--simde-include', type=Path, required=True)
parser.add_argument('--build', type=Path, required=True)
parser.add_argument('--sdk', type=Path, required=True)
args = parser.parse_args()
args.build.mkdir(parents=True, exist_ok=True)
source = Path(__file__).with_name('macos-obs-alpha-receiver.cpp').resolve()
revision = subprocess.check_output(['git', '-C', str(args.obs_source), 'rev-parse', '32.2.2'], text=True).strip()
assert revision == 'fc546137470c0f4a5f1493b6e7815545ee1b170b', 'Unexpected OBS header revision'
version = plistlib.loads((args.obs_app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
assert version == '32.2.2', 'This receiver recipe qualifies OBS 32.2.2 only'
headers = args.build / 'sdk'
headers.mkdir(exist_ok=True)
archive = subprocess.check_output(['git', '-C', str(args.obs_source), 'archive', revision, 'libobs'])
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    tar.extractall(headers, filter='data')
(headers / 'obsconfig.h').write_text('#pragma once\n#define OBS_DATA_PATH "data"\n'
    '#define OBS_PLUGIN_PATH "obs-plugins"\n#define OBS_PLUGIN_DESTINATION "obs-plugins"\n'
    '#define OBS_INSTALL_PREFIX ""\n#define OBS_RELEASE_CANDIDATE 0\n#define OBS_BETA 0\n')
frameworks = args.obs_app / 'Contents/Frameworks'
obj, output = args.build / 'receiver.o', args.build / 'macos-obs-alpha-receiver'
# Compile and link separately: OBS strips framework headers from its package.
# Its own frameworks must be used at runtime, not the header provider's libs.
compile_args = ['/usr/bin/clang++', '-std=c++17', '-arch', 'arm64', '-mmacosx-version-min=14.2',
    '-isysroot', str(args.sdk), '-c', str(source), '-I'+str(headers), '-I'+str(headers/'libobs'),
    '-I'+str(args.simde_include), '-F'+str(args.qt_frameworks)]
compile_args += ['-I'+str(args.qt_frameworks/(module+'.framework/Headers')) for module in ('QtCore','QtGui','QtWidgets')]
compile_args += ['-o', str(obj)]
link_args = ['/usr/bin/clang++', str(obj), '-arch', 'arm64', '-mmacosx-version-min=14.2', '-F'+str(frameworks),
    '-framework', 'QtWidgets', '-framework', 'QtGui', '-framework', 'QtCore', '-framework', 'libobs',
    '-Wl,-rpath,'+str(frameworks), '-o', str(output)]
with (args.build/'build.log').open('w') as log:
    subprocess.run(compile_args, check=True, stdout=log, stderr=subprocess.STDOUT)
    subprocess.run(link_args, check=True, stdout=log, stderr=subprocess.STDOUT)
manifest = {'obsVersion':version, 'headerRevision':revision, 'compile':compile_args, 'link':link_args,
    'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
    'executableSha256':hashlib.sha256(output.read_bytes()).hexdigest()}
(args.build/'build.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(output)
