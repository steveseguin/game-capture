#!/usr/bin/env python3
"""Verify the Windows application compilation graph. Not application testing."""
import argparse
import hashlib
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
entries = json.loads((args.build / 'compile_commands.json').read_text())
app = [e for e in entries if 'game-capture.dir/' in
       (e.get('output', '') + ' ' + e.get('command', '')).replace('\\', '/')]
assert app, 'No application compilation units'
files = [e['file'].replace('\\', '/').lower() for e in app]
required = ['src/video/window_capture.cpp', 'src/video/camera_capture.cpp',
            'src/video/spout_capture.cpp', 'src/video/video_encoder.cpp',
            'src/audio/window_audio_capture_core.cpp', 'src/platform/capabilities.cpp']
for name in required:
    assert sum(f.endswith('/' + name) for f in files) == 1, 'Missing or duplicate Windows backend: ' + name
assert not any('/src/platform/macos/' in f for f in files), 'Mac implementation selected on Windows'
for flag in ['VERSUS_USE_NVENC', 'VERSUS_USE_GRAPHICS_CAPTURE', 'VERSUS_USE_SPOUT']:
    assert all(re.search(r'[-/]D' + flag + r'(?:\s|=|$)', e['command']) for e in app), 'Windows feature disabled: ' + flag
exe = args.build / 'bin/game-capture.exe'
assert exe.is_file(), 'Windows application was not linked'
result = {'scope': __doc__, 'passed': True, 'applicationUnits': len(app),
          'windowsBackends': required, 'windowsFeatures': ['NVENC', 'Windows Graphics Capture', 'Spout'],
          'executableSha256': hashlib.sha256(exe.read_bytes()).hexdigest(),
          'applicationTestingCompleted': False}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
