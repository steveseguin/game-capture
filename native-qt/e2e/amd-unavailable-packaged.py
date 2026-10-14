"""Explicit AMD selection on a non-AMD host must fail clearly without fallback."""
from pathlib import Path
helpers=Path(__file__).with_name('device-failure-packaged.py').read_text().split('\ntry:\n    t=')[0]
helpers=helpers.replace('a=p.parse_args()',"p.add_argument('--codec',choices=['h264','h265'],default='h264');a=p.parse_args()")
exec(helpers)
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    (out/'fixture.json').write_text(json.dumps({'size':[1280,720],'hidden':False}))
    fixture=launch([sys.executable,Path(__file__).with_name('capture-resilience-packaged.py'),'--fixture',out],'fixture');time.sleep(1)
    discovery=out/'control.json';started=time.monotonic()
    destination=['--output=udp','--output-url=udp://127.0.0.1:18987'] if a.codec=='h264' else ['--server=ws://127.0.0.1:9']
    app=launch([exe,'--headless','--source=window','--window=Game Capture Resilience Fixture',*destination,
        '--video-codec='+a.codec,'--resolution=1280x720','--fps=30','--video-encoder=amf','--audio-source=none',
        '--duration-ms=15000','--local-control','--local-control-discovery='+str(discovery)],'app')
    root=psutil.Process(app.pid);children=[];encoder_args=None
    while app.poll() is None and time.monotonic()-started<40:
        try:
            current=root.children(recursive=True);children.extend(current)
            for child in current:
                try:
                    argv=child.cmdline()
                    if ('h264_amf' if a.codec=='h264' else 'hevc_amf') in argv:encoder_args=argv
                except psutil.NoSuchProcess:pass
        except psutil.NoSuchProcess:pass
        time.sleep(.01)
    assert app.poll() in (1,2,3),'Expected a normal unsupported-encoder failure'
    text=(out/'app.log').read_text(errors='replace')
    assert 'Requested AMD encoder could not start' in text,text[-1500:]
    assert 'Falling back to software' not in text
    assert encoder_args,'Did not observe the owned AMF process'
    def option(name):return encoder_args[encoder_args.index(name)+1]
    assert option('-forced_idr')==option('-aud')=='1'
    if a.codec=='h264':
        assert option('-bsf:v')=='h264_metadata=aud=insert' and option('-header_spacing')=='1'
        assert 'eq(mod(n,'+option('-g')+'),0)' in option('-force_key_frames')
    else:assert '-bsf:v' not in encoder_args,'HEVC AMF still uses the incompatible metadata filter'
    _,alive=psutil.wait_procs(children,timeout=10);assert not alive,'Encoder child survived failure'
    report.update(passed=True,codec=a.codec,exitCode=app.returncode,seconds=time.monotonic()-started,hardwareEncodingTested=False,encoderArguments=encoder_args)
finally:
    for proc in reversed(owned):
        if proc.poll() is None:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    (out/'amd-unavailable.json').write_text(json.dumps(report,indent=2))
print('Unsupported AMD selection failed cleanly',flush=True)
