#!/usr/bin/env python3
"""Own a disposable PipeWire/Pulse server for packaged audio failure workflows.

Run inside linux-private-desktop.py. Hardware monitors are disabled. The child
can request stop/start through the private socket; host services are untouched.
This fixture currently supports Ubuntu 24.04's WirePlumber 0.4 configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def request(action):
    assert action in ['stop', 'start']
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(20)
        client.connect(os.environ['GC_QA_AUDIO_SOCKET'])
        client.sendall((action+'\n').encode())
        data = b''
        while not data.endswith(b'\n'):
            block = client.recv(65536)
            if not block: raise RuntimeError('Audio fixture disconnected')
            data += block
    result = json.loads(data)
    if not result['passed']: raise RuntimeError(result['error'])
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', choices=['stop', 'start'])
    parser.add_argument('--reports', type=Path)
    parser.add_argument('--receiver', action='store_true', help='Expose this stable server to receiver browsers; nest another fixture for publisher faults')
    parser.add_argument('--receiver-only', action='store_true', help='Expose only the receiver server address; preserve child desktop and publisher audio environment')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.request: return request(args.request)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    assert command and args.reports and (os.environ.get('GC_QA_PRIVATE_DESKTOP') or os.environ.get('GC_QA_OWNED_WAYLAND'))
    assert not args.receiver_only or args.receiver
    assert '0.4.' in subprocess.check_output(['wireplumber','--version'], text=True)
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    shutil.copyfile(__file__, report/Path(__file__).name)
    result = {'scope':'Owned PipeWire/Pulse server with no hardware monitors; child reports contain application evidence.',
              'passed':False, 'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'generations':[]}
    processes = []; logs = []; child = None
    with tempfile.TemporaryDirectory(prefix='gc-audio-') as temporary:
        root = Path(temporary)
        runtime = root/'runtime'; runtime.mkdir(mode=0o700)
        config = root/'wireplumber'; shutil.copytree('/usr/share/wireplumber', config)
        main_config = config/'wireplumber.conf'
        main_config.write_text('\n'.join(line for line in main_config.read_text().splitlines() if 'name = bluetooth.lua' not in line)+'\n')
        monitors = config/'main.lua.d/90-enable-all.lua'
        text = monitors.read_text()
        for name in ['alsa_monitor','v4l2_monitor','libcamera_monitor']:
            assert name+'.enable()' in text
            text = text.replace(name+'.enable()', '-- Hardware monitor disabled by owned QA fixture: '+name)
        monitors.write_text(text)
        shutil.copytree(config, report/'wireplumber-config')
        env = dict(os.environ)
        for name in ['PIPEWIRE_REMOTE','PIPEWIRE_RUNTIME_DIR','PIPEWIRE_CONFIG_DIR','PIPEWIRE_CONFIG_NAME','PULSE_RUNTIME_PATH','PULSE_SINK','PULSE_SOURCE','PULSE_COOKIE']:
            env.pop(name, None)
        env.update(XDG_RUNTIME_DIR=str(runtime), PIPEWIRE_RUNTIME_DIR=str(runtime),
                   WIREPLUMBER_CONFIG_DIR=str(config), PULSE_SERVER='unix:'+str(runtime/'pulse/native'),
                   GC_QA_AUDIO_SOCKET=str(root/'control.sock'))
        if args.receiver: env['GC_QA_RECEIVER_PULSE_SERVER'] = env['PULSE_SERVER']
        result['pulseServer'] = env['PULSE_SERVER']
        result['receiverOnly'] = args.receiver_only
        child_env = {**os.environ, 'GC_QA_RECEIVER_PULSE_SERVER':env['PULSE_SERVER']} if args.receiver_only else env
        def pactl(*values):
            return subprocess.check_output(['pactl',*values],env=env,text=True,stderr=subprocess.DEVNULL,timeout=3).strip()
        def stop():
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=4)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=4)
            retired = [{'pid':p.pid,'exitCode':p.returncode} for p in processes]
            processes.clear()
            for log in logs: log.close()
            logs.clear()
            return retired
        def start():
            assert not processes, 'Audio server already running'
            generation = len(result['generations'])
            for name in ['pipewire','wireplumber','pipewire-pulse']:
                log = (report/(str(generation)+'-'+name+'.log')).open('w'); logs.append(log)
                processes.append(subprocess.Popen([name],env=env,stdout=log,stderr=subprocess.STDOUT))
                if name == 'pipewire':
                    end = time.monotonic()+5
                    while not (runtime/'pipewire-0').is_socket():
                        assert processes[-1].poll() is None and time.monotonic()<end, 'Private PipeWire did not start'
                        time.sleep(.1)
            end = time.monotonic()+10
            while True:
                assert all(p.poll() is None for p in processes), 'Private audio service exited'
                try: pactl('info'); break
                except subprocess.SubprocessError:
                    if time.monotonic()>end: raise
                    time.sleep(.1)
            pactl('load-module','module-null-sink','sink_name=gc_audio_default','rate=48000','channels=2')
            pactl('set-default-sink','gc_audio_default')
            assert json.loads(pactl('--format=json','list','cards')) == [], 'Private server discovered hardware'
            info = dict(line.split(': ',1) for line in pactl('info').splitlines() if ': ' in line)
            state = {'generation':generation,'pids':[p.pid for p in processes],
                     'serverName':info['Server Name'],'serverVersion':info['Server Version'],'hardwareCards':0}
            result['generations'].append(state)
            return state
        print('Private audio:', report, flush=True)
        try:
            start()
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(env['GC_QA_AUDIO_SOCKET']); os.chmod(env['GC_QA_AUDIO_SOCKET'],0o600); server.listen(1)
                child = subprocess.Popen(command,env=child_env,start_new_session=True)
                result['childPid'] = child.pid
                while child.poll() is None:
                    ready,_,_ = select.select([server],[],[],.2)
                    if ready:
                        client,_ = server.accept()
                        with client:
                            client.settimeout(3)
                            action = client.recv(32).decode().strip()
                            try:
                                assert action in ['start','stop']
                                value = start() if action=='start' else stop()
                                response = {'passed':True,'action':action,'result':value}
                            except Exception as error: response = {'passed':False,'error':repr(error)}
                            client.sendall((json.dumps(response)+'\n').encode())
                    (report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
                result['exitCode'] = child.wait(); result['passed'] = result['exitCode']==0
        except Exception as error: result['error'] = repr(error)
        finally:
            if child and child.poll() is None:
                os.killpg(child.pid,15)
                try: child.wait(timeout=8)
                except subprocess.TimeoutExpired: os.killpg(child.pid,9); child.wait(timeout=5)
            result['retired'] = stop()
            result['ownedProcessesRetired'] = not processes and (child is None or child.poll() is not None)
            (report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'report':str(report/'results.json'),'passed':result['passed'],'error':result.get('error')}),flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
