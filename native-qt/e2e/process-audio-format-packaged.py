"""Real packaged process audio with injected rate hints/initialization failures.

Only the owned publisher is instrumented. Physical endpoint settings stay intact.
This verifies negotiation/recovery; it cannot reproduce a particular AMD driver.
"""
from pathlib import Path
helpers=Path(__file__).with_name('device-failure-packaged.py').read_text().split('\ntry:\n    t=')[0]
helpers=helpers.replace('a=p.parse_args()',"p.add_argument('--rate',type=int)\np.add_argument('--fault',choices=['none','reject-rate','reject-all','invalidated','missing-endpoint'],default='none')\np.add_argument('--seconds',type=int,default=90)\na=p.parse_args()")
exec(helpers)
import frida,re
assert 5<=a.seconds<=600 and (a.rate is None or 0<=a.rate<=1000000)
device=frida.get_local_device();session=None;root=None;events=[];app_log=None
discovery=out/'control.json';ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe';movie=out/'received.mkv'
report.update(rateHint=a.rate,fault=a.fault,seconds=a.seconds)
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    (out/'fixture.json').write_text(json.dumps({'size':[1280,720],'hidden':False}))
    fixture=launch([sys.executable,Path(__file__).with_name('capture-resilience-packaged.py'),'--fixture',out],'fixture');time.sleep(1)
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    receiver=launch([ffmpeg,'-v','warning','-i',f'udp://127.0.0.1:{port}?fifo_size=8192&overrun_nonfatal=1','-t',a.seconds,'-map','0','-c','copy',movie],'receiver')
    argv=[str(exe),'--headless','--source=window','--window=Game Capture Resilience Fixture',
          '--output=udp',f'--output-url=udp://127.0.0.1:{port}','--resolution=1280x720','--fps=30',
          '--video-encoder=software','--audio-source=selected-window','--duration-ms='+str((a.seconds+90)*1000),
          '--local-control','--local-control-discovery='+str(discovery)]
    app_log=(out/'app.log').open('wb');logs.append(app_log)
    def output(pid,fd,data):
        if root and pid==root.pid:app_log.write(data);app_log.flush()
    device.on('output',output)
    pid=device.spawn(argv,cwd=str(exe.parent),stdio='pipe',env=dict(os.environ,LOCALAPPDATA=str(out),
        GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1',VERSUS_AUDIO_CAPTURE_TRACE=str(out/'capture')))
    root=psutil.Process(pid);session=device.attach(pid)
    script=session.create_script('const RATE='+json.dumps(a.rate)+';const FAULT='+json.dumps(a.fault)+';\n'+Path(__file__).with_name('process-audio-format-fault.js').read_text())
    script.on('message',lambda message,data:events.append(message.get('payload',message)));script.load();device.resume(pid)
    started=time.monotonic();samples=[]
    while time.monotonic()-started<a.seconds+35 and receiver.poll() is None:
        assert root.is_running(),'Publisher exited'
        if discovery.exists():
            tick=time.perf_counter();d=api()
            if all(k in d for k in ('audio','output','video')):
                samples.append({'seconds':time.monotonic()-started,'apiMs':(time.perf_counter()-tick)*1000,'audio':d['audio'],'output':d['output'],'video':d['video']})
        assert not any(e.get('type')=='error' for e in events),events
        time.sleep(.25)
    assert receiver.poll()==0,'Receiver did not finish'
    final=api();assert final['output']['state']==2 and final['output']['reconnects']==0,final['output']
    init=[e for e in events if e.get('kind')=='process-initialize'];assert init,'No observed process-loopback initialization'
    expected=48000 if a.fault=='missing-endpoint' or a.rate is not None and not 8000<=a.rate<=384000 else a.rate
    if expected is not None:assert init[0]['rate']==expected,init
    silent=a.fault in ('reject-all','invalidated')
    if a.fault=='reject-rate' and expected!=48000:assert len(init)==2 and init[-1]['rate']==48000 and init[-1]['result']==0,init
    if a.fault=='reject-all':assert len(init)==(1 if expected==48000 else 2) and all(e['injected'] for e in init),init
    if a.fault=='invalidated':assert len(init)==1 and init[0]['injected'],init
    if not silent:assert final['audio']['primary_peak']>.01,final['audio']
    api('/commands',{'command':'quit'});exit_code=root.wait(timeout=20);assert exit_code==0,exit_code
    session.detach();session=None;root=None;device.off('output',output)
    fixture.terminate();fixture.wait(timeout=10)
    decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(movie),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=120)
    assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
    raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-map','0:a:0','-ar','48000','-ac','2','-f','f32le','-'],capture_output=True,timeout=90)
    assert raw.returncode==0
    pcm=np.frombuffer(raw.stdout,np.float32).reshape(-1,2)[48000:-48000];assert np.isfinite(pcm).all() and len(pcm)>48000
    windows=pcm[:len(pcm)//480*480].reshape(-1,480,2);levels=np.sqrt(np.mean(windows**2,axis=1));quiet=int(np.sum(levels.min(axis=1)<.005))
    if silent:assert np.abs(pcm).max()<1e-6
    else:assert quiet==0,{'unexpectedQuietWindows':quiet,'minimum10msRms':float(levels.min())}
    timestamps={}
    for kind,filter_name in [('video','showinfo'),('audio','ashowinfo')]:
        # Separate passes avoid interleaved audio/video log lines hiding frames
        # and producing false timestamp gaps in the parser.
        filters=['-an','-vf','scale=1:1,showinfo','-fps_mode:v','passthrough'] if kind=='video' else ['-vn','-af','ashowinfo']
        timing=subprocess.run([str(ffmpeg),'-v','info','-nostats','-i',str(movie),*filters,'-f','null','-'],capture_output=True,timeout=120)
        assert timing.returncode==0
        pts=np.array([float(v) for v in re.findall(r'Parsed_'+filter_name+r'[^\n]*?\bn:\s*\d+\s+pts:.*?pts_time:([-\d.]+)',timing.stderr.decode(errors='replace'))])
        assert len(pts)>a.seconds*20 and np.all(np.diff(pts)>0),(kind,'Missing/non-increasing media timestamps')
        timestamps[kind]={'frames':len(pts),'p95GapMs':float(np.percentile(np.diff(pts)*1000,95)),'maxGapMs':float(np.diff(pts).max()*1000)}
    tones=[]
    for segment in (pcm[:48000],pcm[-48000:]):
        tones.append([float(abs(np.sum(segment[:,ch]*np.exp(-2j*np.pi*f*np.arange(len(segment))/48000)))*2/len(segment)) for ch,f in enumerate((440,880))])
    if not silent:assert min(v for row in tones for v in row)>.02,tones
    report.update(passed=True,cleanDecode=True,unexpectedQuiet10ms=quiet,minimum10msRms=float(levels.min()),silent=silent,tones=tones,samples=samples,timestamps=timestamps)
finally:
    if root:
        try:api('/commands',{'command':'quit'});root.wait(timeout=15)
        except Exception:
            try:root.kill();root.wait(timeout=10)
            except psutil.NoSuchProcess:pass
    if session:
        try:session.detach()
        except Exception:pass
    for proc in reversed(owned):
        if proc.poll() is None:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    report['events']=events
    (out/'process-audio-format.json').write_text(json.dumps(report,indent=2))
print('Process audio format passed:',a.rate,a.fault,flush=True)
