#!/usr/bin/env python3
"""Bounded packaged Linux GUI/media workflow, usable on ARM64 and amd64.

Run under linux-private-desktop.py on an owned Xvfb display. Uses the existing
Tk moving source, real GUI actions, a private PulseAudio server and independent
FFmpeg reception/decoding of loopback MPEG-TS. No host audio/device changes.
This is not physical desktop, hardware encoder, WebRTC or performance qualification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

import numpy as np
from PIL import Image, ImageGrab


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publisher', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--reports', required=True, type=Path)
    args = parser.parse_args()
    assert os.getuid() != 0 and os.environ.get('GC_QA_PRIVATE_DESKTOP')
    assert os.environ.get('QT_QPA_PLATFORM') == 'xcb'
    exe = args.publisher.resolve(); bundle = exe.parent.parent.parent
    manifest_path = bundle/'release-artifact-manifest.json'
    assert sha(manifest_path) == args.manifest_sha256
    manifest = json.loads(manifest_path.read_text())
    assert manifest['architecture'] == {'aarch64':'arm64', 'x86_64':'amd64'}[platform.machine()]
    assert sha(exe) == manifest['artifact']['sha256']
    for entry in manifest['payload']['files']:
        file = (bundle/entry['relativePath']).resolve()
        assert file.is_relative_to(bundle) and file.stat().st_size == entry['size'] and sha(file) == entry['sha256']
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    helpers = Path(__file__).parent
    result = {'scope':__doc__, 'passed':False, 'architecture':manifest['architecture'],
              'kernel':platform.release(), 'packageManifestSha256':sha(manifest_path),
              'executableSha256':sha(exe), 'sourceTreeSha256':manifest['sourceTreeSha256'],
              'profile':{'resolution':'960x540', 'fps':30, 'encoder':'software libx264',
                         'transport':'loopback UDP/MPEG-TS', 'audio':'system + microphone, AAC stereo'},
              'phases':[], 'harnesses':{}}
    for name in [Path(__file__).name, 'linux-ui-control.py', 'linux-installed-desktop.py']:
        shutil.copy2(helpers/name, report/name); result['harnesses'][name] = sha(helpers/name)
    settings = report/'settings'; settings.mkdir()
    discovery = report/'private-control.json'
    processes = []; logs = []; app = None; control = None; helper_pids = set()
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    env = dict(os.environ)
    def save(): (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    def start(command, label, **options):
        log = (report/(label+'.log')).open('wb'); logs.append(log)
        child = subprocess.Popen(command, env=env, stdout=log, stderr=log, **options)
        processes.append(child); return child
    def wait(check, message, seconds=20):
        deadline = time.monotonic()+seconds
        while time.monotonic() < deadline:
            if app: assert app.poll() is None, 'Application exited unexpectedly'
            value = check()
            if value: return value
            time.sleep(.15)
        raise RuntimeError(message)
    def ui(*values):
        return subprocess.check_output([sys.executable, str(helpers/'linux-ui-control.py'), str(app.pid), *values],
                                       env=env, text=True, timeout=20)
    def rows(): return json.loads(ui('dump'))
    def diagnostics():
        request = urllib.request.Request(control['base_url']+'/diagnostics',
                                         headers={'Authorization':'Bearer '+control['token']})
        with direct.open(request, timeout=5) as response: return json.load(response)
    def screenshot(name): ImageGrab.grab().save(report/(name+'.png'))
    def pactl(*values): return subprocess.check_output(['pactl', *values], env=env, text=True, timeout=5).strip()
    def idle():
        d = diagnostics()
        assert not d['app']['live'] and not d['app']['capturing']
        assert not d['app']['primary_audio_capturing'] and not d['app']['microphone_capturing']
        return d
    def launch(label, restore=False):
        nonlocal app, control
        app = start([str(exe), '--settings-dir='+str(settings), '--local-control',
                     '--local-control-port=0', '--local-control-discovery='+str(discovery)], label+'-app')
        wait(discovery.exists, 'Missing local control discovery'); control = json.loads(discovery.read_text())
        assert control['pid'] == app.pid
        wait(lambda:any(r['name']=='Show advanced settings' for r in rows()), 'GUI not ready')
        idle()
        if not any('checked' in r['states'] for r in rows() if r['name']=='Show advanced settings'):
            ui('press', 'Show advanced settings')
        if restore:
            controls = rows()
            for name in ['Software (x264 / VP9 / AV1 / HEVC)', '960x540', '30',
                         'System audio (all apps)', 'ARMBringupMicrophone', 'UDP / MPEG-TS (LAN)']:
                assert any(r['role']=='combo box' and r['name']==name for r in controls), 'Saved setting missing: '+name
            assert json.loads(ui('read-text', 'Output URL')) == destination
            result['settingsRestoredWithoutCapture'] = True
        else:
            ui('choose', 'VDO.Ninja (default)', 'UDP / MPEG-TS (LAN)')
            ui('text', 'Output URL', destination)
            ui('choose', 'Auto (Hardware, then Software)', 'Software (x264 / VP9 / AV1 / HEVC)')
            ui('choose', '1280x720', '960x540'); ui('choose', '60', '30')
            audio = next(r['name'] for r in rows() if r['role']=='combo box' and r['name'] in ['No audio', 'Selected window/app audio'])
            ui('choose', audio, 'System audio (all apps)')
            ui('choose-prefix', 'No microphone', 'ARMBringupMicrophone')
        ui('source', 'Game Capture Installed Source'); screenshot(label+'-ready')
    def stop():
        ui('press', 'Stop streaming')
        wait(lambda:not diagnostics()['app']['capturing'], 'Stop did not retire capture')
        idle()
        assert json.loads(pactl('--format=json', 'list', 'source-outputs')) == [], 'Audio capture leaked after Stop'
        wait(lambda:all(not Path(f'/proc/{pid}').exists() for pid in helper_pids), 'Encoder/output helper survived Stop')
        helper_pids.clear()
        screenshot('stopped')
    def quit_app():
        nonlocal app
        child = app; ui('quit-menu'); child.wait(timeout=15)
        assert child.returncode == 0 and not discovery.exists(), 'Quit/discovery cleanup failed'
        app = None
    def receive(label, microphone=True):
        # Join an already-running publisher, independently receive, then decode.
        transport = report/(label+'.ts')
        receiver = start(['ffmpeg','-hide_banner','-loglevel','warning','-threads','2',
            '-analyzeduration','1000000','-probesize','1000000','-i',destination+'?fifo_size=8192&overrun_nonfatal=1',
            '-map','0:v:0','-map','0:a:0','-c','copy','-t','5','-f','mpegts',str(transport)],label+'-receiver')
        receiver.wait(timeout=30); assert receiver.returncode == 0
        for task in Path(f'/proc/{app.pid}/task').iterdir():
            for pid in (task/'children').read_text().split():
                try:
                    if Path(f'/proc/{pid}/exe').resolve(strict=True).name == 'ffmpeg': helper_pids.add(int(pid))
                except FileNotFoundError: pass
        probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(transport)], text=True))
        video = next(s for s in probe['streams'] if s['codec_type']=='video')
        audio = next(s for s in probe['streams'] if s['codec_type']=='audio')
        assert video['codec_name']=='h264' and (video['width'],video['height'])==(960,540)
        assert audio['codec_name']=='aac' and audio['channels']==2
        raw = report/(label+'.rgb'); pcm = report/(label+'.f32')
        subprocess.run(['ffmpeg','-v','error','-threads','2','-filter_threads','1','-i',str(transport),
            '-map','0:v:0','-an','-vf','scale=160:90','-pix_fmt','rgb24','-f','rawvideo',str(raw),
            '-map','0:a:0','-vn','-ac','2','-ar','48000','-f','f32le',str(pcm)], check=True, timeout=30)
        frames = np.fromfile(raw, dtype=np.uint8).reshape(-1,90,160,3)
        assert len(frames)>=90, 'Insufficient decoded moving video'
        identities = []
        for frame in frames:
            row = frame[45].astype(int)
            cyan = np.flatnonzero((row[:,0]<70)&(row[:,1]>170)&(row[:,2]>170))
            magenta = np.flatnonzero((row[:,0]>170)&(row[:,1]<70)&(row[:,2]>170))
            assert len(cyan) and len(magenta), 'Missing source color markers'
            width = (int(magenta[0])-int(cyan[0]))/.75; left = int(cyan[0])-width*.1
            identity = 0
            for bit in range(16):
                pixel = row[round(left+width*(.2+(bit+.5)*.6/16))]
                assert max(pixel)-min(pixel)<45 and not 85<pixel[0]<170, 'Corrupt source identity'
                if pixel[0]>127: identity |= 1<<bit
            identities.append(identity)
        assert len(set(identities))>=30, 'Decoded video is frozen'
        samples = np.fromfile(pcm,dtype='<f4').reshape(-1,2)
        assert len(samples)>=48000*3 and np.isfinite(samples).all()
        spectra = []
        for offset in range(48000,len(samples)-24000,24000):
            block = samples[offset:offset+24000].astype(float)
            spectrum = np.abs(np.fft.rfft(block*np.hanning(len(block))[:,None],axis=0))*4/len(block)
            levels = {}
            for channel, frequencies in enumerate([(440,660),(880,1320)]):
                for frequency in frequencies:
                    index = round(frequency*len(block)/48000)
                    levels[str(frequency)] = float(spectrum[index-1:index+2,channel].max())
                for frequency in [(880,1320),(440,660)][channel]:
                    index = round(frequency*len(block)/48000)
                    assert float(spectrum[index-1:index+2,channel].max())<.003, 'Stereo channel crosstalk'
            for frequency in ('440','880'): assert levels[frequency]>.02, 'System audio missing'
            for frequency in ('660','1320'):
                assert levels[frequency]>.02 if microphone else levels[frequency]<.003, 'Microphone mix/mute incorrect'
            assert float(np.max(np.abs(block)))<.99, 'Clipped audio'
            spectra.append(levels)
        assert len(spectra)>=4
        Image.fromarray(frames[len(frames)//2]).save(report/(label+'-decoded.png'))
        screenshot(label+'-gui')
        phase = {'name':label,'passed':True,'microphoneExpected':microphone,
                 'decodedFrames':len(frames),'uniqueSourceIdentities':len(set(identities)),
                 'audioSamplesPerChannel':len(samples),'spectra':spectra,
                 'transportSha256':sha(transport),'decodedVideoSha256':sha(raw),'decodedAudioSha256':sha(pcm),
                 'diagnostics':diagnostics()}
        result['phases'].append(phase); save(); print(json.dumps({'phase':label,'passed':True}),flush=True)

    print('Report:',report,flush=True); save()
    with tempfile.TemporaryDirectory(prefix='gc-arm-audio-') as temporary:
        root = Path(temporary)
        env['PULSE_SERVER'] = 'unix:'+str(root/'pulse.sock')
        env['PULSE_CLIENTCONFIG'] = str(root/'client.conf')
        (root/'client.conf').write_text('autospawn = no\n')
        config = root/'pulse.pa'
        config.write_text(f'load-module module-native-protocol-unix socket={root}/pulse.sock auth-anonymous=1\n'
            'load-module module-null-sink sink_name=arm_system rate=48000 channels=2\n'
            'load-module module-null-sink sink_name=arm_mic rate=48000 channels=2\n'
            'load-module module-remap-source master=arm_mic.monitor source_name=arm_input source_properties=device.description=ARMBringupMicrophone\n'
            'set-default-sink arm_system\nset-default-source arm_input\n')
        try:
            pulse = start(['pulseaudio','--daemonize=no','--exit-idle-time=-1','--use-pid-file=no','-nF',str(config)],'pulse')
            wait(lambda:(root/'pulse.sock').exists(), 'Private Pulse server failed')
            assert pactl('get-default-sink')=='arm_system'
            result['pulseServer'] = pactl('info')
            for sink, frequencies in [('arm_system',(440,880)),('arm_mic',(660,1320))]:
                start(['ffmpeg','-v','error','-re','-f','lavfi','-i',
                    f'aevalsrc=0.15*sin(2*PI*{frequencies[0]}*t)|0.15*sin(2*PI*{frequencies[1]}*t):s=48000',
                    '-f','pulse','-device',sink,'ARM bringup owned tone'],sink+'-tone')
            source = start([sys.executable,str(helpers/'linux-installed-desktop.py'),'--source'],'source')
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
                sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
            destination = f'udp://127.0.0.1:{port}'
            wait(lambda:len(json.loads(pactl('--format=json','list','sink-inputs')))==2, 'Owned tone fixtures failed')
            time.sleep(1); launch('initial')
            ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Go live failed')
            receive('mixed')
            ui('press','Mute microphone'); time.sleep(1)
            assert diagnostics()['audio']['microphone_muted']
            receive('muted',microphone=False)
            ui('press','Unmute microphone'); time.sleep(1)
            receive('unmuted')
            stop(); ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Restart failed')
            receive('restarted'); stop(); quit_app()
            launch('relaunched',restore=True); quit_app()
            result['passed'] = True
        except Exception as error:
            result['error'] = repr(error)
            try: screenshot('failure')
            except Exception: pass
        finally:
            for child in reversed(processes):
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=8)
                    except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            result['ownedProcessesRetired'] = all(child.poll() is not None for child in processes)
            for log in logs: log.close()
            result['discoveryRemoved'] = not discovery.exists()
            save()
    print(json.dumps({'passed':result['passed'],'report':str(report/'results.json'),'error':result.get('error')}),flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
