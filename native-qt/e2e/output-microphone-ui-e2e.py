"""Packaged camera -> UDP receiver; real UI opt-in/mute and saved defaults.

Backs up/restores publisher settings and uses loopback destinations only.
Requires the existing Windows desktop QA Python environment and a microphone.
"""
import argparse, ctypes, hashlib, importlib.util, json, os, subprocess, time, urllib.request
from pathlib import Path
import numpy as np
import psutil
import win32gui, win32con
from pywinauto import Application

spec=importlib.util.spec_from_file_location('desktop',Path(__file__).with_name('desktop-ui-e2e.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--publisher',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();exe=args.publisher.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
    ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe';children=[];logs=[];window=None
    saved=d.snapshot(d.SETTINGS_KEY);report={'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'cases':[]}
    (out/'settings-backup.txt').write_text(repr(saved),encoding='utf-8')
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000003)
    def launch(argv,name):
        log=(out/(name+'.log')).open('wb');logs.append(log)
        p=subprocess.Popen([str(a) for a in argv],stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW,
            env=dict(os.environ,LOCALAPPDATA=str(out),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'));children.append(p);return p
    def api(route='/diagnostics',body=None):
        info=json.loads(discovery.read_text());req=urllib.request.Request(info['base_url']+route,data=json.dumps(body).encode() if body else None,
            headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
    def ui(name):
        def find():return next((c for c in window.descendants() if (c.element_info.automation_id or '').endswith('.'+name)),None)
        d.wait_for(lambda:find() is not None,name,10);return find()
    def reveal(c):
        window.set_focus();window.wheel_mouse_input(coords=(window.rectangle().width()-25,150),wheel_dist=80);time.sleep(.2)
        for _ in range(80):
            rect,view=c.rectangle(),window.rectangle()
            if view.top+65<rect.mid_point().y<view.bottom-55:return
            window.wheel_mouse_input(coords=(view.width()-25,150),wheel_dist=-2);time.sleep(.08)
        raise AssertionError('Cannot reach '+c.window_text())
    def select(name,text):
        c=ui(name);reveal(c);c.expand()
        def items():return [x for w in app.windows() for x in w.descendants(control_type='ListItem') if x.window_text()==text and x.is_visible()]
        d.wait_for(lambda:bool(items()),text);items()[0].click_input();d.wait_for(lambda:ui(name).selected_text()==text,text)
    def shot(name):window.capture_as_image().save(out/(name+'.png'))
    def start_receive(name,seconds=6):
        return launch([ffmpeg,'-v','warning','-y','-i','udp://127.0.0.1:18896?fifo_size=8192&overrun_nonfatal=1','-t',str(seconds),'-map','0','-c','copy',out/(name+'.mkv')],name)
    def check_clip(name,audio):
        path=out/(name+'.mkv')
        decoded=subprocess.run([str(ffmpeg),'-v','error','-i',str(path),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=30)
        assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
        raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(path),'-vn','-f','f32le','-ac','1','-ar','48000','pipe:1'],capture_output=True,timeout=30)
        if not audio:assert raw.returncode!=0;return {'audio':False,'bytes':path.stat().st_size}
        assert raw.returncode==0 and len(raw.stdout)>48000*4
        samples=np.frombuffer(raw.stdout,dtype=np.float32)[24000:]
        return {'audio':True,'rms':float(np.sqrt(np.mean(samples**2))),'peak':float(np.max(np.abs(samples))),'bytes':path.stat().st_size}
    try:
        d.restore(d.SETTINGS_KEY,{})
        for restart in range(2):
            discovery=out/f'control-{restart}.json';proc=launch([exe,'--local-control','--local-control-discovery='+str(discovery)],'publisher-'+str(restart))
            app=Application(backend='uia').connect(process=proc.pid,timeout=20);window=d.application_window(proc.pid)
            window.maximize();window.set_focus();win32gui.SetWindowPos(window.handle,win32con.HWND_TOPMOST,0,0,0,0,win32con.SWP_NOMOVE|win32con.SWP_NOSIZE)
            d.wait_for(discovery.exists,'control endpoint')
            if restart:
                assert ui('microphoneDeviceSelect').selected_text()=='No microphone'
                assert not ui('microphoneMuteButton').is_enabled()
                assert ui('bitrateSelect').selected_text()=='Standard (2500 kbps)'
                assert ui('outputUrlInput').get_value()=='rist://127.0.0.1:18894'
                report['persisted']=True
                api('/commands',{'command':'quit'});assert proc.wait(timeout=15)==0;break
            assert ui('microphoneDeviceSelect').selected_text()=='No microphone'
            assert not ui('microphoneMuteButton').is_enabled()
            assert not ui('advancedToggle').get_toggle_state()
            shot('default')
            select('sourceModeSelect','Camera / Webcam')
            camera=window.child_window(title_re='HD Pro Webcam C920.*',control_type='ListItem')
            camera.wait('visible',timeout=15);camera.click_input()
            assert ui('microphoneDeviceSelect').selected_text()=='No microphone'
            ui('advancedToggle').toggle()
            assert ui('audioSourceSelect').selected_text()=='No audio'
            assert ui('bitrateSelect').selected_text()=='Standard (2500 kbps)'
            select('outputSelect','UDP / MPEG-TS (LAN)');ui('outputUrlInput').set_edit_text('udp://127.0.0.1:18896')
            shot('udp-settings')
            receiver=start_receive('no-microphone');ui('goLiveButton').invoke()
            d.wait_for(lambda:api().get('output',{}).get('state')==2,'camera publishing',45)
            assert api()['video']['configured_bitrate_kbps']==2500
            receiver.wait(timeout=30);assert receiver.returncode==0
            assert api()['audio']['codec']=='none'
            report['cases'].append({'name':'no-microphone',**check_clip('no-microphone',False)})
            ui('goLiveButton').invoke();d.wait_for(lambda:ui('microphoneDeviceSelect').is_enabled(),'stopped',30)
            select('microphoneDeviceSelect','Windows default microphone/input')
            assert ui('microphoneMuteButton').is_enabled()
            receiver=start_receive('microphone-unmuted');ui('goLiveButton').invoke()
            d.wait_for(lambda:api().get('output',{}).get('state')==2,'mic publishing',45)
            receiver.wait(timeout=30);assert receiver.returncode==0
            live=check_clip('microphone-unmuted',True);assert live['rms']>1e-7,live
            report['cases'].append({'name':'unmuted',**live})
            reveal(ui('microphoneMuteButton'));ui('microphoneMuteButton').invoke();time.sleep(.5)
            assert api()['audio']['microphone_muted']
            receiver=start_receive('microphone-muted');receiver.wait(timeout=30);assert receiver.returncode==0
            muted=check_clip('microphone-muted',True);assert muted['peak']<1e-6,muted
            report['cases'].append({'name':'muted',**muted});shot('live-muted')
            ui('microphoneMuteButton').invoke();time.sleep(.5)
            receiver=start_receive('microphone-restored');receiver.wait(timeout=30);assert receiver.returncode==0
            restored=check_clip('microphone-restored',True);assert restored['rms']>1e-7,restored
            report['cases'].append({'name':'unmute-restored',**restored})
            ui('goLiveButton').invoke();d.wait_for(lambda:ui('microphoneDeviceSelect').is_enabled(),'stopped',30)
            select('audioSourceSelect','Selected microphone/input')
            ui('microphoneMuteButton').invoke()
            receiver=start_receive('primary-microphone-muted');ui('goLiveButton').invoke()
            d.wait_for(lambda:api().get('output',{}).get('state')==2,'primary mic publishing',45)
            receiver.wait(timeout=30);assert receiver.returncode==0
            muted=check_clip('primary-microphone-muted',True);assert muted['peak']<1e-6,muted
            report['cases'].append({'name':'primary-muted',**muted})
            ui('microphoneMuteButton').invoke();time.sleep(.5)
            receiver=start_receive('primary-microphone-restored');receiver.wait(timeout=30);assert receiver.returncode==0
            restored=check_clip('primary-microphone-restored',True);assert restored['rms']>1e-7,restored
            report['cases'].append({'name':'primary-unmute-restored',**restored})
            ui('goLiveButton').invoke();d.wait_for(lambda:ui('microphoneDeviceSelect').is_enabled(),'stopped',30)
            select('microphoneDeviceSelect','No microphone');assert not ui('microphoneMuteButton').is_enabled()
            select('outputSelect','RIST');ui('outputUrlInput').set_edit_text('rist://127.0.0.1:18894');shot('rist-settings')
            # Actual vendor initialization on a non-AMD host must fail clearly,
            # not silently claim AMD while sending from another encoder.
            select('encoderSelect','AMD AMF');ui('goLiveButton').invoke();time.sleep(8)
            report['amdDiagnostics']=api()
            assert api().get('output',{}).get('state')!=2,'This host unexpectedly has a working AMD encoder; verify it separately'
            select('encoderSelect','Auto (Hardware, then Software)')
            api('/commands',{'command':'quit'});assert proc.wait(timeout=15)==0
        report['passed']=True
    except BaseException as error:
        report['error']=repr(error)
        if window:
            try:shot('failure')
            except Exception:pass
        raise
    finally:
        for child in children:
            if child.poll() is None:
                try:
                    for p in psutil.Process(child.pid).children(recursive=True):p.kill()
                except psutil.NoSuchProcess:pass
                child.kill()
            child.wait(timeout=15)
        for log in logs:log.close()
        def canonical(value):
            if isinstance(value,dict):return {k:canonical(v) for k,v in sorted(value.items())}
            if isinstance(value,list):return sorted(value,key=lambda row:row[0])
            return value
        d.restore(d.SETTINGS_KEY,saved);report['settingsRestored']=canonical(d.snapshot(d.SETTINGS_KEY))==canonical(saved)
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        (out/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        assert report['settingsRestored']

if __name__=='__main__':main()
