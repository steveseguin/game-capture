"""Packaged capture: 4K/8K surfaces, odd dimensions, resize storms and CPU limits."""
import argparse,ctypes,hashlib,json,os,re,socket,subprocess,sys,time,urllib.request,wave
from pathlib import Path
import numpy as np
import psutil

if '--fixture' in sys.argv:
    import tkinter,winsound
    ctypes.windll.user32.SetProcessDPIAware()
    folder=Path(sys.argv[-1]);window=tkinter.Tk();window.title('Game Capture Resilience Fixture')
    window.maxsize(8200,8200);window.geometry('1280x720+10+10')
    canvas=tkinter.Canvas(window,bg='#234561',highlightthickness=0);canvas.pack(fill='both',expand=True)
    marker=canvas.create_rectangle(0,100,150,300,fill='#ffbb22');label=canvas.create_text(40,40,anchor='nw',fill='white',font=('Arial',26))
    winsound.PlaySound(str(folder/'tone.wav'),winsound.SND_FILENAME|winsound.SND_ASYNC|winsound.SND_LOOP)
    last=None
    def tick():
        global last
        try:
            requested=json.loads((folder/'fixture.json').read_text())
            if requested!=last:
                last=requested
                if requested.get('hidden'):window.withdraw()
                else:
                    window.deiconify();w,h=requested['size'];window.geometry(f'{w}x{h}+10+10')
            now=time.monotonic();x=int(now*220)%max(1,canvas.winfo_width()-160)
            canvas.coords(marker,x,100,x+150,300);canvas.itemconfigure(label,text=f'{canvas.winfo_width()} x {canvas.winfo_height()} / {now:.3f}')
            (folder/'fixture-size.json').write_text(json.dumps([canvas.winfo_width(),canvas.winfo_height()]))
        except (OSError,ValueError):pass
        window.after(16,tick)
    tick()
    try:window.mainloop()
    finally:winsound.PlaySound(None,0)
    raise SystemExit()

