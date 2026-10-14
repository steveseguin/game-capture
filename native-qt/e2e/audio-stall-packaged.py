"""Pause only the owned app's WASAPI capture thread; verify real output survives.

Fault injection blocks the capture thread between its event wait and GetBuffer.
This models stalled delivery without disabling a real Windows device. Decode
the received media only after the application exits; no profiling claims.
"""
from pathlib import Path
helpers=Path(__file__).with_name('device-failure-packaged.py').read_text().split('\ntry:\n    t=')[0]
helpers=helpers.replace('a=p.parse_args()',"p.add_argument('--fuzz',action='store_true');a=p.parse_args()")
exec(helpers)
import frida,re,threading
session=None;script=None;fault=threading.Event();events=[]
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    (out/'fixture.json').write_text(json.dumps({'size':[1280,720],'hidden':False}))
    fixture=launch([sys.executable,Path(__file__).with_name('capture-resilience-packaged.py'),'--fixture',out],'fixture');time.sleep(1)
    ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe';movie=out/'audio-stall.mkv';discovery=out/'control.json'
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    receiver=launch([ffmpeg,'-v','warning','-i',f'udp://127.0.0.1:{port}?fifo_size=8192&overrun_nonfatal=1',
        '-t',('40' if a.fuzz else '32'),'-map','0','-c','copy',movie],'receiver');time.sleep(.3)
    app=launch([exe,'--headless','--source=window','--window=Game Capture Resilience Fixture',
        '--output=udp',f'--output-url=udp://127.0.0.1:{port}','--resolution=1280x720','--fps=30',
        '--video-encoder=software','--audio-source=selected-window','--duration-ms=70000',
        '--local-control','--local-control-discovery='+str(discovery)],'app')
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        try:
            if api().get('output',{}).get('state')==2:break
        except (OSError,ValueError):pass
        assert app.poll() is None
        time.sleep(.2)
    before=api();assert before['output']['state']==2 and before['audio']['primary_peak']>.01
    time.sleep(4)
    session=frida.attach(app.pid)
    script=session.create_script('const delays='+json.dumps([.12,.22,.26,.55,1.3,5, .3,2] if a.fuzz else [14])+''';
        const app=Process.mainModule;let index=0,next=0;
        Interceptor.attach(Process.getModuleByName('kernelbase.dll').getExportByName('WaitForMultipleObjects'),{
          onEnter(args){this.capture=args[0].toUInt32()===2 && args[2].toUInt32()===0 && [1000,0xffffffff].includes(args[3].toUInt32())
            && this.returnAddress.compare(app.base)>=0 && this.returnAddress.compare(app.base.add(app.size))<0;},
          onLeave(ret){if(this.capture && ret.toUInt32()===0 && index<delays.length && Date.now()>=next){
            const duration=delays[index++];send({phase:'stalled',duration,thread:Process.getCurrentThreadId()});
            Thread.sleep(duration);send({phase:'resumed'});next=Date.now()+1000;}}
        });
    ''')
    def message(m,data):
        events.append(dict(m,elapsed=time.monotonic()))
        if m.get('payload',{}).get('phase')=='stalled':fault.set()
    script.on('message',message);script.load();assert fault.wait(5),'Did not pause capture'
    samples=[];start=time.monotonic()
    while receiver.poll() is None and time.monotonic()-start<50:
        d=api();assert app.poll() is None and d['output']['state']==2,d
        assert d['output']['reconnects']==0,d['output']
        samples.append({'seconds':time.monotonic()-start,'diagnostics':d});time.sleep(.3)
    assert receiver.poll()==0,'Receiver stalled'
    assert any(m.get('payload',{}).get('phase')=='resumed' for m in events),events
    starts=[m for m in events if m.get('payload',{}).get('phase')=='stalled']
    assert len(starts)==(8 if a.fuzz else 1),events
    for event in starts:
        duration=event['payload']['duration']
        if duration<1:continue
        began=event['elapsed']-start
        frozen=[s for s in samples if began+.7<s['seconds']<began+duration-.2]
        assert frozen,'Did not sample the stalled interval'
        assert len({s['diagnostics']['audio']['last_primary_audio_chunk_ms'] for s in frozen})==1,'Audio did not actually stall'
        for s in frozen:
            assert all(s['diagnostics']['audio'][k]==0 for k in ('peak','level_rms','primary_peak','primary_level_rms')),'Stale VU meter during silence'
        if duration>4:
            first,last=frozen[0],frozen[-1]
            assert last['diagnostics']['video']['frames_sent']>first['diagnostics']['video']['frames_sent']+60
            assert last['diagnostics']['output']['audio_packets']>first['diagnostics']['output']['audio_packets']
    assert samples[-1]['diagnostics']['audio']['primary_peak']>.01,'VU meter did not recover'
    script.unload();session.detach();session=None
    api('/commands',{'command':'quit'});assert app.wait(timeout=15)==0
    fixture.terminate();fixture.wait(timeout=10)
    decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(movie),'-fps_mode','passthrough',
        '-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=60)
    assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
    raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-vn','-ar','48000','-ac','2','-f','f32le','-'],capture_output=True,timeout=30)
    assert raw.returncode==0
    pcm=np.frombuffer(raw.stdout,np.float32).reshape(-1,2);assert np.isfinite(pcm).all()
    blocks=pcm[:len(pcm)//480*480].reshape(-1,480,2)
    silent=np.max(np.abs(blocks),axis=(1,2))<1e-6
    runs=[];length=0
    for value in silent:
        length=length+1 if value else 0;runs.append(length)
    silent_seconds=max(runs)*.01;assert (3.5<silent_seconds<6 if a.fuzz else 12<silent_seconds<16),silent_seconds
    tones=[]
    for segment in (pcm[48000:96000],pcm[-96000:-48000]):
        values=[float(abs(np.sum(segment[:,ch]*np.exp(-2j*np.pi*f*np.arange(len(segment))/48000)))*2/len(segment)) for ch,f in enumerate((440,880))]
        tones.append(values);assert min(values)>.02,values
    frames=subprocess.run([str(ffmpeg),'-hide_banner','-i',str(movie),'-an','-vf','scale=1:1,showinfo',
        '-fps_mode','passthrough','-f','null','-'],capture_output=True,timeout=60)
    assert frames.returncode==0
    pts=np.array([float(v) for v in re.findall(r'Parsed_showinfo[^\n]*?\bn:\s*\d+\s+pts:.*?pts_time:([-\d.]+)',frames.stderr.decode(errors='replace'))])
    assert len(pts)>800 and np.all(np.diff(pts)>0)
    p95=float(np.percentile(np.diff(pts)*1000,95));assert p95<40,p95
    report.update(passed=True,events=events,samples=samples,silentSeconds=silent_seconds,
        tonesBeforeAfter=tones,videoFrames=len(pts),frameGapP95Ms=p95,frameGapMaxMs=float(np.diff(pts).max()*1000),cleanDecode=True)
finally:
    if session:
        try:session.detach()
        except Exception:pass
    for proc in reversed(owned):
        if proc.poll() is None:
            try:
                if proc==app:api('/commands',{'command':'quit'});proc.wait(timeout=20)
                else:proc.terminate();proc.wait(timeout=10)
            except Exception:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    (out/'audio-stall.json').write_text(json.dumps(report,indent=2))
print('Passed:',report.get('passed'),'silence',report.get('silentSeconds'),'seconds',flush=True)
