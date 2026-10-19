'use strict';
// Shared actual Qt controls for packaged external-output GUI workflows.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{execFileSync,spawn}=require('child_process');
const {waitFor,sleep}=require('./macos-media-receiver');
module.exports=function({exe,report,env,launch,api,title,inputLabel,previewBeforeLive=false,source}){
  const wayland=env.QT_QPA_PLATFORM==='wayland';
  assert(!previewBeforeLive||(wayland&&env.GC_QA_OWNED_WAYLAND&&source),'External-output preview requires an owned Wayland source');
  assert((wayland?process.env.GC_QA_WAYLAND_DESKTOP:process.env.GC_QA_PRIVATE_DESKTOP)&&process.env.DBUS_SESSION_BUS_ADDRESS,'Use the matching owned desktop fixture');
  const evidence={backend:wayland?'wayland':'x11',portalSelections:[],previews:[]};
  const hash=file=>require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(previewBeforeLive){
    evidence.previewHelpers={};
    for(const name of ['linux-preview-observer.py','linux-pipewire-snapshot.py']){
      fs.copyFileSync(path.join(__dirname,name),path.join(report,name));evidence.previewHelpers[name]=hash(path.join(report,name));
    }
  }
  let keyboard,keyboardDirectory,selector,portalOwner;
  const portal=path.join(report,'linux-portal-select.py');
  if(wayland)fs.copyFileSync(path.join(__dirname,'linux-portal-select.py'),portal);
  function checkPortal(){
    const owner=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.impl.portal.desktop.gnome'],{env,encoding:'utf8',timeout:5000}).trim();
    if(portalOwner)assert.equal(owner,portalOwner,'GNOME portal owner changed');else evidence.portalOwner=portalOwner=owner;
  }
  async function initialize(){
    if(!wayland||keyboard)return;checkPortal();
    if(env.GC_QA_OWNED_WAYLAND){assert(env.GC_QA_KEYBOARD_SOCKET&&fs.statSync(env.GC_QA_KEYBOARD_SOCKET).isSocket());evidence.ownedCompositorInput=true;return;}
    keyboardDirectory=fs.mkdtempSync(path.join(require('os').tmpdir(),'gc-wayland-keys-'));fs.chmodSync(keyboardDirectory,0o700);
    env.GC_QA_KEYBOARD_SOCKET=path.join(keyboardDirectory,'input.sock');
    keyboard=spawn('sudo',['-n','python3',portal,'--keyboard-server='+env.GC_QA_KEYBOARD_SOCKET],{env,stdio:['pipe','pipe','pipe']});
    keyboard.closed=new Promise(resolve=>keyboard.once('close',resolve));let ready='';keyboard.stdout.on('data',d=>ready+=d);keyboard.stderr.on('data',d=>process.stderr.write(d));
    await waitFor(()=>{assert.equal(keyboard.exitCode,null,'Owned keyboard exited');return ready.includes('ready');},10000,'Owned keyboard not ready');
  }
  async function captureAction(session,action,promote=false){
    let selected,log;
    if(wayland)assert(title.startsWith('Owned Linux Capture '),'Portal fixture title must be eligible before opening consent');
    if(wayland&&!promote){
      checkPortal();selected=path.join(report,'portal-'+(evidence.portalSelections.length+1)+'.json');
      log=fs.createWriteStream(selected+'.log');selector=spawn('python3',[portal,'--title='+title,'--output='+selected],{env,stdio:['ignore','pipe','pipe']});
      selector.stdout.pipe(log,{end:false});selector.stderr.pipe(log,{end:false});selector.closed=new Promise(resolve=>selector.once('close',()=>log.end(resolve)));
    }
    session.ui('press',action);
    await waitFor(async()=>{if(wayland&&!promote)assert(selector.exitCode===null||selector.exitCode===0,'Portal selector failed');const d=await api(session.control,'/diagnostics');return action==='Preview window'?d.app.window_preview_active:d.app.live;},30000,'GUI capture action did not finish: '+action);
    if(wayland&&!promote){await waitFor(()=>selector.exitCode!==null,10000,'Portal selection did not finish');await selector.closed;assert.equal(selector.exitCode,0);const observation=JSON.parse(fs.readFileSync(selected));assert(observation.passed);evidence.portalSelections.push({action,file:path.basename(selected),sha256:hash(selected)});checkPortal();}
  }
  const goLive=(session,promote=false)=>captureAction(session,'Go live',promote);
  let snapshotSerial=0;
  function captureNodes(session){
    const output=path.join(report,'preview-pipewire-'+(++snapshotSerial)+'.json');
    const snapshot=JSON.parse(execFileSync('python3',[path.join(report,'linux-pipewire-snapshot.py'),'--output='+output],{env,encoding:'utf8',timeout:7000}));
    const clients=new Set(snapshot.objects.filter(o=>o.type==='PipeWire:Interface:Client'&&String(o.info?.props?.['application.process.id'])===String(session.publisher.pid)).map(o=>o.id));
    return {nodes:snapshot.objects.filter(o=>o.type==='PipeWire:Interface:Node'&&clients.has(o.info?.props?.['client.id'])&&o.info?.props?.['media.type']==='Video').map(o=>({id:o.id,serial:o.info.props['object.serial']})),file:path.basename(output),sha256:hash(output),batches:snapshot.batches};
  }
  async function localOnly(session,active){
    const d=await api(session.control,'/diagnostics');
    assert.equal(d.app.window_preview_active,active);
    assert(!d.app.live&&!d.app.capturing&&!d.app.primary_audio_capturing&&!d.app.microphone_capturing,'External-output preview opened audio or publishing');
    assert.equal(d.video.frames_sent,0);assert.equal(d.video.frames_captured,0);assert.equal(d.metrics.audio_packets_sent,0);
    assert(!d.output||!d.output.muxer_pid,'External-output preview started a mux helper');
    const streams=JSON.parse(execFileSync('pactl',['--format=json','list','source-outputs'],{env,encoding:'utf8',timeout:5000})).filter(s=>String(s.properties?.['application.process.id'])===String(session.publisher.pid));
    assert.equal(streams.length,0,'Preview opened an audio recording stream');
    const graph=captureNodes(session);assert.equal(graph.nodes.length,active?1:0);
    return {app:d.app,videoFramesSent:d.video.frames_sent,audioPacketsSent:d.metrics.audio_packets_sent,audioCaptureStreams:streams.length,graph};
  }
  async function previewPixels(session,label,identity){
    let sourceIdentity=null;
    if(identity!=='none'){
      sourceIdentity=await source.evaluate(id=>{
        fixture.paused=true;fixture.id=id;paint();let observed=0;
        for(let bit=0;bit<16;bit++)if(ctx.getImageData(Math.floor((.2+(bit+.5)*.6/16)*canvas.width),Math.floor(.5*canvas.height),1,1).data[0]>127)observed|=1<<bit;
        return observed;
      },identity);
      assert.equal(sourceIdentity,identity);await sleep(2200);
    }
    const output=path.join(report,'preview-'+label+'.png');
    const shot=JSON.parse(execFileSync('python3',[path.join(report,'linux-preview-observer.py'),'--pid='+session.publisher.pid,'--output='+output,'--expected='+identity],{env,encoding:'utf8',timeout:20000}));
    return {...shot,sourceIdentity,file:path.basename(output),sha256:hash(output)};
  }
  async function preparePreview(session,protocol){
    const entry={protocol};evidence.previews.push(entry);session.previewEvidence=entry;
    entry.idle=await localOnly(session,false);
    await captureAction(session,'Preview window');entry.initial=await localOnly(session,true);
    entry.firstPixels=await previewPixels(session,protocol+'-first',13735);
    entry.changedPixels=await previewPixels(session,protocol+'-changed',51546);
    session.ui('press','Stop preview');await waitFor(async()=>!(await api(session.control,'/diagnostics')).app.window_preview,10000,'External-output preview did not stop');
    entry.stopped=await localOnly(session,false);entry.clearedPixels=await previewPixels(session,protocol+'-stopped','none');
    await captureAction(session,'Preview window');entry.beforePromotion=await localOnly(session,true);
    entry.restartedPixels=await previewPixels(session,protocol+'-restarted',24681);
    await source.evaluate(()=>fixture.paused=false);
  }
  async function close(){
    if(selector&&selector.exitCode===null){selector.kill('SIGTERM');await selector.closed;}
    if(keyboard){keyboard.stdin.end();await waitFor(()=>keyboard.exitCode!==null,8000,'Owned keyboard did not stop');await keyboard.closed;}
    if(keyboardDirectory)fs.rmdirSync(keyboardDirectory);
    if(wayland){await sleep(2500);checkPortal();evidence.portalSurvived=true;}
  }
  env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1';
  const helper=path.join(report,'linux-ui-control.py');
  fs.copyFileSync(path.join(__dirname,'linux-ui-control.py'),helper);
  const settings=path.join(report,'private-gui-settings'),ini=path.join(settings,'VDO.Ninja/Game Capture.ini');
  const labels={whip:'WHIP',rtmp:'RTMP / RTMPS',srt:'SRT (caller)',rtsp:'RTSP / VRChat (TCP)','rtsp-udp':'RTSP (UDP)',udp:'UDP / MPEG-TS (LAN)',rist:'RIST'};
  const secrets={whip:'WHIP bearer token',srt:'SRT passphrase',rtmp:'RTMP stream key'};
  const sensitive=[];let serial=0,configured=false;
  const reference=()=>{const text=fs.readFileSync(ini,'utf8'),value=text.match(/^profilesEncrypted="?@ByteArray\(([A-Za-z0-9+/=]+)\)"?$/m)?.[1];assert(value,'Missing opaque profile reference');const decoded=Buffer.from(value,'base64').toString();assert(/^linux-secret-service-v1:[0-9a-f-]{36}$/.test(decoded));return value;};
  function privacy(){
    const files=[];function visit(dir){if(!fs.existsSync(dir))return;for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())visit(file);else if(item.isFile())files.push(file);}}
    visit(settings);visit(path.join(report,'private-state'));for(const name of fs.readdirSync(report))if(name.startsWith('gui-')&&name.endsWith('.log'))files.push(path.join(report,name));
    for(const file of files){const data=fs.readFileSync(file,'utf8');assert(!sensitive.some(value=>value&&data.includes(value)),'Output credential/URL in plaintext application settings or log');}
  }
  async function open(){
    await initialize();
    const discovery=path.join(report,'gui-'+(++serial)+'-control.json');
    const publisher=launch(exe,['--settings-dir='+settings,'--local-control','--local-control-port=0','--local-control-discovery='+discovery],'gui-'+serial);
    await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'No GUI discovery');
    const control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
    const ui=(...args)=>execFileSync('python3',[helper,String(publisher.pid),...args],{env,encoding:'utf8',timeout:wayland?60000:12000,stdio:['ignore','pipe','pipe']});
    await waitFor(()=>{try{return JSON.parse(ui('dump')).some(r=>['Go live','Go live unavailable'].includes(r.name));}catch{return false;}},20000,'GUI not accessible');
    assert(!(await api(control,'/diagnostics')).app.capturing,'Restoring settings started capture');
    return {publisher,control,discovery,ui};
  }
  async function quit(session){await api(session.control,'/commands',{command:'quit'});await waitFor(()=>session.publisher.exitCode!==null,10000,'GUI did not quit');assert.equal(await session.publisher.closed,0);assert(!fs.existsSync(session.discovery));privacy();}
  async function start(protocol,url,secret='',streamId='',beforeGoLive=async()=>{}){
    sensitive.push(url,secret);let session=await open();let {ui}=session;
    if(!configured){
      ui('press','Show advanced settings');ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)');
      ui('choose','1280x720','960x540');ui('choose','60','30');
      const microphone=JSON.parse(ui('dump')).find(r=>r.role==='combo box'&&['No microphone','Linux default microphone/input'].includes(r.name));assert(microphone);ui('choose-prefix',microphone.name,inputLabel);
      const current=JSON.parse(ui('dump')).find(r=>r.role==='combo box'&&['Selected window/app audio','No audio'].includes(r.name));assert(current);
      ui('choose',current.name,'Selected microphone/input');configured=true;
    }
    const current=JSON.parse(ui('dump')).find(r=>r.role==='combo box'&&['VDO.Ninja (default)',...Object.values(labels)].includes(r.name));assert(current);
    if(current.name!==labels[protocol])ui('choose',current.name,labels[protocol]);
    ui('text','Output URL',url);if(secrets[protocol])ui('text',secrets[protocol],secret);
    if(protocol==='srt'){ui('text','Stream ID',streamId);ui('value','SRT latency','420');}
    if(protocol!=='whip'){
      const toggle=JSON.parse(ui('dump')).find(r=>r.name==='Audio encoding');assert(toggle);if(!toggle.states.includes('checked'))ui('press','Audio encoding');
      ui('value','AAC bitrate','192');
    }
    const savedReference=reference();await quit(session);
    session=await open();ui=session.ui;
    assert.equal(reference(),savedReference);assert.equal(JSON.parse(ui('read-text','Output URL')),url);
    if(secrets[protocol]){ui('reveal',secrets[protocol]);assert.equal(JSON.parse(ui('read-text',secrets[protocol])),secret);ui('reveal',secrets[protocol]);}
    if(protocol==='srt'){assert.equal(JSON.parse(ui('read-text','Stream ID')),streamId);assert.equal(JSON.parse(ui('dump')).find(r=>r.name==='SRT latency'&&r.role==='spin button').value,420);}
    if(protocol!=='whip')assert.equal(JSON.parse(ui('dump')).find(r=>r.name==='AAC bitrate'&&r.role==='spin button').value,192);
    ui('source',wayland?'Choose a window':title);
    if(previewBeforeLive)await preparePreview(session,protocol);
    await beforeGoLive();await goLive(session,previewBeforeLive);
    if(previewBeforeLive){
      const entry=session.previewEvidence;entry.promotedApp=(await api(session.control,'/diagnostics')).app;
      assert(entry.promotedApp.live&&entry.promotedApp.capturing&&!entry.promotedApp.window_preview);
      entry.promotedGraph=captureNodes(session);assert.deepEqual(entry.promotedGraph.nodes,entry.beforePromotion.graph.nodes,'External publishing replaced the preview grant');
      entry.promotedSameSession=true;
    }
    privacy();return {...session,profileRestored:true};
  }
  async function stop(session){session.ui('press','Stop streaming');await waitFor(async()=>{const d=await api(session.control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'GUI did not stop');privacy();}
  async function restart(session){await goLive(session);}
  async function microphoneMuted(session,muted){
    const before=await api(session.control,'/diagnostics');
    assert.equal(before.audio.microphone_muted,!muted,'Microphone is already in the requested state');
    assert(before.app.live&&before.app.capturing&&before.app.microphone_capturing);
    session.ui('press',muted?'Mute microphone':'Unmute microphone');
    await waitFor(async()=>(await api(session.control,'/diagnostics')).audio.microphone_muted===muted,5000,'GUI microphone state did not change');
    const after=await api(session.control,'/diagnostics');
    assert(after.app.live&&after.app.capturing&&after.app.microphone_capturing,'Microphone control stopped capture');
    assert.equal(after.output.state,2);assert.equal(after.output.reconnects,before.output.reconnects);
    return {muted,before,after};
  }
  return {start,stop,restart,quit,privacy,close,evidence,microphoneMuted};
};
