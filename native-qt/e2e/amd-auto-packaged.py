"""Actual AMD Auto fallback with hardware MFT discovery absent in owned processes.

Frida changes only this application's enumeration, never installed drivers. The
remaining capture, audio, AMF encoding and receiver are real. A failed-AMF case
also denies only the owned h264_amf child launch, verifying software recovery.
"""
from pathlib import Path
helpers=Path(__file__).with_name('device-failure-packaged.py').read_text().split('\ntry:\n    t=')[0]
helpers=helpers.replace('a=p.parse_args()',"p.add_argument('--expect',choices=['amf','software'],required=True)\np.add_argument('--deny-amf',action='store_true')\na=p.parse_args()")
exec(helpers)
import frida,re,threading
import faulthandler
faulthandler.dump_traceback_later(90,repeat=True)

device=frida.get_local_device();sessions=[];events=[];root=None;children=[]
discovery=out/'control.json';ffmpeg=exe.parent/'ffmpeg/bin/ffmpeg.exe';movie=out/'received.mkv'
fault=r'''
const callbacks=[], hooked=new Set();
const absent=Memory.alloc(16);absent.writeByteArray(Array(16).fill(0x5a));
const denied=Memory.allocUtf16String('Z:\\amd-qa-missing-runtime\\ffmpeg.exe');
Process.attachModuleObserver({onAdded(module){
 const enumeration=module.findExportByName('MFTEnumEx');
 if(enumeration&&!hooked.has(String(enumeration))){
  hooked.add(String(enumeration));
  Interceptor.attach(enumeration,{
   onEnter(args){this.hidden=(args[1].toUInt32()&4)!==0;this.count=args[5];
    if(this.hidden)args[0]=absent;},
   onLeave(result){if(this.hidden)send({kind:'hardware-mft-hidden',result:result.toInt32(),count:this.count.readU32()});}
  });
 }
 const create=module.findExportByName('CreateProcessW');
 if(DENY_AMF&&create&&!hooked.has(String(create))){
  hooked.add(String(create));Interceptor.attach(create,{onEnter(args){
   const line=args[1].isNull()?'':args[1].readUtf16String();
   if(line.includes('h264_amf')){args[0]=denied;send({kind:'amf-launch-denied'});}
  }});
 }
}});
'''

def instrument(pid):
    session=device.attach(pid);sessions.append(session)
    if exe.name=='desktop-studio.exe':session.enable_child_gating()
    script=session.create_script('const DENY_AMF='+json.dumps(a.deny_amf)+';\n'+fault)
    script.on('message',lambda m,data:events.append(dict(pid=pid,**m.get('payload',m))))
    script.load()

def child_added(child):
    try:
        children.append(psutil.Process(child.pid))
        if Path(child.path).name.lower()==exe.name.lower():instrument(child.pid)
    except Exception as error:events.append({'type':'error','error':str(error)})
    finally:device.resume(child.pid)