p=argparse.ArgumentParser();p.add_argument('--publisher',type=Path,required=True);p.add_argument('--report',type=Path,required=True)
a=p.parse_args();exe=a.publisher.resolve();out=a.report.resolve();out.mkdir(parents=True,exist_ok=True)
ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe';discovery=out/'control.json';movie=out/'resize-and-load.mkv'
report={'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'phases':[]};owned=[];logs=[];app=None
def launch(args,name):
    log=(out/(name+'.log')).open('wb');logs.append(log)
    proc=subprocess.Popen([str(v) for v in args],stdin=subprocess.PIPE,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW,
        env=dict(os.environ,LOCALAPPDATA=str(out),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'))
    owned.append(proc);return proc
def api(route='/diagnostics',body=None):
    info=json.loads(discovery.read_text())
    req=urllib.request.Request(info['base_url']+route,data=json.dumps(body).encode() if body else None,
        headers={'Authorization':'Bearer '+info['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
def resize(size,hidden=False):
    temp=out/'fixture-next.json';temp.write_text(json.dumps({'size':size,'hidden':hidden}));os.replace(temp,out/'fixture.json')
def phase(name,seconds=8):
    start=time.monotonic();samples=[]
    while time.monotonic()-start<seconds:
        tick=time.perf_counter();d=api();latency=(time.perf_counter()-tick)*1000
        assert app.poll() is None,'App exited while capturing'
        assert d['output']['state']==2,d['output']
        samples.append({'seconds':time.monotonic()-start,'apiMs':latency,'video':d['video'],'privateMiB':root.memory_info().private/2**20})
        time.sleep(.3)
    before,after=samples[0],samples[-1]
    row={'name':name,'samples':samples,'fps':(after['video']['frames_sent']-before['video']['frames_sent'])/(after['seconds']-before['seconds']),
         'captureSize':[after['video']['last_capture_width'],after['video']['last_capture_height']],
         'drops':after['video']['frames_dropped']-before['video']['frames_dropped'],'maxApiMs':max(s['apiMs'] for s in samples)}
    report['phases'].append(row);print(json.dumps({k:v for k,v in row.items() if k!='samples'}),flush=True)
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    resize([1280,720]);fixture=launch([sys.executable,Path(__file__).resolve(),'--fixture',out],'fixture');time.sleep(1)
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    receiver=launch([ffmpeg,'-v','warning','-i',f'udp://127.0.0.1:{port}?fifo_size=8192&overrun_nonfatal=1','-map','0','-c','copy',movie],'receiver')
    time.sleep(.4)
    app=launch([exe,'--headless','--output=udp',f'--output-url=udp://127.0.0.1:{port}','--source=window','--window=Game Capture Resilience Fixture',
        '--resolution=1280x720','--fps=30','--video-encoder=software','--audio-source=selected-window','--bitrate-kbps=4000',
        '--duration-ms=1800000','--local-control','--local-control-discovery='+str(discovery)],'app')
    root=psutil.Process(app.pid);deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        assert app.poll() is None,'App startup failed'
        try:
            if api().get('output',{}).get('state')==2:break
        except (OSError,ValueError):pass
        time.sleep(.2)
    phase('baseline')
    for size in ([3840,2160],[7680,4320],[5120,1440],[641,479]):
        resize(size);time.sleep(.6);phase(f'{size[0]}x{size[1]}')
    for n in range(24):resize([1281,721] if n%2 else [3840,2160]);time.sleep(.1)
    resize([1280,720]);phase('after-rapid-resizing')
    allowed=root.cpu_affinity();restricted=allowed[-2:]
    report['restrictedCpus']=restricted
    for proc in [root]+root.children(recursive=True):
        try:proc.cpu_affinity(restricted)
        except psutil.NoSuchProcess:pass
    phase('two-logical-cpus',15)
    for proc in [root]+root.children(recursive=True):
        try:proc.cpu_affinity(allowed)
        except psutil.NoSuchProcess:pass
    resize([1280,720],hidden=True);time.sleep(3);resize([1280,720]);phase('after-hidden-source')
    receiver.stdin.write(b'q\n');receiver.stdin.flush();assert receiver.wait(timeout=10)==0
    fixture.terminate();fixture.wait(timeout=10);time.sleep(3)
    report['sourceClosedAppExit']=app.poll()
    if app.poll() is None:
        report['sourceClosedDiagnostics']=api();api('/commands',{'command':'quit'})
    report['exitCode']=app.wait(timeout=30);assert report['exitCode'] in (0,1,2,3),report['exitCode']
    decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(movie),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=180)
    assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
    raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-map','0:a:0','-ar','48000','-ac','2','-f','f32le','-'],capture_output=True,timeout=60)
    assert raw.returncode==0
    pcm=np.frombuffer(raw.stdout,np.float32).reshape(-1,2);assert np.isfinite(pcm).all()
    segment=pcm[48000:96000]
    tones=[float(abs(np.sum(segment[:,ch]*np.exp(-2j*np.pi*hz*np.arange(len(segment))/48000)))*2/len(segment)) for ch,hz in enumerate((440,880))]
    assert min(tones)>.01,tones
    report['recording']={'cleanDecode':True,'audioTones':tones,'bytes':movie.stat().st_size}
    assert report['phases'][0]['fps']>25 and report['phases'][-1]['fps']>25
    assert max(p['maxApiMs'] for p in report['phases'])<1000
    # Diagnostics describe the GPU-scaled readback, not the original WGC texture.
    text=(out/'app.log').read_text(errors='replace')
    report['rawCaptureSizes']=[list(map(int,size)) for size in re.findall(r'Capture content resized, recreated frame pool: (\d+)x(\d+)',text)]
    assert any(size[0]>=7680 for size in report['rawCaptureSizes']),'8K capture surface was not actually exercised'
    report['passed']=True
finally:
    for proc in reversed(owned):
        if proc.poll() is None:
            try:
                if proc==app:api('/commands',{'command':'quit'});proc.wait(timeout=15)
                else:proc.terminate();proc.wait(timeout=10)
            except Exception:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    (out/'capture-resilience.json').write_text(json.dumps(report,indent=2))
