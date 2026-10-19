#!/usr/bin/env python3
"""Packaged physical V4L2 camera GUI, received media, busy retry and lifecycle.

Uses a private X11 desktop with the explicitly selected host camera/audio input.
Black or static input is recorded as such; it cannot qualify moving-image or
audio-content fidelity. No host device permissions or services are modified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
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
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--publisher', required=True, type=Path)
    p.add_argument('--manifest-sha256', required=True)
    p.add_argument('--reports', required=True, type=Path)
    p.add_argument('--camera-label', required=True)
    p.add_argument('--camera-device', default='/dev/video0', type=Path)
    p.add_argument('--audio-label')
    p.add_argument('--camera-resolution', choices=['1920x1080','1280x720','640x480'], default='1920x1080')
    p.add_argument('--minimum-capture-fps', type=float, default=24)
    p.add_argument('--baseline', action='store_true')
    a = p.parse_args()
    assert os.environ.get('GC_QA_PRIVATE_DESKTOP') and os.environ.get('QT_QPA_PLATFORM') == 'xcb'
    exe = a.publisher.resolve(); bundle = exe.parents[2]
    mp = bundle/'release-artifact-manifest.json'; assert sha(mp) == a.manifest_sha256
    m = json.loads(mp.read_text()); assert sha(exe) == m['artifact']['sha256']
    for entry in m['payload']['files']:
        f = (bundle/entry['relativePath']).resolve()
        assert f.is_relative_to(bundle) and f.stat().st_size == entry['size'] and sha(f) == entry['sha256']
    launcher = (bundle/m.get('launcher',m['artifact']['path'])).resolve()
    report = a.reports.resolve()/str(uuid.uuid4()); report.mkdir(parents=True,mode=0o700)
    helper = Path(__file__).with_name('linux-ui-control.py')
    for f in [Path(__file__),helper]: shutil.copy2(f,report/f.name)
    result = {'scope':__doc__,'passed':False,'manifestSha256':sha(mp),'executableSha256':sha(exe),
              'sourceTreeSha256':m['sourceTreeSha256'],'harnessSha256':sha(__file__),
              'guiHelperSha256':sha(helper),'cameraDevice':str(a.camera_device),
              'cameraLabel':a.camera_label,'audioLabel':a.audio_label,'phases':[]}
    processes=[]; logs=[]; app=None; control=None; owner=None; helper_pids={}
    discovery=report/'private-control.json'; settings=report/'private-settings'
    direct=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
    destination=f'udp://127.0.0.1:{port}'
    identity=a.camera_device.stat().st_rdev
    def save(): (report/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    def start(command,label):
        log=(report/(label+'.log')).open('wb');logs.append(log)
        child=subprocess.Popen(command,stdout=log,stderr=log);processes.append(child);return child
    def wait(check,message,seconds=20):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if app: assert app.poll() is None,'Application exited'
            value=check()
            if value:return value
            time.sleep(.15)
        raise RuntimeError(message)
    def ui(*args):return subprocess.check_output([sys.executable,str(helper),str(app.pid),*args],text=True,timeout=20)
    def rows():return json.loads(ui('dump'))
    def diag():
        req=urllib.request.Request(control['base_url']+'/diagnostics',headers={'Authorization':'Bearer '+control['token']})
        with direct.open(req,timeout=5) as response:return json.load(response)
    def idle():
        d=diag();assert not d['app']['live'] and not d['app']['capturing']
        assert not d['app']['primary_audio_capturing'] and not d['app']['microphone_capturing']
    def process_identity(pid):
        try:
            fields=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
            return int(fields[1]),fields[19]
        except FileNotFoundError:return None
    def same_process(pid,identity):
        current=process_identity(pid)
        return current is not None and current[1]==identity[1]
    def shot(label):ImageGrab.grab().save(report/(label+'.png'))
    def launch(label,restore=False):
        nonlocal app,control
        app=start([str(launcher),'--settings-dir='+str(settings),'--local-control','--local-control-port=0',
                   '--local-control-discovery='+str(discovery)],label)
        wait(discovery.exists,'No discovery');control=json.loads(discovery.read_text());assert control['pid']==app.pid
        wait(lambda:any(r['name']=='Show advanced settings' for r in rows()),'GUI not ready');idle()
        if not any(r['name']=='Show advanced settings' and 'checked' in r['states'] for r in rows()):ui('press','Show advanced settings')
        if restore:
            for name in ['Camera / Webcam',a.camera_resolution,'30','UDP / MPEG-TS (LAN)']:
                assert any(r['role']=='combo box' and r['name']==name for r in rows()),'Lost setting: '+name
            assert json.loads(ui('read-text','Output URL'))==destination
            result['settingsRestoredWithoutCapture']=True
        else:
            initial=rows();(report/'initial-ui.json').write_text(json.dumps(initial,indent=2)+'\n')
            assert any(r['role']=='combo box' and r['name']=='1280x720' for r in initial)
            fps='30' if any(r['role']=='combo box' and r['name']=='30' for r in initial) else '60'
            result['initialWindowFps']=int(fps)
            if not a.baseline:assert fps=='30','ARM first-run frame rate is not 30'
            if fps!='30':ui('choose',fps,'30')
            ui('choose','Window','Camera / Webcam')
            if a.camera_resolution!='1920x1080':ui('choose','1920x1080',a.camera_resolution)
            ui('choose','VDO.Ninja (default)','UDP / MPEG-TS (LAN)');ui('text','Output URL',destination)
            ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)')
            if a.audio_label:ui('choose-prefix','No microphone',a.audio_label)
        ui('source',a.camera_label);shot(label+'-ready')
    def live():
        ui('press','Go live');wait(lambda:diag()['app']['live'],'Camera Go live failed',25)
    def stop():
        ui('press','Stop streaming');wait(lambda:not diag()['app']['capturing'],'Camera Stop failed');idle()
        # No camera FD may remain in the application after Stop.
        def holds_camera():
            for f in Path(f'/proc/{app.pid}/fd').iterdir():
                try:
                    if f.stat().st_rdev==identity:return True
                except FileNotFoundError:pass
            return False
        wait(lambda:not holds_camera(),'Camera descriptor leaked after Stop')
        wait(lambda:all(not same_process(pid,identity) for pid,identity in helper_pids.items()),'Output helper survived Stop')
        helper_pids.clear()
    def quit_app():
        nonlocal app
        ui('quit-menu');assert app.wait(timeout=15)==0 and not discovery.exists()
        log=Path(os.environ['XDG_STATE_HOME'])/'GameCapture/logs/game-capture-debug.log'
        if log.exists():shutil.copy2(log,report/f'publisher-{app.pid}-debug.log')
        app=None
    def receive(label):
        transport=report/(label+'.ts');before=diag();t=time.monotonic()
        receiver=start(['ffmpeg','-nostdin','-hide_banner','-loglevel','warning','-threads','2',
            '-analyzeduration','6000000','-probesize','3000000','-i',destination+'?fifo_size=8192&overrun_nonfatal=1',
            '-map','0:v:0','-map','0:a:0?','-c','copy','-t','5','-f','mpegts',str(transport)],label+'-receiver')
        assert receiver.wait(timeout=30)==0;elapsed=time.monotonic()-t;after=diag()
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():continue
            ident=process_identity(process.name)
            if ident and ident[0]==app.pid:
                try:
                    target=(process/'exe').resolve(strict=True)
                    if target.name=='ffmpeg':
                        helper_pids[int(process.name)]=ident
                        if m.get('packageFormat')=='portable-tar':assert target==bundle/'usr/lib/game-capture/ffmpeg'
                except FileNotFoundError:pass
        assert helper_pids,'No output helper observed'
        assert after['source']['mode']=='camera' and Path(after['source']['source_id'].removeprefix('v4l2:')).resolve()==a.camera_device.resolve()
        if a.audio_label:
            assert after['app']['microphone_capturing'] and a.audio_label in after['audio']['active_microphone_source']
            assert not after['audio']['capture_warning']
        captured=after['video']['frames_captured']-before['video']['frames_captured']
        result.setdefault('captureObservations',[]).append({'name':label,'before':before,'after':after,'elapsedSeconds':elapsed,'capturedFrames':captured})
        result['profileStorageWarnings']=[r['name'] for r in rows() if 'Output destinations could not be saved' in r['name']]
        save()
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(transport)],text=True))
        video=next(s for s in probe['streams'] if s['codec_type']=='video')
        assert video['codec_name']=='h264' and (video['width'],video['height'])==tuple(map(int,a.camera_resolution.split('x')))
        raw=report/(label+'.rgb')
        command=['ffmpeg','-nostdin','-v','error','-threads','2','-filter_threads','1','-i',str(transport),
            '-map','0:v:0','-an','-vf','scale=160:90','-pix_fmt','rgb24','-f','rawvideo',str(raw)]
        if a.audio_label:
            audio=next(s for s in probe['streams'] if s['codec_type']=='audio');assert audio['codec_name']=='aac' and audio['channels']==2
            command+=['-map','0:a:0','-vn','-ar','48000','-ac','2','-f','f32le',str(report/(label+'.f32'))]
        subprocess.run(command,check=True,timeout=30)
        frames=np.fromfile(raw,dtype=np.uint8).reshape(-1,90,160,3);assert len(frames)>0
        phase={'name':label,'decodedFrames':len(frames),'capturedFrames':captured,'elapsedSeconds':elapsed,
               'captureFps':captured/elapsed,'uniqueDecodedFrames':len({hashlib.sha256(f.tobytes()).digest() for f in frames}),
               'decodedMean':float(frames.mean()),'decodedMax':int(frames.max()),
               'transportSha256':sha(transport),'decodedVideoSha256':sha(raw),'diagnostics':after}
        if a.audio_label:
            pcm=report/(label+'.f32');samples=np.fromfile(pcm,dtype='<f4').reshape(-1,2)
            assert len(samples)>=48000*3 and np.isfinite(samples).all()
            phase.update(audioSamplesPerChannel=len(samples),audioRms=float(np.sqrt(np.mean(samples.astype(float)**2))),
                         audioPeak=float(np.abs(samples).max()),decodedAudioSha256=sha(pcm))
        Image.fromarray(frames[len(frames)//2]).save(report/(label+'-decoded.png'));shot(label+'-gui')
        result['phases'].append(phase);save()
        assert phase['captureFps']>=a.minimum_capture_fps,f'Camera delivers only {phase["captureFps"]:.2f} fps'
        assert len(frames)>=90,'Insufficient decoded video frames'
    print('Report:',report,flush=True);save()
    try:
        launch('initial');live();receive('initial');stop()
        owner_output=report/'busy-owner.framehash'
        owner=start(['ffmpeg','-nostdin','-hide_banner','-loglevel','warning','-f','v4l2','-input_format','mjpeg',
                     '-video_size','1280x720','-framerate','30','-i',str(a.camera_device),'-threads','2','-filter_threads','1',
                     '-vf','scale=32:18','-pix_fmt','gray','-c:v','rawvideo','-flush_packets','1','-f','framehash',str(owner_output)],'busy-owner')
        def owner_frames():return sum(line.startswith('0,') for line in owner_output.read_text().splitlines()) if owner_output.exists() else 0
        wait(lambda:owner_frames()>=3,'Independent camera owner not ready')
        ui('press','Go live')
        wait(lambda:any('Device or resource busy' in r['name'] for r in rows()),'Missing actionable busy-camera error')
        idle();assert owner.poll() is None;shot('busy-error');result['busyCameraRejected']=True
        before=owner_frames();time.sleep(2);after=owner_frames()
        assert owner.poll() is None and after-before>=30,'Existing camera stream interrupted'
        result['busyOwnerFramesDuringTwoSeconds']=after-before
        owner.terminate();assert owner.wait(timeout=10) in [0,255,-15];owner=None
        live();receive('busy-retry');stop();live();receive('restarted');stop();quit_app()
        launch('restored',True);quit_app();result['passed']=True
    except Exception as e:
        result['error']=repr(e)
        result['traceback']=traceback.format_exc()
        if app and app.poll() is None:
            try:(report/'failure-ui.json').write_text(json.dumps(rows(),indent=2));shot('failure')
            except Exception:pass
    finally:
        if app and app.poll() is None:
            try:
                if control and diag()['app']['capturing']:stop()
                quit_app()
            except Exception:pass
        for child in reversed(processes):
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
        for log in logs:log.close()
        result['ownedProcessesRetired']=all(c.poll() is not None for c in processes)
        result['discoveryRemoved']=not discovery.exists()
        result['hostDeviceUnchanged']=a.camera_device.stat().st_rdev==identity
        result['passed']=result['passed'] and result['ownedProcessesRetired'] and result['discoveryRemoved'] and result['hostDeviceUnchanged']
        save();print(json.dumps({'report':str(report),'passed':result['passed'],'error':result.get('error')}),flush=True)
    return 0 if result['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
