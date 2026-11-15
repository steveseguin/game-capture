"""Launch an owned package with synthetic six-channel capture-boundary data."""
import os
import json
from pathlib import Path
import sys
import time
import frida

profiles = json.loads(Path(__file__).with_name('six-channel-tone-profiles.json').read_text())
profile = os.environ.get('GC_AUDIO_TEST_PROFILE', 'surround')
if profile not in profiles:
    raise ValueError('Unknown six-channel tone profile: ' + profile)
fixture = 'globalThis.fixtureFrequencies = ' + json.dumps(profiles[profile]) + ';\n'
fixture += Path(__file__).with_name('six-channel-capture-fixture.js').read_text()
device = frida.get_local_device()
device.on('output', lambda pid, fd, data: (sys.stdout.buffer.write(data), sys.stdout.buffer.flush()))
pid = device.spawn(sys.argv[1:], cwd=str(Path(sys.argv[1]).parent), stdio='pipe', env=dict(os.environ))
session = device.attach(pid)
script = session.create_script(fixture)
script.on('message', lambda message, data: print(message, flush=True))
script.load()
device.resume(pid)
try:
    while not session.is_detached:
        time.sleep(.2)
finally:
    if not session.is_detached:
        device.kill(pid)
