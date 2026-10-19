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
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
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
    parser.add_argument('--resolution', choices=['960x540', '1280x720'], default='960x540')
    parser.add_argument('--failure-recovery', action='store_true',
                        help='Also exercise output-helper death/stall and source-window loss')
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
    launcher = (bundle/manifest.get('launcher', manifest['artifact']['path'])).resolve()
    assert launcher.is_relative_to(bundle)
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    helpers = Path(__file__).parent
    result = {'scope':__doc__, 'passed':False, 'architecture':manifest['architecture'],
              'kernel':platform.release(), 'packageManifestSha256':sha(manifest_path),
              'executableSha256':sha(exe), 'sourceTreeSha256':manifest['sourceTreeSha256'],
              'profile':{'resolution':args.resolution, 'fps':30, 'bitrateKbps':4000, 'encoder':'software libx264',
                         'transport':'loopback UDP/MPEG-TS', 'audio':'system + microphone, AAC stereo'},
              'phases':[], 'harnesses':{}}
    for name in [Path(__file__).name, 'linux-ui-control.py', 'linux-installed-desktop.py']:
        shutil.copy2(helpers/name, report/name); result['harnesses'][name] = sha(helpers/name)
    settings = report/'settings'; settings.mkdir()
    discovery = report/'private-control.json'
    processes = []; logs = []; app = None; control = None; helper_pids = {}
    audio_baseline = set()
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
    def bitrate_row_visible(expected, hidden):
        labels = [r for r in rows() if r['role'] == 'label']
        return (any(r['name'] == expected and 'visible' in r['states'] for r in labels)
                and not any(r['name'] == hidden and 'visible' in r['states'] for r in labels))
    def diagnostics():
        request = urllib.request.Request(control['base_url']+'/diagnostics',
                                         headers={'Authorization':'Bearer '+control['token']})
        with direct.open(request, timeout=5) as response: return json.load(response)
    def screenshot(name): ImageGrab.grab().save(report/(name+'.png'))
    def pactl(*values): return subprocess.check_output(['pactl', *values], env=env, text=True, timeout=5).strip()
    def process_identity(pid):
        try:
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
            return int(fields[1]), fields[19]  # parent PID, start time ticks
        except FileNotFoundError: return None
    def same_process(pid, identity):
        current = process_identity(pid)
        # An orphaned helper keeps its start time even if its parent changes.
        return current is not None and current[1] == identity[1]
    def idle():
        d = diagnostics()
        assert not d['app']['live'] and not d['app']['capturing']
        assert not d['app']['primary_audio_capturing'] and not d['app']['microphone_capturing']
        return d
    def launch(label, restore=False):
        nonlocal app, control
        app = start([str(launcher), '--settings-dir='+str(settings), '--local-control',
                     '--local-control-port=0', '--local-control-discovery='+str(discovery)], label+'-app')
        wait(discovery.exists, 'Missing local control discovery'); control = json.loads(discovery.read_text())
        assert control['pid'] == app.pid
        wait(lambda:any(r['name']=='Show advanced settings' for r in rows()), 'GUI not ready')
        idle()
        if not any('checked' in r['states'] for r in rows() if r['name']=='Show advanced settings'):
            ui('press', 'Show advanced settings')
        if restore:
            controls = rows()
            for name in ['Software (x264 / VP9 / AV1 / HEVC)', args.resolution, '30',
                         'System audio (all apps)', result['microphoneLabel'], 'UDP / MPEG-TS (LAN)']:
                assert any(r['role']=='combo box' and r['name']==name for r in controls), 'Saved setting missing: '+name
            assert json.loads(ui('read-text', 'Output URL')) == destination
            result['settingsRestoredWithoutCapture'] = True
        else:
            ui('press', 'Audio encoding')
            wait(lambda:bitrate_row_visible('Opus bitrate', 'AAC bitrate'), 'Incorrect initial audio form rows')
            (report/'opus-form-ui.json').write_text(json.dumps(rows(), indent=2)+'\n')
            ui('choose', 'VDO.Ninja (default)', 'UDP / MPEG-TS (LAN)')
            wait(lambda:bitrate_row_visible('AAC bitrate', 'Opus bitrate'), 'Audio form rows did not follow output mode')
            (report/'aac-form-ui.json').write_text(json.dumps(rows(), indent=2)+'\n')
            result['audioFormRowsFollowOutputMode'] = True
            ui('press', 'Audio encoding')
            ui('text', 'Output URL', destination)
            ui('choose', 'Auto (Hardware, then Software)', 'Software (x264 / VP9 / AV1 / HEVC)')
            expected_fps = '30' if manifest['architecture'] == 'arm64' else '60'
            assert any(r['role']=='combo box' and r['name']==expected_fps for r in rows()), 'Incorrect first-run frame rate'
            result['initialWindowFps'] = int(expected_fps)
            if args.resolution != '1280x720': ui('choose', '1280x720', args.resolution)
            if expected_fps != '30': ui('choose', expected_fps, '30')
            audio = next(r['name'] for r in rows() if r['role']=='combo box' and r['name'] in ['No audio', 'Selected window/app audio'])
            ui('choose', audio, 'System audio (all apps)')
            ui('choose-prefix', 'No microphone', 'ARMBringupMicrophone')
            # The device label includes its default marker and sample format.
            result['microphoneLabel'] = next(r['name'] for r in rows()
                if r['role']=='combo box' and r['name'].startswith('ARMBringupMicrophone'))
        ui('source', 'Game Capture Installed Source'); screenshot(label+'-ready')
    def stop():
        ui('press', 'Stop streaming')
        wait(lambda:not diagnostics()['app']['capturing'], 'Stop did not retire capture')
        idle()
        # The fixture's remapped microphone itself owns a monitor stream.
        # Require restoration of that baseline, with no application captures.
        wait(lambda:{s['index'] for s in json.loads(pactl('--format=json','list','source-outputs'))} == audio_baseline,
             'Audio capture leaked after Stop')
        wait(lambda:all(not same_process(pid, identity) for pid, identity in helper_pids.items()),
             'Encoder/output helper survived Stop')
        helper_pids.clear()
        screenshot('stopped')
    def quit_app():
        nonlocal app
        child = app; ui('quit-menu'); child.wait(timeout=15)
        assert child.returncode == 0 and not discovery.exists(), 'Quit/discovery cleanup failed'
        debug = Path(os.environ['XDG_STATE_HOME'])/'GameCapture/logs/game-capture-debug.log'
        if debug.exists(): shutil.copy2(debug, report/f'publisher-{child.pid}-debug.log')
        app = None
    def interrupt_output(sig):
        d = diagnostics()
        pid = d['output']['muxer_pid']
        identity = process_identity(pid)
        assert identity and identity[0] == app.pid, 'Output helper is not owned by this publisher'
        assert Path(f'/proc/{pid}/exe').resolve() == bundle/'usr/lib/game-capture/ffmpeg'
        # Keep an identity for cleanup even if this helper never reaches receive().
        helper_pids[pid] = identity
        os.kill(pid, sig)
        return pid, d
    def receive(label, microphone=True):
        # Join an already-running publisher, independently receive, then decode.
        transport = report/(label+'.ts')
        receiver = start(['ffmpeg','-hide_banner','-loglevel','warning','-threads','2',
            '-analyzeduration','1000000','-probesize','1000000','-i',destination+'?fifo_size=8192&overrun_nonfatal=1',
            '-map','0:v:0','-map','0:a:0','-c','copy','-t','5','-f','mpegts',str(transport)],label+'-receiver')
        receiver.wait(timeout=30); assert receiver.returncode == 0
        # Some Tegra kernels omit /proc/PID/task/TID/children. Parent/start
        # identities work on those kernels and also protect against PID reuse.
        for process in Path('/proc').iterdir():
            if not process.name.isdigit(): continue
            identity = process_identity(process.name)
            if identity and identity[0] == app.pid:
                try:
                    if (process/'exe').resolve(strict=True).name == 'ffmpeg': helper_pids[int(process.name)] = identity
                except FileNotFoundError: pass
        assert helper_pids, 'No output helper observed during live MPEG-TS publication'
        if manifest.get('packageFormat') == 'portable-tar':
            # Prove the shipped libraries/helper are in use, even on a host
            # with other Qt/FFmpeg versions installed. Preserve spaces in paths.
            mappings = [line.split(maxsplit=5)[5] for line in Path(f'/proc/{app.pid}/maps').read_text().splitlines()
                        if len(line.split(maxsplit=5)) == 6 and line.split(maxsplit=5)[5].startswith('/')]
            loaded = {}
            for library in ('libQt6Core.so', 'libavcodec.so', 'libavutil.so', 'libswscale.so', 'libpulse.so', 'libpipewire-0.3.so'):
                paths = sorted({path for path in mappings if Path(path).name.startswith(library)})
                assert paths and all(Path(path).is_relative_to(bundle) for path in paths), 'Foreign or missing runtime library: '+library
                loaded[library] = paths
            for pid, identity in helper_pids.items():
                if not same_process(pid, identity): continue  # A deliberate helper failure already retired it.
                assert Path(f'/proc/{pid}/exe').resolve() == bundle/'usr/lib/game-capture/ffmpeg', 'Unbundled output helper'
            result.setdefault('portableRuntimeLibraries', {})[label] = loaded
        probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(transport)], text=True))
        video = next(s for s in probe['streams'] if s['codec_type']=='video')
        audio = next(s for s in probe['streams'] if s['codec_type']=='audio')
        assert video['codec_name']=='h264' and (video['width'],video['height'])==tuple(map(int,args.resolution.split('x')))
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
            baseline_streams = json.loads(pactl('--format=json','list','source-outputs'))
            audio_baseline = {s['index'] for s in baseline_streams}
            result['fixtureAudioBaseline'] = baseline_streams
            time.sleep(1); launch('initial')
            ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Go live failed')
            receive('mixed')
            ui('press','Mute microphone'); time.sleep(1)
            assert diagnostics()['audio']['microphone_muted']
            receive('muted',microphone=False)
            ui('press','Unmute microphone'); time.sleep(1)
            receive('unmuted')
            if args.failure_recovery:
                old_pid, before = interrupt_output(signal.SIGKILL)
                wait(lambda:diagnostics()['output']['reconnects'] > before['output']['reconnects'],
                     'Killed output helper did not trigger reconnection')
                wait(lambda:diagnostics()['output']['muxer_pid'] not in (0, old_pid),
                     'Output helper was not replaced')
                receive('output-helper-recovered')
                assert diagnostics()['app']['capturing'], 'Output recovery lost the source'
                _, before = interrupt_output(signal.SIGSTOP)
                started = time.monotonic()
                stop()
                elapsed = time.monotonic()-started
                assert elapsed < 10, 'Stop blocked on a stalled output helper'
                result['stalledOutputStopSeconds'] = elapsed
                ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Restart after stalled output failed')
                receive('stalled-output-restarted')
                source.terminate(); source.wait(timeout=5)
                wait(lambda:not diagnostics()['app']['capturing'], 'Lost window left capture active')
                idle()
                wait(lambda:{s['index'] for s in json.loads(pactl('--format=json','list','source-outputs'))} == audio_baseline,
                     'Lost window leaked audio recording')
                wait(lambda:all(not same_process(pid,identity) for pid,identity in helper_pids.items()),
                     'Lost window left output helpers running')
                helper_pids.clear()
                failure_ui = rows()
                assert any('Window capture stopped' in r['name'] for r in failure_ui), 'No visible source-loss explanation'
                (report/'source-loss-ui.json').write_text(json.dumps(failure_ui,indent=2)+'\n')
                screenshot('source-loss')
                result['sourceLossRetiredCaptureAudioAndOutput'] = True
                source = start([sys.executable,str(helpers/'linux-installed-desktop.py'),'--source'],'replacement-source')
                # Tk does not consistently set _NET_WM_PID on X11. This title
                # is unique on our private display, and the old source exited.
                wait(lambda:source.poll() is None and subprocess.run(
                     ['xdotool','search','--onlyvisible','--name','^Game Capture Installed Source$'],
                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0,'Replacement window missing')
                # Explicit selection is required; source replacement must never publish automatically.
                time.sleep(2); idle()
                ui('source','Game Capture Installed Source')
                ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Replacement source failed')
                receive('replacement-source')
            stop(); ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Restart failed')
            receive('restarted'); stop(); quit_app()
            launch('relaunched',restore=True); quit_app()
            result['passed'] = True
        except Exception as error:
            result['error'] = repr(error)
            result['traceback'] = traceback.format_exc()
            try: (report/'failure-ui.json').write_text(ui('dump'))
            except Exception: pass
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
