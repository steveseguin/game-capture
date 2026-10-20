#!/usr/bin/env python3
"""Bounded packaged Linux GUI/media workflow, usable on ARM64 and amd64.

Run under linux-private-desktop.py on an owned Xvfb display. Uses the existing
Tk moving source, real GUI actions, a private PulseAudio server and independent
FFmpeg reception/decoding of loopback MPEG-TS, or an independent Chromium WebRTC
receiver with --webrtc. No host audio/device changes. This is not physical
desktop, hardware encoder, calibrated A/V synchronization or game-performance
qualification. Optional bounded fuzz and comparative CPU/decoded-frame observations
exercise the same packaged GUI workflow without changing acceptance thresholds.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
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
    parser.add_argument('--source-size', choices=['640x360', '1280x720'], default='640x360')
    parser.add_argument('--performance-seconds', type=int, default=0,
                        help='Bounded same-host decoded-frame and publisher CPU observation (10..120 seconds)')
    parser.add_argument('--fuzz-seed', type=int,
                        help='Exercise bounded seeded malformed local-control requests while receiving media')
    parser.add_argument('--failure-recovery', action='store_true',
                        help='Also exercise output-helper death/stall and source-window loss')
    parser.add_argument('--webrtc', action='store_true', help='Receive through VDO.Ninja in a native Chromium browser')
    parser.add_argument('--browser', type=Path, help='Native Chromium executable (requires Playwright on NODE_PATH)')
    parser.add_argument('--node', default='node', help='Node executable for the independent receiver')
    parser.add_argument('--endurance-seconds', type=int, default=0,
                        help='WebRTC continuous reception, statistics every 5 s, decoded content/audio every 60 s')
    args = parser.parse_args()
    assert 0 <= args.endurance_seconds <= 3600
    assert not args.webrtc or (args.browser and not args.failure_recovery)
    assert not args.endurance_seconds or args.webrtc
    assert args.performance_seconds == 0 or 10 <= args.performance_seconds <= 120
    assert not (args.performance_seconds or args.fuzz_seed is not None) or args.webrtc
    assert args.fuzz_seed is None or 0 <= args.fuzz_seed <= 0xffffffff
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
              'profile':{'resolution':args.resolution, 'sourceSize':args.source_size, 'fps':30, 'bitrateKbps':4000, 'encoder':'software libx264',
                         'transport':'loopback UDP/MPEG-TS', 'audio':'system + microphone, AAC stereo'},
              'phases':[], 'harnesses':{}}
    if args.webrtc:
        result['profile'].update(transport='VDO.Ninja WebRTC', audio='system + microphone, Opus stereo')
    harnesses = [Path(__file__).name, 'linux-ui-control.py', 'linux-installed-desktop.py']
    if args.webrtc: harnesses += ['linux-webrtc-observer.js', 'macos-media-receiver.js']
    if args.fuzz_seed is not None: harnesses += ['linux-live-control-stress.js', 'macos-live-control-fuzz.js']
    for name in harnesses:
        shutil.copy2(helpers/name, report/name); result['harnesses'][name] = sha(helpers/name)
    settings = report/'settings'; settings.mkdir()
    discovery = report/'private-control.json'
    processes = []; logs = []; app = None; control = None; helper_pids = {}
    audio_baseline = set()
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    env = dict(os.environ)
    observer = None
    def observer_reply(timeout=90):
        with selectors.DefaultSelector() as selector:
            selector.register(observer.stdout, selectors.EVENT_READ)
            assert selector.select(timeout), 'Browser observer timed out'
            line = observer.stdout.readline()
        assert line, 'Browser observer exited: inspect observer.log'
        value = json.loads(line)
        assert value.get('ok', value.get('ready', value.get('closed', False))), value
        return value
    def browser_command(op, **options):
        observer.stdin.write(json.dumps(dict(op=op, **options))+'\n'); observer.stdin.flush()
        return observer_reply()
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
                         'System audio (all apps)', result['microphoneLabel'],
                         'VDO.Ninja (default)' if args.webrtc else 'UDP / MPEG-TS (LAN)']:
                assert any(r['role']=='combo box' and r['name']==name for r in controls), 'Saved setting missing: '+name
            assert json.loads(ui('read-text', 'Stream ID or VDO.Ninja URL' if args.webrtc else 'Output URL')) == destination
            if args.webrtc:
                # Accessibility deliberately returns bullets for a masked
                # password. Exercise its real Show control before reading.
                ui('reveal', 'Stream password')
                assert json.loads(ui('read-text', 'Stream password')) == 'false', 'Saved fixture password missing'
                ui('reveal', 'Stream password')
            result['settingsRestoredWithoutCapture'] = True
        else:
            ui('press', 'Audio encoding')
            wait(lambda:bitrate_row_visible('Opus bitrate', 'AAC bitrate'), 'Incorrect initial audio form rows')
            (report/'opus-form-ui.json').write_text(json.dumps(rows(), indent=2)+'\n')
            if not args.webrtc:
                ui('choose', 'VDO.Ninja (default)', 'UDP / MPEG-TS (LAN)')
                wait(lambda:bitrate_row_visible('AAC bitrate', 'Opus bitrate'), 'Audio form rows did not follow output mode')
                (report/'aac-form-ui.json').write_text(json.dumps(rows(), indent=2)+'\n')
                result['audioFormRowsFollowOutputMode'] = True
            ui('press', 'Audio encoding')
            ui('text', 'Stream ID or VDO.Ninja URL' if args.webrtc else 'Output URL', destination)
            if args.webrtc: ui('text', 'Stream password', 'false')
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
        def rss_kib():
            return int(next(line.split()[1] for line in Path(f'/proc/{app.pid}/status').read_text().splitlines()
                            if line.startswith('VmRSS:')))
        before_rss = rss_kib(); started = time.monotonic()
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
        result.setdefault('stops', []).append({'elapsedSeconds':time.monotonic()-started,
            'publisherRssBeforeKiB':before_rss, 'publisherRssAfterKiB':rss_kib()})
        save()
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
        if args.webrtc:
            phase = browser_command('observe', label=label, microphone=microphone)
            phase.update(name=label, microphoneExpected=microphone, diagnostics=diagnostics())
            result['phases'].append(phase); save()
            screenshot(label+'-gui')
            print(json.dumps({'phase':label, 'passed':True}), flush=True)
            return
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

    def endurance():
        if not args.endurance_seconds: return
        started = time.monotonic(); next_content = started; previous = None
        result['endurance'] = {'requestedSeconds':args.endurance_seconds, 'completed':False,
                               'samples':[], 'contentIntervalSeconds':60,
                               'avSynchronizationQualified':False}
        while time.monotonic()-started < args.endurance_seconds:
            now = time.monotonic()
            if now >= next_content:
                receive('endurance-'+str(int(now-started)))
                next_content = time.monotonic()+60
            stats = browser_command('stats')
            tracks = [t for peer in stats['peers'] for t in peer['tracks']]
            video = next(t for t in tracks if t.get('kind') == 'video')
            audio = next(t for t in tracks if t.get('kind') == 'audio')
            assert stats['continuity']['now']-stats['continuity']['lastFrameAt'] < 3000, 'Received video stalled'
            if previous:
                assert video['framesDecoded'] > previous[0], 'Video decoder stopped advancing'
                assert audio['totalSamplesReceived'] > previous[1], 'Audio reception stopped advancing'
            previous = video['framesDecoded'], audio['totalSamplesReceived']
            memory = {line.split(':',1)[0]:line.split(':',1)[1].strip()
                      for line in Path(f'/proc/{app.pid}/status').read_text().splitlines()
                      if line.startswith(('VmRSS:', 'VmHWM:', 'RssAnon:', 'Threads:'))}
            result['endurance']['samples'].append({'elapsedSeconds':time.monotonic()-started,
                'publisherMemory':memory, 'receiver':stats, 'diagnostics':diagnostics()})
            save()
            time.sleep(min(5, max(0, args.endurance_seconds-(time.monotonic()-started))))
        receive('endurance-final')
        result['endurance'].update(completed=True, elapsedSeconds=time.monotonic()-started)
        save()

    def performance():
        if not args.performance_seconds: return
        # One core fully occupied is 100%; sample the publisher only. The
        # source, desktop and independent receiver still compete on this host.
        samples = []
        def sample():
            fields = Path(f'/proc/{app.pid}/stat').read_text().rsplit(') ',1)[1].split()
            samples.append({'monotonic':time.monotonic(),
                'cpuSeconds':(int(fields[11])+int(fields[12]))/os.sysconf('SC_CLK_TCK'),
                'rssBytes':int(fields[21])*os.sysconf('SC_PAGE_SIZE'),
                'diagnostics':diagnostics()})
        sample()
        observer.stdin.write(json.dumps({'op':'performance','seconds':args.performance_seconds})+'\n')
        observer.stdin.flush()
        deadline = time.monotonic()+args.performance_seconds+20
        with selectors.DefaultSelector() as selector:
            selector.register(observer.stdout, selectors.EVENT_READ)
            while not selector.select(1):
                assert time.monotonic() < deadline, 'Performance observer timed out'
                sample()
        observation = json.loads(observer.stdout.readline())
        assert observation.get('ok'), observation
        sample()
        result['performance'] = {'receiver':observation, 'publisherSamples':samples,
            'publisherCpuPercent':100*(samples[-1]['cpuSeconds']-samples[0]['cpuSeconds']) /
                (samples[-1]['monotonic']-samples[0]['monotonic']),
            'scope':'Simple moving barcode on owned Xvfb; same-host browser; no game/WAN/physical-display qualification'}
        save(); print(json.dumps({'performance':result['performance']['publisherCpuPercent']}),flush=True)

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
            'load-module module-null-sink sink_name=arm_receiver rate=48000 channels=2\n'
            'load-module module-remap-source master=arm_mic.monitor source_name=arm_input source_properties=device.description=ARMBringupMicrophone\n'
            'set-default-sink arm_system\nset-default-source arm_input\n')
        try:
            pulse = start(['pulseaudio','--daemonize=no','--exit-idle-time=-1','--use-pid-file=no','-nF',str(config)],'pulse')
            wait(lambda:(root/'pulse.sock').exists(), 'Private Pulse server failed')
            assert pactl('get-default-sink')=='arm_system'
            result['pulseServer'] = pactl('info')
            for sink, frequencies in [('arm_system',(440,880)),('arm_mic',(1200,1200) if args.webrtc else (660,1320))]:
                start(['ffmpeg','-v','error','-re','-f','lavfi','-i',
                    f'aevalsrc=0.15*sin(2*PI*{frequencies[0]}*t)|0.15*sin(2*PI*{frequencies[1]}*t):s=48000',
                    '-f','pulse','-device',sink,'ARM bringup owned tone'],sink+'-tone')
            source = start([sys.executable,str(helpers/'linux-installed-desktop.py'),'--source',
                            '--source-size='+args.source_size],'source')
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
                sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
            destination = 'gcarm'+uuid.uuid4().hex if args.webrtc else f'udp://127.0.0.1:{port}'
            wait(lambda:len(json.loads(pactl('--format=json','list','sink-inputs')))==2, 'Owned tone fixtures failed')
            baseline_streams = json.loads(pactl('--format=json','list','source-outputs'))
            audio_baseline = {s['index'] for s in baseline_streams}
            result['fixtureAudioBaseline'] = baseline_streams
            time.sleep(1); launch('initial')
            ui('press','Go live'); wait(lambda:diagnostics()['app']['live'],'Go live failed')
            if args.webrtc:
                log = (report/'observer.log').open('w'); logs.append(log)
                observer = subprocess.Popen([args.node, str(helpers/'linux-webrtc-observer.js'),
                    str(args.browser.resolve()), destination, str(report)], env=env,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
                processes.append(observer); result['browser'] = observer_reply()
                browser_command('connect')
            receive('mixed')
            performance()
            if args.fuzz_seed is not None:
                result['fuzz'] = browser_command('fuzz', discovery=str(discovery), seed=args.fuzz_seed)
                assert diagnostics()['app']['live'], 'Malformed control traffic interrupted publication'
                receive('after-fuzz')
                save()
            ui('press','Mute microphone'); time.sleep(1)
            assert diagnostics()['audio']['microphone_muted']
            receive('muted',microphone=False)
            ui('press','Unmute microphone'); time.sleep(1)
            receive('unmuted')
            if args.webrtc:
                browser_command('connect'); receive('viewer-reconnected')
                endurance()
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
                source = start([sys.executable,str(helpers/'linux-installed-desktop.py'),'--source',
                                '--source-size='+args.source_size],'replacement-source')
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
            if args.webrtc: browser_command('connect')
            receive('restarted'); stop(); quit_app()
            launch('relaunched',restore=True); quit_app()
            if observer:
                browser_command('close')
                observer.stdin.close()
                observer.wait(timeout=10)
                assert observer.returncode == 0
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
