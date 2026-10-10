"""Click through repeated packaged capture cycles and inspect compact layouts."""
import argparse
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import frida
import psutil
from pywinauto import Application
import win32api
import win32con
import win32gui

spec=importlib.util.spec_from_file_location('desktop',Path(__file__).with_name('desktop-ui-e2e.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--publisher',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--cycles',type=int,default=12)
    a=parser.parse_args();exe=a.publisher.resolve();output=a.output.resolve();output.mkdir(parents=True)
    assert not any(p.name()=='game-capture.exe' for p in psutil.process_iter()),'Existing capture session'
    saved=d.snapshot(d.SETTINGS_KEY);children=[];logs=[];events=[];report={'cycles':[],'screenshots':[]}
    stream='guicycle'+uuid.uuid4().hex;discovery=output/'control.json';window=None
    def launch(cmd,name):
        log=(output/(name+'.log')).open('w',encoding='utf-8');logs.append(log)
        child=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,
            env=dict(os.environ,LOCALAPPDATA=str(output),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'))
        children.append(child);return child
    def api(route='/diagnostics',body=None):
        from urllib.request import Request,urlopen
        info=json.loads(discovery.read_text())
        req=Request(info['base_url']+route,data=json.dumps(body).encode() if body else None,
            headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
        with urlopen(req,timeout=5) as response:return json.load(response)
    try:
        for group,name,value in [('video','sourceMode','window'),('video','codec','h264'),('video','encoderMode','auto'),
            ('video','alphaWorkflow','false'),('video','resolution','960x540'),('video','fps','30'),('video','ffmpegPath',''),
            ('audio','source','default-output'),('audio','includeMicrophone','false'),('audio','bitrateKbps','192'),
            ('audio','channels','2'),('audio','primaryGainPercent','100'),('audio','limiterEnabled','true'),
            ('audio','codec','opus'),('audio','red','false'),('ui','advancedVisible','false'),('stream','target',stream),
            ('stream','room',''),('stream','password','false'),('control','enabled','false'),('network','iceMode','all')]:d.setting(group,name,value)
        launch([sys.executable,str(Path(__file__).with_name('desktop-ui-e2e.py')),'--source-window'],'source')
        launch(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(Path(__file__).with_name('audio-test-tone.ps1')),
                '-RightFrequencyHz','880','-Amplitude','0.08','-DurationMs','1800000'],'tone')
        process=launch([str(exe),'--local-control','--local-control-discovery='+str(discovery)],'publisher')
        session=frida.attach(process.pid);script=session.create_script(d.OBSERVER)
        script.on('message',lambda m,data:events.append({'time':time.time(),**m.get('payload',m)}));script.load()
        app=Application(backend='uia').connect(process=process.pid,timeout=20);window=d.application_window(process.pid)
        window.set_focus();d.wait_for(discovery.exists,'control endpoint')
        proc=psutil.Process(process.pid)
        report.update({'publisher':str(exe),'loadedPath':proc.exe(),'pid':process.pid,
                       'sha256':hashlib.sha256(exe.read_bytes()).hexdigest()})
        def named(suffix):return next(c for c in window.descendants() if (c.element_info.automation_id or '').endswith('.'+suffix))
        def reveal(c):
            window.set_focus()
            window.wheel_mouse_input(coords=(window.rectangle().width()-25,150),wheel_dist=60)
            time.sleep(.35)
            for _ in range(80):
                rect,viewport=c.rectangle(),window.rectangle()
                if viewport.top+65<rect.mid_point().y<viewport.bottom-55:
                    time.sleep(.35)
                    if c.rectangle()==rect:return
                window.wheel_mouse_input(coords=(viewport.width()-25,150),wheel_dist=-2);time.sleep(.12)
            raise AssertionError('Unreachable control '+c.window_text())
        def select(combo,text):
            reveal(combo);combo.click_input()
            def item():return next((x for w in app.windows() for x in w.descendants(control_type='ListItem') if x.window_text()==text and x.is_visible()),None)
            d.wait_for(lambda:item() is not None,'combo '+text);item().click_input()
        def shot(name):
            time.sleep(.5);window.capture_as_image().save(output/(name+'.png'))
            rect=window.rectangle()
            report['screenshots'].append({'name':name,'windowRect':[rect.left,rect.top,rect.right,rect.bottom]})
        for width,height in [(800,600),(1024,768),(1280,900)]:
            win32gui.MoveWindow(window.handle,20,20,width,height,True);shot('default-'+str(width)+'x'+str(height))
        window.maximize();time.sleep(.5)
        source_list=named('sourceList')
        if source_list.element_info.control_type=='ListItem':source_list=source_list.parent()
        center=source_list.rectangle().mid_point();source_list.move_mouse_input(coords=(center.x,center.y),absolute=True)
        item=window.child_window(title_re=d.SOURCE_TITLE+'.*',control_type='ListItem')
        for _ in range(80):
            if item.exists(timeout=.1):
                rect,view=item.rectangle(),source_list.rectangle()
                if view.top<rect.mid_point().y<view.bottom:break
            win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL,0,0,-40,0);time.sleep(.05)
        item.click_input();d.wait_for(lambda:named('goLiveButton').is_enabled(),'source ready')
        named('advancedToggle').click_input();reveal(named('audioEncodingToggle'));named('audioEncodingToggle').click_input()
        for width,height in [(800,600),(1024,768),(1280,900)]:
            window.restore();win32gui.MoveWindow(window.handle,20,20,width,height,True)
            reveal(named('audioCodecSelect'));shot('audio-'+str(width)+'x'+str(height))
        window.maximize();time.sleep(.5)
        for cycle in range(a.cycles):
            pcm=cycle%3==1;red=cycle%3==2;mono=cycle%2==1
            select(named('audioCodecSelect'),'PCM (experimental)' if pcm else 'Opus (48 kHz)')
            select(named('audioChannelsSelect'),'Mono (1 channel)' if mono else 'Stereo (2 channels)')
            if not pcm and bool(named('audioRedCheck').get_toggle_state())!=red:
                reveal(named('audioRedCheck'));named('audioRedCheck').click_input()
            bitrate=named('audioBitrateSpin')
            if not pcm:reveal(bitrate);bitrate.type_keys('^a192{TAB}')
            reveal(named('goLiveButton'));start=time.perf_counter();named('goLiveButton').click_input()
            d.wait_for(lambda:api()['app']['live'],'capture start',30)
            row={'cycle':cycle+1,'pcm':pcm,'red':red,'mono':mono,'startMs':(time.perf_counter()-start)*1000}
            link=html.unescape(re.search(r'https://[^<"\s]+',named('shareLinkLabel').window_text())[0])
            dest=output/('receiver-'+str(cycle+1));dest.mkdir()
            result=subprocess.run(['node',str(Path(__file__).with_name('audio-settings-packaged-e2e.js')),
                '--stream='+stream,'--bitrate=192','--channels='+('1' if mono else '2'),'--codec='+('pcm' if pcm else 'opus'),
                '--red='+str(red).lower(),'--discovery='+str(discovery),'--viewer-url='+link,'--output='+str(dest)],
                capture_output=True,text=True,timeout=80)
            (dest/'viewer.log').write_text(result.stdout+result.stderr,encoding='utf-8')
            row['decodedPlaybackPassed']=result.returncode==0
            assert result.returncode==0,'Real decoded playback failed in cycle '+str(cycle+1)
            row['liveDiagnostics']=api();shot('live-'+str(cycle+1))
            reveal(named('goLiveButton'));start=time.perf_counter();named('goLiveButton').click_input()
            d.wait_for(lambda:not api()['app']['live'],'capture stop',20);row['stopMs']=(time.perf_counter()-start)*1000
            time.sleep(3);mem=proc.memory_info();row['stoppedResources']={'rss':mem.rss,'private':mem.private,'handles':proc.num_handles(),'threads':proc.num_threads()}
            report['cycles'].append(row);print(json.dumps({k:v for k,v in row.items() if k!='liveDiagnostics'}),flush=True)
            (output/'progress.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        api('/commands',{'command':'quit'});report['exitCode']=process.wait(timeout=15);assert report['exitCode']==0
        report['ok']=True
    except BaseException as e:
        report['error']=str(e)
        if window:
            try:window.capture_as_image().save(output/'failure.png')
            except Exception:pass
        raise
    finally:
        for child in children:
            if child.poll() is None:child.kill()
            child.wait(timeout=10)
        for log in logs:log.close()
        d.restore(d.SETTINGS_KEY,saved);report['settingsRestored']=d.snapshot(d.SETTINGS_KEY)==saved
        report['events']=events;report['soundCalls']=[e for e in events if e.get('kind')=='sound']
        (output/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        assert report['settingsRestored']


if __name__=='__main__':main()
