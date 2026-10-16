"""Actual packaged capture -> browser or native OBS codec/audio playback."""
from pathlib import Path
helpers=Path(__file__).with_name('device-failure-packaged.py').read_text().split('\ntry:\n    t=')[0]
helpers=helpers.replace('a=p.parse_args()',"p.add_argument('--codecs',default='h264,av1,vp9,h265');p.add_argument('--obs',required=True);a=p.parse_args()")
exec(helpers)
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    (out/'fixture.json').write_text(json.dumps({'size':[1280,720],'hidden':False}))
    fixture=launch([sys.executable,Path(__file__).with_name('capture-resilience-packaged.py'),'--fixture',out],'fixture');time.sleep(1)
    for codec in a.codecs.split(','):
        folder=out/codec;folder.mkdir(exist_ok=True);discovery=folder/'control.json';stream='amd'+uuid.uuid4().hex
        app=launch([exe,'--headless','--source=window','--window=Game Capture Resilience Fixture',
                    '--stream='+stream,'--password=false','--video-codec='+codec,'--video-encoder='+('auto' if codec=='vp9' else 'amf'),
                    '--resolution=1280x720','--fps=30','--bitrate-kbps=4000','--audio-source=selected-window',
                    '--duration-ms=240000','--local-control','--local-control-discovery='+str(discovery)],codec)
        row={'codec':codec};report['cases'].append(row);root=psutil.Process(app.pid)
        started=time.monotonic()
        while time.monotonic()-started<40:
            assert app.poll() is None,'Publisher exited'
            if discovery.exists():
                try:
                    if api()['app']['live']:break
                except (OSError,ValueError):pass
            time.sleep(.2)
        else:raise AssertionError('Publisher did not start')
        observer=subprocess.run(['node',str(Path(__file__).with_name('amd-codec-receiver.js')),'--discovery='+str(discovery),
            '--stream='+stream,'--codec='+codec,'--report='+str(folder),*(['--obs='+a.obs] if codec=='h265' else [])],
            capture_output=True,text=True,encoding='utf-8',timeout=170,creationflags=subprocess.CREATE_NO_WINDOW)
        row.update(receiverExit=observer.returncode,stdout=observer.stdout,stderr=observer.stderr[-2000:],diagnostics=api())
        row['receiver']=json.loads((folder/'receiver.json').read_text())
        descendants=root.children(recursive=True);api('/commands',{'command':'quit'});assert app.wait(timeout=20)==0
        _,alive=psutil.wait_procs(descendants,timeout=10);assert not alive
        row['passed']=observer.returncode==0;row['childrenExited']=True
        if row['receiver'].get('recording'):
            file=Path(row['receiver']['recording']);ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe'
            decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(file),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=90,creationflags=subprocess.CREATE_NO_WINDOW)
            assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
            audio=subprocess.run([str(ffmpeg),'-v','error','-i',str(file),'-vn','-f','f32le','pipe:1'],capture_output=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
            values=np.frombuffer(audio.stdout,dtype=np.float32);assert len(values)>48000
            rms=float(np.sqrt(np.mean(values*values)));assert rms>.005,rms
            row['recording']={'cleanDecode':True,'audioRms':rms}
        (out/'results.json').write_text(json.dumps(report,indent=2));print(codec,row['passed'],flush=True)
    report['passed']=all(row['passed'] for row in report['cases']);assert report['passed']
finally:
    if app and app.poll() is None:
        try:api('/commands',{'command':'quit'});app.wait(timeout=20)
        except Exception:pass
    for proc in reversed(owned):
        if proc.poll() is None:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    (out/'results.json').write_text(json.dumps(report,indent=2))
