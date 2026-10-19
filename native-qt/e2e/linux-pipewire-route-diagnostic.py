#!/usr/bin/env python3
"""Owned native PipeWire playback/output-move diagnostic without Game Capture.

This isolates the source/audio graph. It is not application testing or parity
qualification. Run inside linux-private-desktop.py and linux-private-audio.py.
"""
import argparse
from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time
import traceback
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reports', type=Path, required=True)
    parser.add_argument('--moves', type=int, default=20)
    parser.add_argument('--direct-monitor', action='store_true')
    args = parser.parse_args()
    assert 1 <= args.moves <= 20
    assert os.environ.get('GC_QA_PRIVATE_DESKTOP') and os.environ.get('GC_QA_AUDIO_SOCKET')
    assert os.environ.get('PULSE_SERVER', '').startswith('unix:')
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    result = dict(scope=__doc__, directMonitor=args.direct_monitor, passed=False, phases=[], harnesses={})
    def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    for name in (Path(__file__).name, 'linux-app-audio-source.py'):
        shutil.copy2(Path(__file__).with_name(name), report/name)
        result['harnesses'][name] = sha(report/name)
    def save(): (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    def pactl(*values): return subprocess.check_output(['pactl', *values], text=True, timeout=5).strip()
    child = monitor = None; module = None
    try:
        default = pactl('get-default-sink'); assert default == 'gc_audio_default'
        other = 'gc_qa_'+uuid.uuid4().hex[:12]
        module = pactl('load-module', 'module-null-sink', 'sink_name='+other, 'rate=48000', 'channels=2')
        with (report/'source.log').open('w') as log:
            child = subprocess.Popen([sys.executable, str(report/'linux-app-audio-source.py'), '--device', default,
                                      '--backend', 'pipewire'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=log, text=True, start_new_session=True)
        assert select.select([child.stdout], [], [], 10)[0], 'Native source did not start'
        ready = json.loads(child.stdout.readline()); assert ready['ready']
        pid = ready['playbackPid']; result['playbackPid'] = pid
        assert Path(f'/proc/{pid}/exe').resolve().name == 'pw-cat'
        for index in range(args.moves+1):
            deadline = time.monotonic()+10
            while True:
                clients = json.loads(pactl('-f', 'json', 'list', 'clients'))
                owners = {int(row['index']) for row in clients if str(row['properties'].get('application.process.id')) == str(pid)}
                streams = [row for row in json.loads(pactl('-f', 'json', 'list', 'sink-inputs')) if int(row['client']) in owners]
                if streams or child.poll() is not None or time.monotonic() >= deadline: break
                time.sleep(.1)
            assert len(streams) == 1 and child.poll() is None
            if index == 0 and args.direct_monitor:
                with (report/'direct-monitor.log').open('w') as log:
                    monitor = subprocess.Popen(['parec', '--raw', '--format=float32le', '--rate=48000',
                        '--channels=2', '--channel-map=front-left,front-right', '--latency-msec=10',
                        '--process-time-msec=10', '--client-name=GameCaptureOwnedQAReference',
                        '--monitor-stream='+str(streams[0]['index']), '--device='+default+'.monitor'],
                        stdout=subprocess.DEVNULL, stderr=log)
            assert monitor is None or monitor.poll() is None, 'Independent direct monitor exited'
            destination = other if index % 2 else default
            if index: pactl('move-sink-input', str(streams[0]['index']), destination)
            time.sleep(1.2)
            raw = subprocess.check_output(['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'pulse',
                '-i', destination+'.monitor', '-t', '2', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le',
                '-f', 'f32le', 'pipe:1'], timeout=10)
            assert len(raw) >= 48000*8 and len(raw) % 8 == 0
            samples = array('f'); samples.frombytes(raw)
            if sys.byteorder != 'little': samples.byteswap()
            rms = [math.sqrt(sum(x*x for x in samples[channel::2])/(len(samples)//2)) for channel in range(2)]
            file = report/f'output-{index:02d}.f32le'; file.write_bytes(raw); file.chmod(0o600)
            phase = dict(move=index, destination=destination, playbackIndex=streams[0]['index'],
                         rms=rms, path=file.name, sha256=sha(file), passed=all(.08 < value < .13 for value in rms))
            result['phases'].append(phase); save()
            if not phase['passed']:
                (report/'failed-pipewire-graph.json').write_bytes(subprocess.check_output(['pw-dump'], timeout=5))
                raise RuntimeError(f'Owned source output silent/invalid after move {index}: {rms}')
        result['passed'] = True
    except Exception:
        result['error'] = traceback.format_exc()
    finally:
        if monitor:
            try:
                if monitor.poll() is None: monitor.send_signal(signal.SIGINT)
                monitor.wait(timeout=5); assert monitor.returncode == 0
                result['monitorRetired'] = True
            except Exception:
                result['monitorCleanupError'] = traceback.format_exc(); result['passed'] = False
                if monitor.poll() is None: monitor.kill(); monitor.wait(timeout=5)
        if child:
            try:
                child.stdin.close(); child.wait(timeout=8)
                assert child.returncode == 0, 'Native source did not retire cleanly'
                result['sourceRetired'] = True
            except Exception:
                result['cleanupError'] = traceback.format_exc(); result['passed'] = False
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
        if module:
            try: pactl('unload-module', module)
            except Exception: result['moduleCleanupError'] = traceback.format_exc(); result['passed'] = False
        save()
    print(json.dumps(dict(report=str(report), passed=result['passed'], error=result.get('error'))), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
