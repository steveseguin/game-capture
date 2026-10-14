"""Real startup with unavailable devices; optional mic failure must preserve video/audio."""
import argparse,hashlib,json,os,socket,subprocess,sys,time,urllib.request,uuid,wave
from pathlib import Path
import numpy as np
import psutil
p=argparse.ArgumentParser();p.add_argument('--publisher',type=Path,required=True);p.add_argument('--report',type=Path,required=True)
a=p.parse_args();exe=a.publisher.resolve();out=a.report.resolve();out.mkdir(parents=True,exist_ok=True)
report={'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'cases':[]};owned=[];logs=[];app=None
def launch(argv,name):
    log=(out/(name+'.log')).open('wb');logs.append(log)
    proc=subprocess.Popen([str(x) for x in argv],stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW,
        env=dict(os.environ,LOCALAPPDATA=str(out),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'))
    owned.append(proc);return proc
def api(route='/diagnostics',body=None):
    d=json.loads(discovery.read_text())
    req=urllib.request.Request(d['base_url']+route,data=json.dumps(body).encode() if body else None,
        headers={'Authorization':'Bearer '+d['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    (out/'fixture.json').write_text(json.dumps({'size':[1280,720],'hidden':False}))
    fixture=launch([sys.executable,Path(__file__).with_name('capture-resilience-packaged.py'),'--fixture',out],'fixture');time.sleep(1)
    missing='qa-not-present-'+str(uuid.uuid4())
    cases=[('missing-camera',['--source=camera','--camera='+missing,'--audio-source=none'],False),
           ('missing-spout',['--source=spout','--spout-sender='+missing,'--audio-source=none'],False),
           ('missing-optional-mic',['--source=window','--window=Game Capture Resilience Fixture','--audio-source=selected-window',
                                    '--include-microphone','--microphone-device='+missing],True),
           ('missing-primary-mic',['--source=window','--window=Game Capture Resilience Fixture','--audio-source=default-microphone',
                                  '--microphone-device='+missing],True)]
    for name,args,required in cases:
        discovery=out/(name+'-control.json');movie=out/(name+'.mkv');receiver=None
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        if required:
            receiver=launch([exe.parent/'ffmpeg/bin/ffmpeg.exe','-v','warning','-i',f'udp://127.0.0.1:{port}?fifo_size=8192&overrun_nonfatal=1',
                '-t','7','-map','0','-c','copy',movie],name+'-receiver');time.sleep(.3)
        app=launch([exe,'--headless','--output=udp',f'--output-url=udp://127.0.0.1:{port}','--resolution=1280x720','--fps=30',
            '--duration-ms=20000','--local-control','--local-control-discovery='+str(discovery),*args],name)
        root=psutil.Process(app.pid);started=time.monotonic();live=False;last={}
        while app.poll() is None and time.monotonic()-started<15:
            if discovery.exists():
                try:
                    last=api();live=last.get('output',{}).get('state')==2
                    if live:break
                except (OSError,ValueError):pass
            time.sleep(.2)
        if live:
            if receiver:assert receiver.wait(timeout=20)==0
            else:time.sleep(2)
            last=api();api('/commands',{'command':'quit'})
            assert last['audio']['active_microphone_source']=='none',(name,last['audio'])
            if name=='missing-optional-mic':assert last['audio']['additional_peak']==0,last['audio']
            if name=='missing-primary-mic':assert last['audio']['primary_peak']==0,last['audio']
        code=app.wait(timeout=25);assert code in (0,1,2,3),(name,code)
        log=(out/(name+'.log')).read_text(errors='replace')
        row={'name':name,'live':live,'exitCode':code,'seconds':time.monotonic()-started,
             'errorLines':[line for line in log.splitlines() if any(s in line.lower() for s in ('error','unavailable','no camera matched','no spout'))],
             'diagnostics':last};report['cases'].append(row)
        if required is not None:assert live==required,row
        assert row['errorLines'],(name,'Failure not explained in logs')
        print(name,'live',live,'exit',code,flush=True)
    fixture.terminate();fixture.wait(timeout=10)
    movie=out/'missing-optional-mic.mkv';ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe'
    decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(movie),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=60)
    assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
    raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-vn','-ar','48000','-ac','2','-f','f32le','-'],capture_output=True,timeout=30)
    assert raw.returncode==0
    pcm=np.frombuffer(raw.stdout,np.float32).reshape(-1,2)[48000:96000];assert len(pcm)==48000
    tones=[float(abs(np.sum(pcm[:,ch]*np.exp(-2j*np.pi*f*np.arange(48000)/48000)))*2/48000) for ch,f in enumerate((440,880))]
    assert min(tones)>.01,tones
    report['optionalMicRecording']={'cleanDecode':True,'sourceTones':tones}
    movie=out/'missing-primary-mic.mkv'
    decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(movie),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=60)
    assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
    raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-map','0:a:0','-vn','-ar','48000','-ac','1','-f','f32le','-'],capture_output=True,timeout=30)
    assert raw.returncode==0 and len(raw.stdout)>6*48000*4
    assert np.max(np.abs(np.frombuffer(raw.stdout,np.float32)))<1e-6
    report['primaryMicRecording']={'cleanDecode':True,'audioSilent':True}
    report['passed']=True
finally:
    for proc in reversed(owned):
        if proc.poll() is None:
            try:
                if proc==app:api('/commands',{'command':'quit'});proc.wait(timeout=15)
                else:proc.terminate();proc.wait(timeout=10)
            except Exception:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    (out/'device-failure.json').write_text(json.dumps(report,indent=2))
