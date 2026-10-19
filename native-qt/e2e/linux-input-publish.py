#!/usr/bin/env python3
"""Packaged GUI -> native GTK window or physical V4L2 input -> local UDP receiver.

Verifies independently decoded pictures, static/resized native windows, camera
preview, late reception, Stop/restart and cleanup. Physical camera scenes are
not controlled motion references; their frames prove decoding, not cadence.
Run inside linux-private-desktop.py or the owned Wayland desktop/keyring.
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
    parser.add_argument('--publisher', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--reports', type=Path, required=True)
    parser.add_argument('--backend', choices=['x11', 'wayland'], required=True)
    parser.add_argument('--encoder', choices=['software', 'nvenc'], default='software')
    parser.add_argument('--camera-label')
    parser.add_argument('--camera-id')
    parser.add_argument('--expected-cursor', choices=['included', 'excluded'])
    args = parser.parse_args()
    assert bool(args.camera_label) == bool(args.camera_id)
    assert not args.expected_cursor or (not args.camera_id and args.backend == 'wayland')
    assert os.environ.get('GC_QA_PRIVATE_DESKTOP') if args.backend == 'x11' else os.environ.get('GC_QA_OWNED_WAYLAND')
    exe = args.publisher.resolve(); bundle = exe.parent.parent.parent
    manifest_path = bundle/'release-artifact-manifest.json'
    assert sha(manifest_path) == args.manifest_sha256
    manifest = json.loads(manifest_path.read_text())
    assert sha(exe) == manifest['artifact']['sha256']
    for entry in manifest['payload']['files']:
        path = (bundle/entry['relativePath']).resolve()
        assert path.is_relative_to(bundle) and sha(path) == entry['sha256'] and path.stat().st_size == entry['size']
    report = args.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True, mode=0o700)
    helpers = Path(__file__).parent
    result = dict(scope=__doc__, passed=False, manifestSha256=sha(manifest_path),
                  executableSha256=sha(exe), requested=vars(args).copy(), phases=[], harnesses={})
    if args.expected_cursor:
        result['scope'] = 'Packaged native Wayland GUI window capture with a controlled native cursor, positive desktop screenshot, independently decoded moving/static/late/restarted video and clean Stop/Quit. Owned software GNOME only; no resize, physical desktop or other compositor qualification.'
    result['requested'] = {k:str(v) if isinstance(v, Path) else v for k,v in result['requested'].items()}
    for name in (Path(__file__).name, 'linux-gtk-source.py', 'linux-ui-control.py', 'linux-portal-select.py'):
        shutil.copy2(helpers/name, report/name); result['harnesses'][name] = sha(helpers/name)
    env = {k:v for k,v in os.environ.items() if not k.startswith(('VERSUS_', 'GAME_CAPTURE_'))}
    env.update(QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1', VERSUS_FRAME_TRACE=str(report/'frame-trace.csv'),
               VERSUS_TRACE_REJECTED_CAPTURE='1', GDK_BACKEND='wayland' if args.backend=='wayland' else 'x11')
    env['XDG_STATE_HOME'] = str(report/'private-state')
    discovery = report/'private-control.json'
    children = []; logs = []; app = source = None; control = None
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def save(): (report/'results.json').write_text(json.dumps(result, indent=2)+'\n')
    def start(argv, label, interactive=False):
        log = (report/(label+'.log')).open('wb'); logs.append(log)
        child = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE if interactive else subprocess.DEVNULL,
            stdout=subprocess.PIPE if interactive else log, stderr=log, text=interactive)
        children.append(child); return child
    def wait(check, message, seconds=25):
        deadline = time.monotonic()+seconds
        while time.monotonic() < deadline:
            assert app is None or app.poll() is None, 'Application exited'
            value = check()
            if value: return value
            time.sleep(.15)
        raise RuntimeError(message)
    def ui(*argv):
        return subprocess.check_output([sys.executable, str(helpers/'linux-ui-control.py'), str(app.pid), *argv],
                                       env=env, text=True, timeout=60)
    def api(route='/diagnostics', body=None):
        request = urllib.request.Request(control['base_url']+route, data=json.dumps(body).encode() if body else None,
            headers={'Authorization':'Bearer '+control['token'], 'Content-Type':'application/json'})
        with direct.open(request, timeout=5) as response: return json.load(response)
    def command(action, **values):
        source.stdin.write(json.dumps(dict(action=action, **values))+'\n'); source.stdin.flush()
        assert select.select([source.stdout], [], [], 5)[0], 'Native source control timeout'
        return json.loads(source.stdout.readline())
    def go_live(label):
        selector = None
        if args.backend == 'wayland' and not args.camera_id:
            selector = start([sys.executable, str(helpers/'linux-portal-select.py'),
                '--title=Owned Linux Capture Native GTK Source', '--output='+str(report/(label+'-portal.json'))], label+'-portal')
        ui('press', 'Go live')
        wait(lambda:api()['app']['live'], 'Go live failed', 40)
        if selector:
            selector.wait(timeout=20); assert selector.returncode == 0
            assert json.loads((report/(label+'-portal.json')).read_text())['passed']
        d = api(); assert d['video']['active_encoder'] == ('h264_nvenc' if args.encoder=='nvenc' else 'libx264')
        assert d['video']['hardware_encoder'] == (args.encoder=='nvenc')
        if args.camera_id:
            selected = d['source']['source_id']
            assert selected.startswith('v4l2:') and args.camera_id.startswith('v4l2:')
            assert Path(selected[5:]).resolve(strict=True) == Path(args.camera_id[5:]).resolve(strict=True)
            result['selectedCameraId'] = selected
    def stop():
        ui('press', 'Stop streaming'); wait(lambda:not api()['app']['capturing'], 'Stop failed')
        before = api(); time.sleep(.6); after = api()
        assert not after['app']['live'] and not after['app']['primary_audio_capturing'] and not after['app']['microphone_capturing']
        assert before['video']['frames_captured'] == after['video']['frames_captured']
    def position_cursor(label):
        def input_event(value):
            with socket.socket(socket.AF_UNIX) as pointer:
                pointer.settimeout(5); pointer.connect(os.environ['GC_QA_KEYBOARD_SOCKET'])
                pointer.sendall(json.dumps(value).encode()+b'\n')
                assert pointer.recv(32) == b'ok'
        command('present'); time.sleep(.5)
        if not command('state')['focused']:
            input_event(['ALT_TAB']); time.sleep(.5)
        assert command('state')['focused'], 'Native source did not gain focus'
        input_event({'pointer':[720,150]}); time.sleep(1)
        state = command('state')
        shot = report/(label+'-cursor-desktop.png')
        subprocess.run(['gnome-screenshot','--include-pointer','-f',str(shot)],env=env,check=True,timeout=10)
        pixels = np.array(Image.open(shot).convert('RGB'))
        positive_pixels = int(((pixels[:,:,0]>200)&(pixels[:,:,1]>180)&(pixels[:,:,2]<60)).sum())
        result.setdefault('controlledCursor', []).append(dict(phase=label, source=state, desktopCursorPixels=positive_pixels, screenshotSha256=sha(shot)))
        save()
        assert state['pointer']['inside'] and 0 <= state['pointer']['x'] < state['width'] and 0 <= state['pointer']['y'] < state['height']*.25
        assert positive_pixels >= 300, 'Native cursor positive control missing'
    def receive(label, static=False):
        before = api(); source_before = command('state') if source else None
        transport = report/(label+'.ts')
        rx = start(['ffmpeg','-hide_banner','-loglevel','warning','-threads','2',
            '-analyzeduration','1000000','-probesize','1000000','-i',destination+'?fifo_size=8192&overrun_nonfatal=1',
            '-map','0:v:0','-c','copy','-t','5','-f','mpegts',str(transport)], label+'-receiver')
        rx.wait(timeout=35); assert rx.returncode == 0
        probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(transport)], text=True))
        video = next(s for s in probe['streams'] if s['codec_type']=='video')
        # Camera mode uses its Camera Resolution control for capture and
        # encoding; the separate Stream Resolution control applies to windows.
        expected_size = (1280,720) if args.camera_id else (960,540)
        assert video['codec_name']=='h264' and (video['width'], video['height']) == expected_size
        assert not any(s['codec_type']=='audio' for s in probe['streams']), 'No-audio selection leaked audio'
        raw = report/(label+'.rgb')
        subprocess.run(['ffmpeg','-v','error','-threads','2','-filter_threads','1','-i',str(transport),
            '-an','-vf','scale=320:180','-pix_fmt','rgb24','-f','rawvideo',str(raw)], check=True, timeout=30)
        frames = np.fromfile(raw, dtype=np.uint8).reshape(-1,180,320,3)
        phase = dict(name=label, decodedFrames=len(frames), transportSha256=sha(transport), decodedSha256=sha(raw),
                     before=before, after=api(), sourceBefore=source_before, sourceAfter=command('state') if source else None)
        result['phases'].append(phase); save()
        assert len(frames)>=120, 'Insufficient decoded video'
        if args.expected_cursor:
            for snapshot in (phase['sourceBefore'], phase['sourceAfter']):
                pointer = snapshot['pointer']
                assert pointer['inside'] and 0 <= pointer['x'] < snapshot['width'] and 0 <= pointer['y'] < snapshot['height']*.25, 'Cursor left its controlled source region'
            # The controlled cursor lies in this otherwise uniform blue strip,
            # above the barcode and below the title. The baseline's embedded
            # cursor has red/blue swapped relative to the desktop screenshot;
            # count bright pixels without assuming its channel order.
            probe = frames[:,12:45,80:240,:]
            bright = ((probe[:,:,:,1] > 170) & ((probe[:,:,:,0] > 170) | (probe[:,:,:,2] > 170))).sum(axis=(1,2))
            phase['cursorPixels'] = dict(minimum=int(bright.min()), maximum=int(bright.max()), region=[80,12,160,33])
            save()
            assert bright.min() >= 30 if args.expected_cursor == 'included' else bright.max() == 0, 'Received cursor differs from expected Windows/macOS behavior'
        if source:
            identities = []
            for frame in frames:
                row = frame[90].astype(int)
                cyan = np.flatnonzero((row[:,0]<70)&(row[:,1]>170)&(row[:,2]>170))
                magenta = np.flatnonzero((row[:,0]>170)&(row[:,1]<70)&(row[:,2]>170))
                assert len(cyan) and len(magenta), 'Missing source markers'
                width = (int(magenta[0])-int(cyan[0]))/.75; left = int(cyan[0])-width*.1
                identity = 0
                for bit in range(16):
                    pixel = row[round(left+width*(.2+(bit+.5)*.6/16))]
                    assert max(pixel)-min(pixel)<45 and not 85<pixel[0]<170, 'Corrupt barcode'
                    if pixel[0]>127: identity |= 1<<bit
                identities.append(identity)
            phase['uniqueIdentities'] = len(set(identities)); save()
            assert len(set(identities)) == 1 if static else len(set(identities)) >= 90, 'Static/moving native source mismatch'
        else:
            # Optical scenes can be stationary. Preserve quantitative image
            # evidence without claiming motion or saving a public camera feed.
            phase['imageStandardDeviation'] = float(frames.astype(float).std())
            phase['uniqueDecodedFrames'] = len({hashlib.sha256(f.tobytes()).digest() for f in frames})
            assert phase['imageStandardDeviation'] > 5, 'Camera image is blank'
        phase['passed'] = True; save(); print(json.dumps({'phase':label,'passed':True}), flush=True)

    print('Report:', report, flush=True); save()
    try:
        if not args.camera_id:
            source = start([sys.executable, str(helpers/'linux-gtk-source.py')], 'source', True)
            time.sleep(1); result['initialSource'] = command('state')
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(('127.0.0.1',0)); destination = 'udp://127.0.0.1:'+str(sock.getsockname()[1])
        app = start([str(exe), '--settings-dir='+str(report/'settings'), '--local-control',
            '--local-control-port=0', '--local-control-discovery='+str(discovery)], 'app')
        wait(discovery.exists, 'No local control'); control = json.loads(discovery.read_text()); assert control['pid']==app.pid
        wait(lambda:any(r['name']=='Show advanced settings' for r in json.loads(ui('dump'))), 'GUI unavailable')
        assert not api()['app']['capturing']
        ui('press', 'Show advanced settings')
        if args.camera_id: ui('choose', 'Window', 'Camera / Webcam')
        ui('choose', 'VDO.Ninja (default)', 'UDP / MPEG-TS (LAN)'); ui('text', 'Output URL', destination)
        ui('choose', 'Auto (Hardware, then Software)', 'NVIDIA NVENC' if args.encoder=='nvenc' else 'Software (x264 / VP9 / AV1 / HEVC)')
        if args.camera_id:
            ui('choose', '1920x1080', '1280x720')
        else:
            ui('choose', '1280x720', '960x540'); ui('choose', '60', '30')
        rows = json.loads(ui('dump'))
        selected_audio = next(r['name'] for r in rows if r['role']=='combo box' and r['name'] in ['Selected window/app audio','Selected microphone/input','No audio'])
        if selected_audio != 'No audio': ui('choose', selected_audio, 'No audio')
        if not any(r['role']=='combo box' and r['name']=='No microphone' for r in rows):
            ui('choose', 'Linux default microphone/input', 'No microphone')
        ui('source', args.camera_label or ('Choose a window' if args.backend=='wayland' else 'Owned Linux Capture Native GTK Source'))
        go_live('initial')
        if args.expected_cursor:
            command('cursor'); time.sleep(1); position_cursor('initial')
        receive('moving')
        if source:
            command('pause'); time.sleep(1); receive('static', True)
            command('resume')
            if not args.expected_cursor:
                command('resize', width=600, height=400); time.sleep(1)
                resized = command('state'); result['resizedSource'] = resized
                assert (resized['width'],resized['height']) != (result['initialSource']['width'],result['initialSource']['height'])
                receive('resized')
            time.sleep(4); receive('late')
        else:
            ui('activate')
            result['livePreview'] = json.loads(ui('preview'))
            px, py, pw, ph = result['livePreview']['preview']
            assert pw > 40 and ph > 40
            if args.backend == 'x11':
                picture = ImageGrab.grab().crop((px,py,px+pw,py+ph)).convert('RGB')
            else:
                shot = report/'private-desktop.png'
                subprocess.run(['gnome-screenshot','-f',str(shot)],env=env,check=True,timeout=10)
                picture = Image.open(shot).convert('RGB').crop((px,py,px+pw,py+ph))
            picture.save(report/'private-camera-preview.png')
            pixels = np.array(picture)[ph//4:3*ph//4, pw//4:3*pw//4]
            result['livePreview']['centerStandardDeviation'] = float(pixels.astype(float).std())
            result['livePreview']['uniqueCenterColors'] = len(np.unique(pixels.reshape(-1,3),axis=0))
            assert result['livePreview']['centerStandardDeviation'] > 5 and result['livePreview']['uniqueCenterColors'] > 100, 'Camera preview is blank'
            receive('late')
        stop(); result['stopPassed'] = True
        go_live('restart')
        if args.expected_cursor: position_cursor('restart')
        receive('restarted'); stop(); result['restartPassed'] = True
        if args.expected_cursor: ui('activate')
        ui('quit-menu'); app.wait(timeout=15)
        assert app.returncode == 0 and not discovery.exists()
        result['passed'] = True
    except Exception:
        result['error'] = traceback.format_exc()
        try: result['failureDiagnostics'] = api()
        except Exception: pass
    finally:
        if app and app.poll() is None:
            try: api('/commands', {'command':'quit'}); app.wait(timeout=8)
            except Exception: pass
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
        for log in logs: log.close()
        result['ownedProcessesRetired'] = all(c.poll() is not None for c in children)
        result['discoveryRemoved'] = not discovery.exists()
        save()
    print(json.dumps(dict(report=str(report), passed=result['passed'], error=result.get('error'))), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
