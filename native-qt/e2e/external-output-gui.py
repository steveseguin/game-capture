"""Click the packaged output settings, publish, restart, and inspect saved profiles."""
import argparse,hashlib,importlib.util,json,os,subprocess,sys,time,urllib.request
from pathlib import Path
import frida,psutil,win32api,win32con,win32gui
from pywinauto import Application

spec=importlib.util.spec_from_file_location('desktop',Path(__file__).with_name('desktop-ui-e2e.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)

def main():
    p=argparse.ArgumentParser();p.add_argument('--publisher',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--cycles',type=int,default=1);a=p.parse_args()
    exe=a.publisher.resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=True);native=Path(__file__).resolve().parent.parent
    assert not any(p.name()=='game-capture.exe' for p in psutil.process_iter()),'Serialize capture runs'
    saved=d.snapshot(d.SETTINGS_KEY);children=[];logs=[];report={'publisher':str(exe),'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'cycles':[]};window=None
    def launch(args,name):
        log=(out/(name+'.log')).open('w',encoding='utf-8');logs.append(log)
        child=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,
            env=dict(os.environ,LOCALAPPDATA=str(out),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'));children.append(child);return child
    def api(route='/diagnostics',body=None):
        info=json.loads(discovery.read_text());req=urllib.request.Request(info['base_url']+route,data=json.dumps(body).encode() if body else None,
            headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
    def named(name):return next(c for c in window.descendants() if (c.element_info.automation_id or '').endswith('.'+name))
    def reveal(control):
        window.set_focus();window.wheel_mouse_input(coords=(window.rectangle().width()-25,150),wheel_dist=60);time.sleep(.2)
        for _ in range(80):
            rect,view=control.rectangle(),window.rectangle()
            if view.top+65<rect.mid_point().y<view.bottom-55:
                time.sleep(.25)
                if control.rectangle()==rect:return
            window.wheel_mouse_input(coords=(view.width()-25,150),wheel_dist=-2);time.sleep(.08)
        raise AssertionError('Cannot reach '+control.window_text())
    def select(name,text):
        control=named(name);reveal(control);control.expand()
        def item():return next((x for w in app.windows() for x in w.descendants(control_type='ListItem') if x.window_text()==text and x.is_visible()),None)
        d.wait_for(lambda:item() is not None,'combo '+text)
        item().click_input()
        d.wait_for(lambda:named(name).selected_text()==text,'selected '+text)
    def text(name,value):
        control=named(name);control.set_edit_text(value)
    def shot(name):time.sleep(.3);window.capture_as_image().save(out/(name+'.png'))
    def pick_source():
        assert 'Window' in named('sourceModeSelect').selected_text()
        source_list=named('sourceList')
        if source_list.element_info.control_type=='ListItem':source_list=source_list.parent()
        (out/'source-controls.json').write_text(json.dumps([{'type':c.element_info.control_type,'name':c.window_text(),'id':c.element_info.automation_id,'rect':str(c.rectangle())} for c in window.descendants() if 'sourceList' in (c.element_info.automation_id or '') or c.element_info.control_type=='ListItem'],indent=2),encoding='utf-8')
        item=window.child_window(title_re=d.SOURCE_TITLE+'.*',control_type='ListItem')
        for _ in range(60):
            if item.exists(timeout=.1):
                item.select();break
            rect=named('sourceList').rectangle();point=(rect.left+80,rect.top+35)
            win32gui.SendMessage(window.handle,win32con.WM_MOUSEWHEEL,(-120 & 0xffff)<<16,win32api.MAKELONG(*point));time.sleep(.15)
        else:raise AssertionError('Source did not appear in the accessible list')
        d.wait_for(lambda:named('goLiveButton').is_enabled(),'source ready')
    try:
        for group,name,value in [('video','sourceMode','window'),('video','codec','vp9'),('video','encoderMode','auto'),
            ('video','alphaWorkflow','true'),('video','resolution','960x540'),('video','fps','30'),('video','ffmpegPath',''),
            ('audio','source','none'),('audio','includeMicrophone','false'),('audio','codec','pcm'),('audio','red','false'),
            ('ui','advancedVisible','false'),('stream','target','gui-source'),('stream','room',''),('stream','password','false'),
            ('control','enabled','false'),('output','protocol','vdo'),('output','profilesEncrypted','')]:d.setting(group,name,value)
        launch([sys.executable,str(Path(__file__).with_name('desktop-ui-e2e.py')),'--source-window'],'source')
        config=out/'mediamtx.yml';config.write_text('api: true\napiAddress: 127.0.0.1:18990\nrtspAddress: 127.0.0.1:18854\nrtspTransports: [tcp]\nrtmpAddress: 127.0.0.1:19350\nwebrtcAddress: 127.0.0.1:18889\nwebrtcLocalUDPAddress: 127.0.0.1:18189\nwebrtcIPsFromInterfaces: false\nwebrtcAdditionalHosts: [127.0.0.1]\nsrtAddress: 127.0.0.1:18890\nhls: false\nmoq: false\npaths:\n  all_others:\n')
        launch([str(native/'.cache/mediamtx-1.21.2/mediamtx.exe'),str(config)],'server')
        for restart in range(2):
            discovery=out/('control-'+str(restart)+'.json')
            proc=launch([str(exe),'--local-control','--local-control-discovery='+str(discovery)],'publisher-'+str(restart))
            events=[];session=frida.attach(proc.pid)
            observer=session.create_script(Path(__file__).with_name('audio-event-handle-observer.js').read_text())
            observer.on('message',lambda message,data:events.append(message));observer.load()
            sounds=session.create_script(d.OBSERVER)
            sounds.on('message',lambda message,data:events.append(message));sounds.load()
            app=Application(backend='uia').connect(process=proc.pid,timeout=20);window=d.application_window(proc.pid);d.wait_for(discovery.exists,'control endpoint')
            window.set_focus();win32gui.SetWindowPos(window.handle,win32con.HWND_TOPMOST,0,0,0,0,win32con.SWP_NOMOVE|win32con.SWP_NOSIZE)
            if restart==0:
                assert not named('advancedToggle').get_toggle_state()
                shot('default')
            pick_source()
            if not named('advancedToggle').get_toggle_state():reveal(named('advancedToggle'));named('advancedToggle').click_input()
            for cycle,(protocol,label,url,key) in enumerate([('whip','WHIP','http://127.0.0.1:18889/gui-whip/whip',''),
                    ('srt','SRT (caller)','srt://127.0.0.1:18890',''),('rtmp','RTMP / RTMPS','rtmp://127.0.0.1:19350/live','gui-secret-key')]*a.cycles):
                select('outputSelect',label)
                if restart==0 and cycle<3:
                    text('outputUrlInput',url);text('outputSecretInput',key)
                    if protocol=='srt':text('outputStreamIdInput','publish:gui-srt')
                else:
                    assert named('outputUrlInput').get_value()==url,'Destination profile was not restored'
                    if protocol=='srt':assert named('outputStreamIdInput').get_value()=='publish:gui-srt'
                assert named('outputSecretInput').element_info.element.CurrentIsPassword,'Credential field is unmasked'
                if restart==0 and cycle<3:
                    reveal(named('outputSelect'));shot(protocol)
                    assert not named('audioEncodingToggle').get_toggle_state(),'Audio encoding unexpectedly expanded by default'
                    named('audioEncodingToggle').toggle()
                    reveal(named('audioBitrateSpin' if protocol=='whip' else 'aacBitrateSpin'))
                    shot(protocol+'-audio');named('audioEncodingToggle').toggle()
                named('goLiveButton').invoke()
                d.wait_for(lambda:api().get('output',{}).get('state')==2,'publishing '+protocol,40)
                diag=api();assert diag['output']['protocol'].lower()==protocol
                assert diag['output']['audio_codec']=='none' and diag['audio']['codec']=='none','Video-only diagnostics advertise an audio codec'
                d.wait_for(lambda:'No audio' in named('connectionMediaLabel').window_text(),'video-only status')
                assert not named('outputSelect').is_enabled(),'Output changes remain active while publishing'
                stream='live/gui-secret-key' if protocol=='rtmp' else 'gui-'+protocol
                time.sleep(3)
                recording=out/(protocol+'-'+str(restart)+'-'+str(cycle)+'.mkv')
                receiver=subprocess.run([str(exe.parent/'ffmpeg/bin/ffmpeg.exe'),'-hide_banner','-y','-rtsp_transport','tcp','-i','rtsp://127.0.0.1:18854/'+stream,'-map','0:v:0','-c','copy','-t','3',str(recording)],capture_output=True,timeout=20)
                (out/(protocol+'-'+str(restart)+'-'+str(cycle)+'-receiver.log')).write_bytes(receiver.stderr);assert receiver.returncode==0 and recording.stat().st_size>1000
                assert b'Audio:' not in receiver.stderr,'No-audio publishing unexpectedly included an audio track'
                decoded=subprocess.run([str(exe.parent/'ffmpeg/bin/ffmpeg.exe'),'-hide_banner','-i',str(recording),'-map','0:v:0','-frames:v','20','-f','framemd5','-'],capture_output=True,timeout=20)
                checksums=[line.split(b',')[-1].strip() for line in decoded.stdout.splitlines() if line and not line.startswith(b'#')]
                assert decoded.returncode==0 and len(checksums)>=10 and len(set(checksums))>=3,'Receiver did not decode changing fixture frames'
                assert 'gui-secret-key' not in json.dumps(diag),'Credential leaked into diagnostics'
                named('goLiveButton').invoke();d.wait_for(lambda:not api()['app']['live'],'stop',20)
                d.wait_for(lambda:named('outputSelect').is_enabled(),'controls restored')
                time.sleep(2);resource=psutil.Process(proc.pid);memory=resource.memory_info()
                report['cycles'].append({'restart':restart,'cycle':cycle,'protocol':protocol,'diagnostics':diag,'recording':str(recording),'decodedFrames':len(checksums),'distinctFrames':len(set(checksums)),
                    'stopped':{'private':memory.private,'rss':memory.rss,'handles':resource.num_handles(),'threads':resource.num_threads(),'children':[c.pid for c in resource.children()],
                        'ownedHandles':observer.exports_sync.snapshot()}})
                assert not resource.children(),'Output child remains after stopping'
                (out/'progress.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            # Secrets, including full URLs, must not be written as clear text.
            encoded=json.dumps(d.snapshot(d.SETTINGS_KEY),default=str)
            assert 'gui-secret-key' not in encoded and '127.0.0.1:19350' not in encoded
            select('outputSelect','VDO.Ninja (default)')
            assert 'VP9' in named('codecSelect').selected_text(),'VDO video choice changed'
            if not named('audioEncodingToggle').get_toggle_state():reveal(named('audioEncodingToggle'));named('audioEncodingToggle').click_input()
            assert 'PCM' in named('audioCodecSelect').selected_text(),'VDO audio choice changed'
            select('outputSelect','RTMP / RTMPS')
            reveal(named('advancedToggle'));named('advancedToggle').click_input();shot('collapsed-external-'+str(restart))
            assert 'RTMP' in named('outputSummaryLabel').window_text()
            if restart==1:
                for width,height in [(800,600),(1280,900)]:
                    win32gui.MoveWindow(window.handle,20,20,width,height,True);shot('collapsed-'+str(width))
                win32gui.MoveWindow(window.handle,20,20,800,600,True)
                named('advancedToggle').toggle();reveal(named('outputSelect'));shot('expanded-800')
            api('/commands',{'command':'quit'});assert proc.wait(timeout=15)==0
            (out/('handles-'+str(restart)+'.json')).write_text(json.dumps(events,indent=2),encoding='utf-8')
            assert not any(e.get('payload',{}).get('kind')=='sound' for e in events),'Application requested a system sound'
        report['passed']=True
    except BaseException as e:
        report['error']=str(e)
        if window:
            try:shot('failure')
            except Exception:pass
        raise
    finally:
        for child in children:
            if child.poll() is None:child.kill()
            child.wait(timeout=10)
        for log in logs:log.close()
        d.restore(d.SETTINGS_KEY,saved);report['settingsRestored']=d.snapshot(d.SETTINGS_KEY)==saved
        (out/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8');assert report['settingsRestored']

if __name__=='__main__':main()
