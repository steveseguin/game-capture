"""Fresh packaged GUI layouts at process-local DPI scales; preserves settings."""
import argparse,ctypes,hashlib,importlib.util,json,os,subprocess,time,urllib.request,uuid
from pathlib import Path
import psutil,win32api,win32con,win32gui
from pywinauto import Application
spec=importlib.util.spec_from_file_location('desktop',Path(__file__).with_name('desktop-ui-e2e.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
p=argparse.ArgumentParser();p.add_argument('--publisher',type=Path,required=True);p.add_argument('--report',type=Path,required=True)
p.add_argument('--studio',action='store_true');p.add_argument('--scales',default='1,1.5,2,2.5,3');a=p.parse_args()
exe=a.publisher.resolve();out=a.report.resolve();out.mkdir(parents=True,exist_ok=True)
key=r'Software\VDO.Ninja\Video Mixer' if a.studio else d.SETTINGS_KEY;saved=d.snapshot(key)
report={'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'cases':[]};proc=None
def api(route,body=None):
    info=json.loads(discovery.read_text())
    req=urllib.request.Request(info['base_url']+route,data=json.dumps(body).encode() if body else None,
        headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
try:
    for scale in a.scales.split(','):
        d.restore(key,{})
        folder=out/scale;folder.mkdir(exist_ok=True);discovery=folder/'control.json'
        args=[str(exe),'--local-control','--local-control-discovery='+str(discovery)]
        if a.studio:
            show=folder/'show.mixer.json';sid=str(uuid.uuid4())
            show.write_text(json.dumps({'version':1,'sources':[],'scenes':[{'id':sid,'name':'Main','background':'#152638','layers':[]}]}))
            args+=['--studio-show='+str(show)]
        with (folder/'app.log').open('wb') as log:
            proc=subprocess.Popen(args,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW,
                env=dict(os.environ,LOCALAPPDATA=str(folder),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1',QT_SCALE_FACTOR=scale))
            window=(Application(backend='uia').connect(process=proc.pid,timeout=20).window(title='Desktop Studio - Powered by VDO.Ninja')
                    if a.studio else d.application_window(proc.pid))
            window.wait('visible',timeout=20);initial=window.rectangle()
            window.maximize();window.set_focus();d.wait_for(discovery.exists,'control API')
            time.sleep(.7)
            work=win32api.GetMonitorInfo(win32api.MonitorFromWindow(window.handle))['Work'];rect=window.rectangle()
            # Maximized Windows borders extend several pixels outside the work area.
            contained=rect.left>=work[0]-12 and rect.top>=work[1]-12 and rect.right<=work[2]+12 and rect.bottom<=work[3]+12
            initial_contained=initial.left>=work[0]-12 and initial.top>=work[1]-12 and initial.right<=work[2]+12 and initial.bottom<=work[3]+12
            row={'scale':scale,'initialWindow':[initial.left,initial.top,initial.right,initial.bottom],
                 'initialContained':initial_contained,'window':[rect.left,rect.top,rect.right,rect.bottom],'workArea':work,'contained':contained}
            window.capture_as_image().save(folder/'window.png')
            row['apiHealthy']=api('/health')['pid']==proc.pid
            if a.studio:
                for title in ('Capture.*output','Studio'):
                    window.child_window(title_re=title,control_type='TabItem').click_input()
                row['tabsClickable']=True
            else:
                control=next(c for c in window.descendants() if (c.element_info.automation_id or '').endswith('.advancedToggle'))
                control.toggle();time.sleep(.2);control.toggle();row['advancedToggle']=True
            window.wheel_mouse_input(coords=(rect.width()-20,rect.height()//2),wheel_dist=-90);time.sleep(.3)
            window.capture_as_image().save(folder/'scrolled.png')
            root=psutil.Process(proc.pid);children=root.children(recursive=True)
            api('/commands',{'command':'quit'});assert proc.wait(timeout=25)==0;proc=None
            _,alive=psutil.wait_procs(children,timeout=10);assert not alive
            report['cases'].append(row);print(json.dumps(row),flush=True)
    report['passed']=all(r['initialContained'] and r['contained'] and r['apiHealthy'] for r in report['cases'])
finally:
    if proc and proc.poll() is None:
        try:api('/commands',{'command':'quit'});proc.wait(timeout=15)
        except Exception:proc.kill();proc.wait(timeout=10)
    d.restore(key,saved)
    (out/'display-scaling.json').write_text(json.dumps(report,indent=2))
assert report.get('passed'),report
