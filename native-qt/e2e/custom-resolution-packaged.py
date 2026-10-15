"""Visible custom resolution workflow, with private RTMP reception and decode."""
import argparse, hashlib, importlib.util, json, os, re, subprocess, sys, time, urllib.request
from pathlib import Path
import psutil
from pywinauto import Application
import win32api, win32con

spec=importlib.util.spec_from_file_location('desktop_fixture',Path(__file__).with_name('desktop-ui-e2e.py'))
ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
parser=argparse.ArgumentParser();parser.add_argument('--publisher',required=True);parser.add_argument('--report',required=True)
args=parser.parse_args();exe=Path(args.publisher).resolve();report=Path(args.report).resolve();report.mkdir(parents=True,exist_ok=True)
native=Path(__file__).resolve().parent.parent;ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe'
saved=ui.snapshot(ui.SETTINGS_KEY);processes=[];logs=[];app=None;results={'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'cases':[]}
discovery=report/'control.json'
def launch(argv,name,env=None):
    log=(report/(name+'.log')).open('wb');logs.append(log)
    p=subprocess.Popen([str(a) for a in argv],cwd=report,stdout=log,stderr=log,env=env,creationflags=subprocess.CREATE_NO_WINDOW);processes.append(p);return p
def api(route,body=None):
    d=json.loads(discovery.read_text(encoding='utf-8-sig'));req=urllib.request.Request(d['base_url']+route,data=json.dumps(body).encode() if body else None,headers={'Authorization':'Bearer '+d['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
def start_app(name):
    global app,window,automation
    app=launch([exe,'--local-control','--local-control-discovery='+str(discovery)],name,{**os.environ,'LOCALAPPDATA':str(report),'GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING':'1'})
    automation=Application(backend='uia').connect(process=app.pid,timeout=20)
    window=ui.application_window(app.pid);window.maximize();window.set_focus();time.sleep(.7)
def named(suffix):return next(c for c in window.descendants() if (c.element_info.automation_id or '').endswith('.'+suffix))
def visible(suffix):
    for _ in range(40):
        field=named(suffix);y=field.rectangle().mid_point().y;bounds=window.rectangle()
        if bounds.top+85<y<bounds.bottom-85:return field
        window.wheel_mouse_input(coords=(bounds.width()-25,150),wheel_dist=2 if y<=bounds.top+85 else -2)
        time.sleep(.15)
    raise AssertionError('Control not reachable: '+suffix)
def choose(suffix,text):
    field=visible(suffix);field.set_focus();field.click_input();time.sleep(.2)
    def option():return next((c for w in automation.windows() for c in w.descendants(control_type='ListItem') if c.window_text()==text and c.is_visible()),None)
    ui.wait_for(lambda:option() is not None,'option '+text);option().click_input();time.sleep(.3)
def edit_resolution(text):
    field=visible('resolutionSelect');editor=field.children(control_type='Edit')[0]
    editor.set_edit_text(text)
    assert editor.window_text()==text, (editor.window_text(),text)
    named('fpsSelect').set_focus();time.sleep(.15)
try:
    for group,name,value in [('video','sourceMode','window'),('video','resolution','1280x720'),('video','fps','30'),('video','bitratePresetKbps','4000'),('video','customBitrateKbps','4000'),('video','codec','h264'),('video','encoderMode','auto'),('video','alphaWorkflow','false'),('video','ffmpegPath',''),('ui','advancedVisible','false'),('audio','source','none'),('audio','includeMicrophone','false')]:ui.setting(group,name,value)
    config=report/'mediamtx.yml';config.write_text('logLevel: warn\napi: yes\napiAddress: 127.0.0.1:18990\nrtspAddress: 127.0.0.1:18854\nrtspTransports: [tcp]\nrtmpAddress: 127.0.0.1:19350\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\npaths:\n  all_others:\n')
    server=launch([native/'.cache/mediamtx-1.21.2/mediamtx.exe',config],'receiver');time.sleep(1);assert server.poll() is None
    source=launch([sys.executable,Path(__file__).with_name('desktop-ui-e2e.py'),'--source-window'],'source');time.sleep(1)
    start_app('publisher')
    window.capture_as_image().save(report/'startup.png')
    item=window.child_window(title_re=ui.SOURCE_TITLE+'.*',control_type='ListItem');source_list=named('sourceList')
    if source_list.element_info.control_type=='ListItem':source_list=source_list.parent()
    for _ in range(80):
        if item.exists(timeout=.1) and source_list.rectangle().top<item.rectangle().mid_point().y<source_list.rectangle().bottom:break
        center=source_list.rectangle().mid_point()
        source_list.move_mouse_input(coords=(center.x,center.y),absolute=True)
        win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL,0,0,-40,0);time.sleep(.1)
    else:raise AssertionError('Source not reachable')
    item.click_input();ui.wait_for(lambda:named('goLiveButton').is_enabled(),'source ready')
    # Navigate actual controls, including the editable existing resolution box.
    named('advancedToggle').click_input()
    window.wheel_mouse_input(coords=(window.rectangle().width()-25,150),wheel_dist=-25);time.sleep(.3)
    choose('outputSelect','RTMP / RTMPS');named('outputUrlInput').set_edit_text('rtmp://127.0.0.1:19350/live');named('outputSecretInput').set_edit_text('custom')
    edit_resolution('1921x1080');named('goLiveButton').invoke();time.sleep(.4)
    assert 'even resolution' in named('statusLabel').window_text()
    assert not api('/diagnostics').get('output'), 'Invalid dimensions started publishing'
    results['invalidRejected']=True
    for width,height in [(2560,1440),(2560,1080),(3840,2160),(720,1280)]:
        label=f'{width}x{height}';edit_resolution(label);named('goLiveButton').invoke()
        ui.wait_for(lambda:api('/diagnostics').get('output',{}).get('state')==2,label+' live',30)
        d=api('/diagnostics');assert d['video']['hq_width']==width and d['video']['hq_height']==height,d['video']
        def receiver_ready():
            with urllib.request.urlopen('http://127.0.0.1:18990/v3/paths/list',timeout=5) as response:
                return any(p['name']=='live/custom' and p['ready'] for p in json.load(response)['items'])
        ui.wait_for(receiver_ready,label+' receiver track discovery',20)
        output=report/(label+'.mkv');record=launch([ffmpeg,'-v','warning','-y','-i','rtmp://127.0.0.1:19350/live/custom','-map','0','-c','copy','-t','8',output],label+'-receiver')
        record.wait(timeout=30);assert record.returncode==0
        window.capture_as_image().save(report/(label+'.png'))
        named('goLiveButton').invoke();ui.wait_for(lambda:named('statusLabel').window_text()=='Stopped',label+' stopped',20)
        decoded=subprocess.run([str(ffmpeg),'-v','info','-i',str(output),'-map','0:v:0','-vf','showinfo','-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        text=decoded.stderr.decode(errors='replace');pts=[float(s) for s in re.findall(r'\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:(\S+)',text)]
        assert decoded.returncode==0 and len(pts)>200 and all(b>a for a,b in zip(pts,pts[1:]))
        assert f's:{label}' in text,(label,text[-500:])
        gaps=[(b-a)*1000 for a,b in zip(pts,pts[1:])]
        results['cases'].append({'resolution':label,'frames':len(pts),'maxFrameGapMs':max(gaps),'fps':(len(pts)-1)/(pts[-1]-pts[0]),'encoder':d['video'].get('encoder')})
        assert max(gaps)<100,results['cases'][-1]
    edit_resolution('2560x1080');api('/commands',{'command':'quit'});app.wait(timeout=30)
    start_app('reopened');ui.wait_for(lambda:named('resolutionSelect').children(control_type='Edit')[0].window_text()=='2560x1080','custom resolution restored')
    results['customRestored']=True;api('/commands',{'command':'quit'});app.wait(timeout=30)
    results['passed']=True
except Exception as error:
    results['error']=str(error)
    if app and app.poll() is None:
        window.capture_as_image().save(report/'failure.png')
        (report/'controls.txt').write_text('\n'.join(str((c.element_info.control_type,c.element_info.automation_id,c.window_text())) for c in window.descendants()),encoding='utf-8')
    raise
finally:
    for p in processes:
        if p.poll() is None:
            children=psutil.Process(p.pid).children(recursive=True);p.terminate();p.wait(timeout=15)
            for child in children:
                try:child.kill()
                except psutil.NoSuchProcess:pass
            psutil.wait_procs(children,timeout=5)
    for log in logs:log.close()
    ui.restore(ui.SETTINGS_KEY,saved);results['settingsRestored']=ui.snapshot(ui.SETTINGS_KEY)==saved
    (report/'results.json').write_text(json.dumps(results,indent=2));assert results['settingsRestored']
print(json.dumps(results,indent=2),flush=True)
