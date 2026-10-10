"""Observe actual packaged GUI audio workflows, including OS sounds and resources.

The existing workflow owns clicks and settings restoration. This observer never
mutes Windows or intercepts a sound call; decoded loopback is saved as evidence.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import wave

import frida
import numpy as np
import psutil
import soundcard as sc


def main():
    output = Path(sys.argv[sys.argv.index('--output') + 1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    sys.argv[sys.argv.index('--output') + 1] = str(output / 'workflow')
    spec = importlib.util.spec_from_file_location('audio_gui', Path(__file__).with_name('audio-settings-desktop-e2e.py'))
    workflow = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(workflow)
    events, resources, audio, children, sessions = [], [], [], [], []
    finished = threading.Event()
    original = subprocess.Popen

    class ObservedProcess(original):
        def __init__(self, args, *rest, **kwargs):
            super().__init__(args, *rest, **kwargs)
            children.append(self)
            events.append({'kind': 'launch', 'time': time.time(), 'pid': self.pid,
                           'executable': str(args[0]), 'tone': 'audio-test-tone.ps1' in ' '.join(map(str, args))})
            if Path(str(args[0])).name.lower() == 'game-capture.exe':
                session = frida.attach(self.pid)
                script = session.create_script(workflow.desktop.OBSERVER)
                script.on('message', lambda message, data: events.append(
                    {'time': time.time(), 'pid': self.pid, **message.get('payload', message)}))
                script.load()
                sessions.append((session, script))

    def monitor():
        tracked = {}
        while not finished.wait(.5):
            for child in children[:]:
                if Path(str(child.args[0])).name.lower() != 'game-capture.exe' or child.poll() is not None:
                    continue
                try:
                    proc = tracked.setdefault(child.pid, psutil.Process(child.pid))
                    mem = proc.memory_info()
                    resources.append({'time': time.time(), 'pid': child.pid, 'path': proc.exe(),
                        'rss': mem.rss, 'private': mem.private, 'handles': proc.num_handles(),
                        'threads': proc.num_threads(), 'cpuPercentOneCore': proc.cpu_percent()})
                except psutil.Error:
                    pass

    def loopback():
        try:
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=speaker.id, include_loopback=True)
            events.append({'kind': 'loopback-device', 'name': speaker.name})
            with wave.open(str(output / 'system-output.wav'), 'wb') as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(48000)
                with mic.recorder(samplerate=48000, channels=2, blocksize=4800) as recorder:
                    while not finished.is_set():
                        block = recorder.record(numframes=4800)
                        wav.writeframes((np.clip(block, -1, 1) * 32767).astype('<i2').tobytes())
                        audio.append({'time': time.time(), 'rms': float(np.sqrt(np.mean(block ** 2))),
                                      'peak': float(np.max(np.abs(block)))})
        except BaseException as error:
            events.append({'kind': 'loopback-error', 'error': str(error)})

    threads = [threading.Thread(target=monitor), threading.Thread(target=loopback)]
    for thread in threads:
        thread.start()
    subprocess.Popen = ObservedProcess
    try:
        workflow.main()
    finally:
        subprocess.Popen = original
        finished.set()
        for thread in threads:
            thread.join(10)
        for session, _ in sessions:
            try:
                session.detach()
            except frida.InvalidOperationError:
                pass
        (output / 'observation.json').write_text(json.dumps({
            'events': events, 'resources': resources, 'systemAudio': audio,
            'soundCalls': [e for e in events if e.get('kind') == 'sound'],
            'scope': 'Sound hooks attach immediately after process launch; Windows loopback covers the full workflow.'
        }, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