def dispatch_child(child):threading.Thread(target=child_added,args=(child,),daemon=True).start()
device.on('child-added',dispatch_child)
try:
    t=np.arange(96000)/48000;pcm=np.stack([.04*np.sin(2*np.pi*f*t) for f in (440,880)],axis=1)
    with wave.open(str(out/'tone.wav'),'wb') as f:f.setparams((2,2,48000,0,'NONE','not compressed'));f.writeframes((pcm*32767).astype('<i2').tobytes())
    (out/'fixture.json').write_text(json.dumps({'size':[1280,720],'hidden':False}))
    fixture=launch([sys.executable,Path(__file__).with_name('capture-resilience-packaged.py'),'--fixture',out],'fixture');time.sleep(1)
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    receiver=launch([ffmpeg,'-v','warning','-i',f'udp://127.0.0.1:{port}?fifo_size=8192&overrun_nonfatal=1',
                     '-t','15','-map','0','-c','copy',movie],'receiver')
    app_log=(out/'app.log').open('wb');logs.append(app_log)
    def output(pid,fd,data):
        if root and pid==root.pid:app_log.write(data);app_log.flush()
    device.on('output',output)
    argv=[str(exe),'--headless','--source=window','--window=Game Capture Resilience Fixture',
          '--output=udp',f'--output-url=udp://127.0.0.1:{port}','--resolution=1280x720','--fps=30',
          '--video-encoder=auto','--audio-source=selected-window','--duration-ms=90000',
          '--local-control','--local-control-discovery='+str(discovery)]
    pid=device.spawn(argv,cwd=str(exe.parent),stdio='pipe',env=dict(os.environ,LOCALAPPDATA=str(out),GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING='1'))
    root=psutil.Process(pid);instrument(pid);device.resume(pid)
    began=time.monotonic();samples=[]
    while receiver.poll() is None and time.monotonic()-began<65:
        assert root.is_running(),'Publisher exited'
        if discovery.exists():
            d=api();samples.append(d)
        assert not any(e.get('type')=='error' for e in events),events
        time.sleep(.3)
    assert receiver.poll()==0,'Receiver did not finish'
    final=api();report['video']=final['video'];report['startupAndRecordingSeconds']=time.monotonic()-began
    assert any(e.get('kind')=='hardware-mft-hidden' and e['count']==0 and e['result']==0 for e in events),events
    assert final['video']['requested_encoder']=='Auto'
    if a.expect=='amf':assert final['video']['active_encoder']=='FFmpeg h264_amf' and final['video']['hardware_encoder'],final['video']['active_encoder']
    else:assert not final['video']['hardware_encoder'],final['video']['active_encoder']
    if a.deny_amf:assert any(e.get('kind')=='amf-launch-denied' for e in events),events
    api('/commands',{'command':'quit'});exit_code=root.wait(timeout=25);assert exit_code==0,exit_code;root=None
    fixture.terminate();fixture.wait(timeout=10)
    decoded=subprocess.run([str(ffmpeg),'-v','error','-xerror','-i',str(movie),'-fps_mode','passthrough','-enc_time_base','1:1000000','-f','null','-'],capture_output=True,timeout=90)
    assert decoded.returncode==0 and not decoded.stderr,decoded.stderr
    raw=subprocess.run([str(ffmpeg),'-v','error','-i',str(movie),'-vn','-ac','2','-ar','48000','-f','f32le','-'],capture_output=True,timeout=45)
    assert raw.returncode==0
    pcm=np.frombuffer(raw.stdout,np.float32).reshape(-1,2)[48000:-48000]
    assert len(pcm)>48000 and np.isfinite(pcm).all()
    blocks=pcm[:len(pcm)//480*480].reshape(-1,480,2);minimum=float(np.sqrt(np.mean(blocks*blocks,axis=1)).min())
    assert minimum>.005,minimum
    _,alive=psutil.wait_procs(children,timeout=10);assert not alive,'Owned encoder child survived shutdown'
    report.update(passed=True,cleanDecode=True,minimum10msRms=minimum,expectedEncoder=a.expect,deniedAmf=a.deny_amf)
finally:
    if root:
        try:api('/commands',{'command':'quit'});root.wait(timeout=15)
        except Exception:
            for proc in reversed([root,*root.children(recursive=True)]):
                try:proc.kill();proc.wait(timeout=10)
                except psutil.NoSuchProcess:pass
    for session in sessions:
        try:session.detach()
        except Exception:pass
    device.off('child-added',dispatch_child)
    for proc in reversed(owned):
        if proc.poll() is None:proc.kill();proc.wait(timeout=10)
    for log in logs:log.close()
    report['events']=events
    (out/'amd-auto.json').write_text(json.dumps(report,indent=2))
print('AMD Auto packaged workflow passed:',a.expect,'deny AMF:',a.deny_amf,flush=True)
faulthandler.cancel_dump_traceback_later()
