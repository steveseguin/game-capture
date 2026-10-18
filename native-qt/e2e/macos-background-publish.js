#!/usr/bin/env node
'use strict';
// Real packaged publisher -> owned transparent window -> ordinary browser.
// Verify decoded RGB, including a moving translucent edge; no paired-alpha receiver.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const name of ['app','fixture','reports'])assert(opts[name],'Missing --'+name);
const syphon=opts.source==='syphon',association=opts['syphon-alpha']||'straight';
const fixtureSource=opts['fixture-source']?path.resolve(opts['fixture-source']):path.join(__dirname,syphon?'macos-syphon-fixture.mm':'macos-alpha-fixture.mm');
assert(fs.statSync(fixtureSource).isFile(),'Fixture source must be retained with its binary');
assert(['straight','premultiplied'].includes(association));
const sourceSize=opts['source-size']||'640x360';
assert(['640x360','1280x720','1920x1080'].includes(sourceSize),'Unsupported --source-size');
assert(syphon||!opts['source-size'],'--source-size requires an owned Syphon sender');
const [sourceWidth,sourceHeight]=sourceSize.split('x').map(Number);
const lifecycle=opts.lifecycle==='true',loss=opts.loss||'none',remoteToken=crypto.randomBytes(24).toString('hex');
assert(!lifecycle||syphon);assert(['none','retire','kill'].includes(loss));assert(loss==='none'||lifecycle);
const pauseSeconds=Number(opts['pause-seconds']||30);
assert(Number.isInteger(pauseSeconds)&&pauseSeconds>=25&&pauseSeconds<=120&&pauseSeconds%5===0);
assert(!opts['pause-seconds']||lifecycle,'--pause-seconds requires --lifecycle=true');
const gui=opts.gui==='true',codec=opts.codec||'h264',encoder=opts.encoder||'videotoolbox';
const keyboardControls=opts['keyboard-controls']==='true';
assert(!opts['keyboard-controls']||['true','false'].includes(opts['keyboard-controls']));
assert(!keyboardControls||gui,'--keyboard-controls requires --gui=true');
const microphone=opts['microphone-device'];
assert(!microphone||(syphon&&opts['tone-helper']),'Virtual input workflow requires Syphon and the controlled --tone-helper');
const audioSourceArgument=opts['audio-source']||'none';
assert(['none','omitted','selected-window','default-output'].includes(audioSourceArgument));
assert(audioSourceArgument==='none'||syphon,'Audio routing checks require Syphon');
assert(!gui||['none','default-output'].includes(audioSourceArgument),'GUI routing uses explicit controls; omitted/default normalization belongs to CLI checks');
const systemAudio=audioSourceArgument==='default-output';
assert(!systemAudio||(opts['system-audio-device']&&opts['tone-helper']),
  'System mix workflow requires the controlled --system-audio-device and --tone-helper');
assert(!opts['system-audio-device']||systemAudio);
const mixedAudio=systemAudio&&!!microphone;
assert(!mixedAudio||(gui&&microphone===opts['system-audio-device']),
  'Combined-route check requires the GUI and the same owned BlackHole loopback for both paths');
if(gui&&microphone)assert.equal(microphone,'BlackHole2ch_UID','GUI fixture explicitly selects the existing BlackHole 2ch device');
const withAudio=!!microphone||systemAudio,toneDevice=systemAudio?opts['system-audio-device']:microphone;
const outputSize=opts['output-size']||(gui?'960x540':'640x360');
assert(['640x360','960x540','1280x720','1920x1080'].includes(outputSize),'Unsupported --output-size');
const [outputWidth,outputHeight]=outputSize.split('x').map(Number);
const fps=Number(opts.fps||30),bitrateKbps=Number(opts['bitrate-kbps']||4000);
assert([30,60].includes(fps));assert(Number.isInteger(bitrateKbps)&&bitrateKbps>=1000&&bitrateKbps<=30000);
const performanceSeconds=Number(opts['performance-seconds']||0);
assert(Number.isInteger(performanceSeconds)&&performanceSeconds>=0&&performanceSeconds<=300&&performanceSeconds%10===0);
assert(!performanceSeconds||syphon,'Sustained observation currently requires the owned Syphon sender');
const interactControls=opts['interact-controls']==='true';
const expectMediaActivity=opts['expect-media-activity']==='true';
assert(!interactControls||gui,'--interact-controls requires --gui=true');
const mode=opts.mode||'chroma',color=opts.color||'00FF00',cycles=Number(opts.cycles||1);
const ffmpegOptions=opts['ffmpeg-options']||'';assert(!/[\r\n]/.test(ffmpegOptions));
assert(!gui||!ffmpegOptions,'Custom tuning observation currently uses CLI mode');
const observationSeconds=Number(opts['observation-seconds']||5);
assert(Number.isInteger(observationSeconds)&&observationSeconds>=5&&observationSeconds<=30);
assert(['chroma','opaque'].includes(mode));assert(/^[0-9a-f]{6}$/i.test(color));
assert(['h264','h265','vp9','av1'].includes(codec));
assert(['vp9','av1'].includes(codec)?encoder==='software':codec==='h265'?encoder==='videotoolbox':['videotoolbox','x264'].includes(encoder));
assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=5);assert(gui||cycles===1);if(gui)assert(opts['ui-helper']);
assert(!mixedAudio||cycles===2,'Combined-route check requires two cycles to isolate primary and input contributions');
const rgb=[0,2,4].map(i=>parseInt(color.slice(i,i+2),16));
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Packaged window or Syphon background composition in an ordinary browser; GUI restores saved background/color settings and uses real Go Live/Stop; combo/color-picker interaction, physical devices and Windows excluded',
  source:syphon?'syphon':'window',sourceSize:[sourceWidth,sourceHeight],association,lifecycle,loss,gui,codec,encoder,mode,ffmpegOptions,observationSeconds,color:rgb,cycles:[],executableSha256:hash(exe),fixtureSha256:hash(fixture),
  fixtureSourceSha256:hash(fixtureSource),harnessSha256:hash(__filename),qtCocoaSha256:hash(path.resolve(opts.app,'Contents/PlugIns/platforms/libqcocoa.dylib')),passed:false};
result.interactControls=interactControls;
result.expectMediaActivity=expectMediaActivity;
result.microphoneDevice=microphone||null;
result.audioSourceArgument=audioSourceArgument;
result.systemAudioDevice=systemAudio?toneDevice:null;
result.mixedAudio=mixedAudio;
if(gui&&withAudio)result.scope='Packaged Syphon GUI audio-source/input selection, live input mute, repeated Go Live/Stop, decoded background composition and persisted audio preferences; physical devices and Windows excluded';
if(withAudio){
  result.toneFixtureSha256=hash(path.resolve(opts['tone-helper']));
  result.scope+=systemAudio?'; system mix of two owned BlackHole-output tone processes, silence/resume and late receiver':'; owned BlackHole stereo input, silence/resume and late receiver';
  if(mixedAudio)result.scope+='; same loopback feeds system and input routes; primary-gain zero and live input mute isolate each route, not independent physical sources';
  fs.copyFileSync(path.join(__dirname,'macos-audio-tone.mm'),path.join(report,'macos-audio-tone.mm'));
}
Object.assign(result,{outputSize:[outputWidth,outputHeight],fps,bitrateKbps,performanceSeconds,pauseSeconds});
result.qtWidgetsSha256=hash(path.resolve(opts.app,'Contents/Frameworks/QtWidgets.framework/Versions/A/QtWidgets'));
if(interactControls)result.scope='Packaged GUI background mode selection and native color-panel accept/cancel, decoded composition, Go Live/Stop and persisted settings after relaunch; physical devices and Windows excluded';
for(const name of ['macos-background-publish.js','macos-media-receiver.js','macos-alpha-fixture.mm','macos-ui-control.mm'])
  fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
const children=new Set();let browser,publisher,tone,interference;
function launch(command,args,label){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
  const child=spawn(command,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
  const log=fs.createWriteStream(path.join(report,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.stdout.on('data',b=>{child.output=(child.output+b.toString()).slice(-32768);});
  child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
  child.once('error',e=>{result.launchError=String(e);});return child;
}
async function api(control,route,body){
  const response=await fetch(control.base_url+route,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(response.ok,'Control HTTP '+response.status);return response.json();
}
const helpers=pid=>execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
  const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&Number(m[2])===pid&&path.basename(m[3])==='ffmpeg'?[Number(m[1])]:[];
});
function requireStereoAudio(observation,silent=false){
  assert(observation.tracks.some(t=>(/audio\/opus/i.test(t.codec)||
    (/audio\/red/i.test(t.codec)&&t.negotiatedCodecs.some(c=>/audio\/opus/i.test(c.mimeType))))&&t.packetsReceived>20),'Receiver has no Opus audio');
  const good=observation.spectra.filter(s=>silent?s.rms<.0005:
    s.tone440>-65&&s.tone880>-65&&s.rms>.001&&
    s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20);
  assert(good.length>=25,'Controlled stereo input or silence differs from the received audio');
  if(systemAudio&&!silent){
    assert(interference.exitCode===null&&!interference.signalCode,'Second owned audio process exited');
    assert(observation.spectra.filter(s=>s.excluded2000>-65).length>=25,'System mix did not include the second owned application');
  }
}
function analyze(data,minimumDistinct=30){
  assert(data.samples.length>=60,'Too few decoded frames');const ids=new Set(),failures=[];let checked=0,maxError=0;
  const composite=(foreground,alpha)=>foreground.map((v,c)=>Math.floor((v*alpha+rgb[c]*(255-alpha)+127)/255));
  for(const sample of data.samples){
    ids.add(sample.identity);let bad=false;
    const check=(pixel,expected,tolerance)=>{++checked;for(let c=0;c<3;c++){
      const error=Math.abs(pixel[c]-expected[c]);maxError=Math.max(maxError,error);if(error>tolerance)bad=true;
    }if(pixel[3]!==255)bad=true;};
    for(let stripe=0;stripe<4;stripe++)check(sample.bands[stripe],composite([240,60,30],stripe*85),10);
    // The sender's edge is eighty physical source pixels wide. Observations
    // use a 640-wide canvas; retain the six-output-pixel boundary exclusion.
    const scale=640/sourceWidth,left=(sample.identity*9%(sourceWidth-80))*scale,edgeWidth=80*scale;
    for(let i=0;i<sample.edge.length;i++){
      const x=4+i*8;
      // Exclude only six pixels around sharp compression/filter boundaries.
      if(Math.abs(x-left)<6||Math.abs(x-left-edgeWidth)<6||Math.min(x%160,160-x%160)<6)continue;
      const moving=x>left&&x<left+edgeWidth;
      check(sample.edge[i],composite(moving?[30,90,240]:[240,60,30],moving?170:Math.floor(x/160)*85),12);
    }
    if(bad)failures.push(sample.identity);
  }
  const summary={samples:data.samples.length,distinctIdentities:ids.size,checkedPixels:checked,maxChannelError:maxError,
    failedFrames:failures.length,failedIdentities:failures.slice(0,20)};
  assert(ids.size>=minimumDistinct,'Decoded fixture did not move');assert.equal(failures.length,0,'Background pixels differ: '+JSON.stringify(summary));
  assert(data.tracks.some(t=>t.codec?.toLowerCase()==='video/'+codec),'Wrong received codec');return summary;
}
async function observe(page,seconds=observationSeconds){return page.evaluate(async observationSeconds=>{
  const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth&&!v.paused);if(!video)throw Error('No playing video');
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=3;
  const context=canvas.getContext('2d',{willReadFrequently:true}),samples=[];let callback,stopped=false;
  const rows=[20,120,270];
  const readRows=image=>{
    for(let row=0;row<rows.length;row++){
      // Preserve the original 640x360 scale and pixel centers, clipping to
      // the three rows the oracle actually inspects. All 100 sample positions
      // remain unchanged; avoid reading back 357 unused rows on every frame.
      context.save();context.beginPath();context.rect(0,row,640,1);context.clip();
      context.drawImage(image,0,row-rows[row],640,360);context.restore();
    }
    return context.getImageData(0,0,640,3).data;
  };
  const positions=[...Array.from({length:16},(_,i)=>[i*40+20,0]),
    ...Array.from({length:4},(_,i)=>[i*160+80,1]),...Array.from({length:80},(_,i)=>[4+i*8,2])];
  // Verify the optimized observation against the original full-frame method
  // on one immutable video frame before every observation interval.
  const frozen=new VideoFrame(video);let equivalence;
  try{
    const reference=document.createElement('canvas');reference.width=640;reference.height=360;
    const ref=reference.getContext('2d',{willReadFrequently:true});ref.drawImage(frozen,0,0,640,360);
    const full=ref.getImageData(0,0,640,360).data,clipped=readRows(frozen);let maxError=0;
    for(const [x,row] of positions)for(let c=0;c<4;c++)maxError=Math.max(maxError,Math.abs(full[(rows[row]*640+x)*4+c]-clipped[(row*640+x)*4+c]));
    if(maxError!==0)throw Error('Clipped-row observation differs from full-frame pixels: '+maxError);
    equivalence={positions:positions.length,channels:4,maxError};
  }finally{frozen.close();}
  const started=performance.now();
  function frame(now,metadata){
    if(stopped)return;const frozen=new VideoFrame(video);let data;
    try{data=readRows(frozen);}finally{frozen.close();}
    const pixel=(x,row)=>Array.from(data.slice((row*640+x)*4,(row*640+x)*4+4));
    let identity=0;for(let bit=0;bit<16;bit++)if(pixel(bit*40+20,0)[0]>127)identity|=1<<bit;
    samples.push({identity,time:now,mediaTime:metadata.mediaTime,bands:[0,1,2,3].map(i=>pixel(i*160+80,1)),edge:Array.from({length:80},(_,i)=>pixel(4+i*8,2))});
    callback=video.requestVideoFrameCallback(frame);
  }
  callback=video.requestVideoFrameCallback(frame);await new Promise(r=>setTimeout(r,observationSeconds*1000));stopped=true;video.cancelVideoFrameCallback(callback);
  const ended=performance.now();
  const tracks=[];for(const pc of window.reviewPCs){const stats=await pc.getStats();for(const t of stats.values())
    if(t.type==='inbound-rtp')tracks.push({...t,codec:stats.get(t.codecId)?.mimeType});}
  return {samples,tracks,width:video.videoWidth,height:video.videoHeight,started,ended,method:'Three clipped rows with frozen frames',equivalence};
},seconds);}
async function observeDecodedIdentities(page,seconds){return page.evaluate(async seconds=>{
  if(typeof MediaStreamTrackProcessor!=='function')throw Error('Decoded observation requires MediaStreamTrackProcessor');
  const received=window.reviewPCs.filter(pc=>pc.connectionState==='connected')
    .flatMap(pc=>pc.getReceivers()).map(r=>r.track).find(t=>t?.kind==='video'&&t.readyState==='live');
  if(!received)throw Error('No received video track');
  const track=received.clone(),samples=[];let reader,timer,width=0,height=0,started,ended;
  try{
    reader=new MediaStreamTrackProcessor({track,maxBufferSize:4}).readable.getReader();
    const canvas=new OffscreenCanvas(640,1),context=canvas.getContext('2d',{willReadFrequently:true});
    started=performance.now();timer=setTimeout(()=>reader.cancel().catch(()=>{}),seconds*1000);
    while(true){
      const {done,value:frame}=await reader.read();if(done)break;
      try{
        width=frame.displayWidth;height=frame.displayHeight;
        context.drawImage(frame,0,Math.floor(height*20/360),width,1,0,0,640,1);
        const row=context.getImageData(0,0,640,1).data;let identity=0;
        for(let bit=0;bit<16;bit++)if(row[(bit*40+20)*4]>127)identity|=1<<bit;
        samples.push({identity,time:performance.now(),mediaTime:frame.timestamp/1000000});
      }finally{frame.close();}
    }
    ended=performance.now();
  }finally{
    clearTimeout(timer);if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}track.stop();
  }
  return {samples,width,height,started,ended,method:'MediaStreamTrackProcessor'};
},seconds);}
(async()=>{console.log('Reports: '+report);try{
  if(gui){
    const state=JSON.parse(execFileSync(path.resolve(opts['ui-helper']),[String(process.pid),'session-state'],{encoding:'utf8',timeout:10000}));
    assert(!state.screenLocked,'Native GUI workflow requires an unlocked session');
  }
  const title='Mac Background Fixture '+crypto.randomBytes(8).toString('hex'),stream='macbackground'+crypto.randomBytes(12).toString('hex');
  const source=launch(fixture,[title,...(syphon?[association,opts.flipped==='true'?'flipped':'normal']:[])],'fixture');
  await waitFor(()=>{assert(source.exitCode===null&&!source.signalCode,'Fixture exited');return source.output.includes(syphon?'uuid':'windowId');},10000,'Fixture not ready');
  result.fixture=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));
  if(syphon&&sourceSize!=='640x360')source.stdin.write(`resize ${sourceWidth} ${sourceHeight}\n`);
  const sourceId=String(syphon?result.fixture.uuid:result.fixture.windowId);
  async function sourceState(){
    const previous=source.output;source.stdin.write('state\n');let state;
    await waitFor(()=>{
      if(source.output===previous)return false;
      const line=source.output.trim().split('\n').at(-1);
      try{state=JSON.parse(line);}catch{return false;}
      return Number.isFinite(state.publishedFrames)&&Number.isFinite(state.time);
    },5000,'Owned Syphon state unavailable');return state;
  }
  fs.copyFileSync(fixtureSource,path.join(report,path.basename(fixtureSource)));
  if(withAudio){
    // The helper refuses any device whose name is not BlackHole, and never
    // changes defaults. No physical output or input is selected by this fixture.
    tone=launch(path.resolve(opts['tone-helper']),[toneDevice,'440','880'],'tone');
    await waitFor(()=>{assert(tone.exitCode===null&&!tone.signalCode,'Owned tone fixture exited');return tone.output.includes('READY '+toneDevice);},5000,'Owned tone fixture not ready');
  }
  if(systemAudio){
    interference=launch(path.resolve(opts['tone-helper']),[toneDevice,'2000','2000'],'second-tone');
    await waitFor(()=>{assert(interference.exitCode===null&&!interference.signalCode,'Second owned tone fixture exited');return interference.output.includes('READY '+toneDevice);},5000,'Second owned tone fixture not ready');
  }
  const setToneSound=enabled=>{
    tone.stdin.write(enabled?'sound\n':'silence\n');
    if(interference)interference.stdin.write(enabled?'sound\n':'silence\n');
  };
  const discovery=path.join(report,'control.json');let args;
  if(gui){
    const settings=path.join(report,'settings'),org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
    fs.writeFileSync(path.join(org,'Game Capture.ini'),`[video]\nsourceMode=${syphon?'syphon':'window'}\ncodec=${codec}\nencoderMode=${encoder==='x264'?'software':encoder}\nresolution=${outputSize}\nfps=${fps}\nbitratePresetKbps=${bitrateKbps}\nalphaWorkflow=false\nalphaBackgroundMode=${interactControls?'none':mode}\nalphaBackgroundColor=#${interactControls?'112233':color}\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\n[syphon]\nalpha=${association}\n`);
    args=[`--settings-dir=${settings}`];result.uiHelperSha256=hash(path.resolve(opts['ui-helper']));
  }else args=['--headless',...(syphon?['--source=syphon',`--syphon-server=${sourceId}`,`--syphon-alpha=${association}`]:[`--window=${title}`]),`--stream=${stream}`,'--password=false',`--video-codec=${codec}`,`--video-encoder=${encoder}`,
    ...(ffmpegOptions?[`--ffmpeg-options=${ffmpegOptions}`]:[]),
    ...(microphone?['--include-microphone',`--microphone-device=${microphone}`]:[]),
    ...(lifecycle?['--remote-control',`--remote-token=${remoteToken}`]:[]),
    `--alpha-background=${mode}`,`--alpha-background-color=#${color}`,
    ...(audioSourceArgument==='omitted'?[]:[`--audio-source=${audioSourceArgument}`]),
    `--width=${outputWidth}`,`--height=${outputHeight}`,`--fps=${fps}`,`--bitrate-kbps=${bitrateKbps}`,`--duration-ms=${(lifecycle?240000+pauseSeconds*1000:120000)+performanceSeconds*1000}`];
  publisher=launch(exe,[...args,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher');
  await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited');return fs.existsSync(discovery);},15000,'Control unavailable');
  const control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  if(syphon){
    // Control discovery can precede Cocoa's asynchronous Syphon announcement.
    // Wait for this exact owned UUID, as the GUI source-list workflow does.
    const started=Date.now();result.discoveryObservation={polls:0,elapsedMs:0};
    await waitFor(async()=>{
      assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited during discovery');
      assert(source.exitCode===null&&!source.signalCode,'Owned sender exited during discovery');
      ++result.discoveryObservation.polls;
      return (await api(control,'/sources/syphon')).sources.some(s=>s.id===sourceId);
    },15000,'Owned Syphon UUID was not discovered');
    result.discoveryObservation.elapsedMs=Date.now()-started;result.discovery=true;
  }
  const ui=(action,name,value)=>execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),action,...(name?[name]:[]),...(value===undefined?[]:[value])],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
  const rows=()=>JSON.parse(ui('dump')),find=name=>rows().find(r=>String(r.AXIdentifier||'').endsWith('.'+name));
  const ready=()=>{const b=find('goLiveButton');return b?.AXEnabled&&b.AXTitle==='Go live';};
  const toggleLive=async()=>{
    if(!keyboardControls){ui('press','goLiveButton');return;}
    execFileSync('/usr/bin/open',['-a',path.resolve(opts.app),'--args',...args,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],{timeout:10000,stdio:'pipe'});
    ui('activate');ui('focus','goLiveButton');
    await waitFor(()=>find('goLiveButton')?.AXFocused,5000,'Go Live/Stop did not receive keyboard focus');
    const title=find('goLiveButton').AXTitle;ui('key','space');
    (result.keyboardActivations||=[]).push({title,key:'Space',focused:true});
  };
  result.keyboardControls=keyboardControls;
  if(gui){
    await waitFor(()=>!!find('advancedToggle'),15000,'Publisher GUI not ready');
    await waitFor(async()=>(await api(control,syphon?'/sources/syphon':'/sources/windows')).sources.some(w=>w.name.includes(title)),15000,'Owned source missing');
    ui('press','refreshSourcesButton');ui('set','sourceFilterInput',title);
    await waitFor(()=>{try{ui('source-ready',title);return true;}catch{return false;}},10000,'Source not actionable');
    ui('select-source',title);ui('verify-selected',title);ui('set','streamIdInput',stream);ui('set','passwordInput','false');
    if(!Number(find('advancedToggle')?.AXValue))ui('press','advancedToggle');
    if(withAudio){
      result.audioInteractions={};
      const select=async(name,title)=>{
        ui('press',name);
        const matches=value=>value===title||(title==='BlackHole 2ch'&&/^BlackHole 2ch(?: \(Default\))? - /.test(value));
        const row=await waitFor(()=>rows().find(r=>r.AXRole==='AXStaticText'&&matches(r.AXTitle||'')),5000,'Audio choice missing: '+title);
        ui('press',row.AXTitle);
        await waitFor(()=>find(name)?.AXTitle===row.AXTitle,5000,'Audio choice did not commit: '+title);
        return row.AXTitle;
      };
      assert.equal(find('audioSourceSelect')?.AXTitle,'No audio');
      assert.equal(find('microphoneDeviceSelect')?.AXTitle,'No microphone');
      if(systemAudio)await select('audioSourceSelect','System audio (all apps)');
      if(microphone){
        result.audioInteractions.microphoneTitle=await select('microphoneDeviceSelect','BlackHole 2ch');
        const settingsFile=path.join(report,'settings','VDO.Ninja','Game Capture.ini');
        await waitFor(()=>fs.readFileSync(settingsFile,'utf8').includes('microphoneDeviceId='+microphone),5000,'GUI did not save the explicit virtual input UID');
      }
      result.audioInteractions.selected=rows().filter(r=>/\.(audioSourceSelect|microphoneDeviceSelect|microphoneMuteButton)$/.test(r.AXIdentifier||''));
      const idle=await api(control,'/diagnostics');
      assert(!idle.app.live&&!idle.app.capturing);assert.equal(idle.metrics.audio_packets_sent,0);
      result.audioInteractions.captureStayedOffBeforeGoLive=true;
    }
    if(interactControls){
      result.controlInteractions={modeSelections:[]};
      const selectMode=async title=>{
        ui('press','alphaBackgroundModeSelect');
        await waitFor(()=>rows().some(r=>r.AXRole==='AXStaticText'&&r.AXTitle===title),5000,'Background menu missing');
        ui('press',title);
        await waitFor(()=>find('alphaBackgroundModeSelect')?.AXTitle===title,5000,'Background selection did not commit');
        result.controlInteractions.modeSelections.push(title);
      };
      for(const title of ['Chroma background','Opaque background','No background fill']){
        await selectMode(title);
        assert.equal(find('alphaBackgroundColorButton')?.AXEnabled,title!=='No background fill');
      }
      await selectMode(mode==='chroma'?'Chroma background':'Opaque background');
      const chooseColor=async(hex,accept)=>{
        ui('press','alphaBackgroundColorButton');
        await waitFor(()=>rows().some(r=>r.AXRole==='AXWindow'&&r.AXTitle==='Colors'),5000,'Native color panel missing');
        ui('press','Color Sliders');
        await waitFor(()=>rows().some(r=>r.AXRole==='AXPopUpButton'&&/^(Grayscale Slider|RGB Sliders|CMYK Sliders|HSB Sliders)$/.test(r.AXValue)),5000,'Native color slider selector missing');
        const popup=rows().find(r=>r.AXRole==='AXPopUpButton'&&/^(Grayscale Slider|RGB Sliders|CMYK Sliders|HSB Sliders)$/.test(r.AXValue));
        if(popup.AXValue!=='RGB Sliders'){
          ui('press',popup.AXValue);
          await waitFor(()=>rows().some(r=>r.AXRole==='AXMenuItem'&&r.AXTitle==='RGB Sliders'),5000,'RGB slider menu item missing');
          ui('press','RGB Sliders');
        }
        await waitFor(()=>rows().some(r=>r.AXIdentifier==='hex'&&r.AXRole==='AXTextField'),5000,'Native hex input missing');
        ui('set','hex',hex);ui('confirm','hex');ui('press',accept?'OK':'Cancel');
        await waitFor(()=>!rows().some(r=>r.AXRole==='AXWindow'&&r.AXTitle==='Colors'),5000,'Native color panel did not close');
      };
      await chooseColor(color,true);
      assert.equal(find('alphaBackgroundColorButton')?.AXTitle,'#'+color.toUpperCase());
      result.controlInteractions.acceptedColor=color.toUpperCase();
      const cancelled=color.toUpperCase()==='ABCDEF'?'654321':'ABCDEF';
      await chooseColor(cancelled,false);
      assert.equal(find('alphaBackgroundColorButton')?.AXTitle,'#'+color.toUpperCase(),'Cancel changed the saved background color');
      result.controlInteractions.cancelledColor=cancelled;
    }
    assert.equal(find('alphaBackgroundModeSelect')?.AXEnabled,true);
    assert.equal(find('alphaBackgroundModeSelect')?.AXTitle,mode==='chroma'?'Chroma background':'Opaque background');
    assert.equal(find('alphaBackgroundColorButton')?.AXEnabled,true);
    assert.equal(find('alphaBackgroundColorButton')?.AXTitle,'#'+color.toUpperCase());
    result.backgroundControls=rows().filter(r=>/\.(alphaBackgroundModeSelect|alphaBackgroundColorButton|alphaWorkflowCheck)$/.test(r.AXIdentifier||''));
    if(!['h265','av1'].includes(codec)){
      ui('press','alphaWorkflowCheck');assert.equal(find('alphaBackgroundModeSelect')?.AXEnabled,false);assert.equal(find('alphaBackgroundColorButton')?.AXEnabled,false);
      ui('press','alphaWorkflowCheck');assert.equal(find('alphaBackgroundModeSelect')?.AXEnabled,true);assert.equal(find('alphaBackgroundColorButton')?.AXEnabled,true);
      result.alphaMutualExclusion=true;
    }
  }
  browser=await chromium.launch({headless:true,...(opts['receiver-executable']?{executablePath:path.resolve(opts['receiver-executable'])}:{}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();
  for(let index=1;index<=cycles;index++){
    const cycle={index,passed:false};result.cycles.push(cycle);
    if(mixedAudio){
      cycle.requestedPrimaryGain=index===1?1:0;
      const target=cycle.requestedPrimaryGain*100,current=Number(find('primaryAudioGainSpin')?.AXValue);
      assert(Number.isInteger(current)&&current>=0&&current<=200);
      if(target!==current)ui(target>current?'increment':'decrement','primaryAudioGainSpin',String(Math.abs(target-current)));
      await waitFor(()=>Number(find('primaryAudioGainSpin')?.AXValue)===target,5000,'Primary gain did not commit');
    }
    if(gui&&expectMediaActivity)assert.equal((await api(control,'/diagnostics')).macos_media_activity_active,false,'Idle GUI retained a media activity');
    if(gui){await waitFor(ready,10000,'Go Live not ready');await toggleLive();}source.stdin.write('raise\n');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.app.live&&d.app.capturing&&d.source.has_frame;},15000,'Publisher did not start');
    const page=await receiver(browser,stream,publisher),received=await observe(page);
    fs.writeFileSync(path.join(report,`received-${index}.json`),JSON.stringify(received));
    await page.screenshot({path:path.join(report,`received-${index}.png`)});cycle.received=analyze(received);
    assert.equal(received.width,outputWidth);assert.equal(received.height,outputHeight);
    cycle.liveDiagnostics=await api(control,'/diagnostics');const d=cycle.liveDiagnostics;
    if(expectMediaActivity)assert.equal(d.macos_media_activity_active,true,'Live publisher has no media activity');
    assert.equal(d.source.source_id,sourceId);
    if(syphon){assert.equal(d.source.mode,'syphon');assert.equal(d.source.width,sourceWidth);assert.equal(d.source.height,sourceHeight);assert.equal(d.platform_capabilities.syphon_capture,true);assert.equal(d.syphon_input_alpha,association);}assert.equal(d.video.alpha_background_mode,mode);
    assert.deepEqual(d.video.alpha_background_color_rgb,rgb);assert.equal(d.video.alpha_enabled,false);
    assert.equal(d.video.hardware_encoder,encoder==='videotoolbox');assert.equal(d.video.active_codec,codec==='av1'?'AV1':codec==='h265'?'H.265':codec==='h264'?'H.264':'VP9');
    assert.equal(d.audio.source_mode,systemAudio?'default-output':'none','Unexpected primary audio routing');
    for(const key of ['encode_failures','encode_timeouts','alpha_packets_sent','alpha_encode_failures','alpha_encode_timeouts'])assert.equal(d.video[key],0,key);
    if(withAudio){
      assert.equal(d.audio.include_microphone,!!microphone);assert.equal(d.audio.output_channels,2);
      if(microphone)assert(d.audio.active_microphone_source.includes('BlackHole'),'Wrong input device active');
      if(mixedAudio){assert.equal(d.audio.primary_gain,cycle.requestedPrimaryGain);assert.equal(d.audio.additional_gain,1);}
      cycle.audio=await observeAudio(page);requireStereoAudio(cycle.audio);
    }else assert.equal(d.metrics.audio_packets_sent,0);
    cycle.helperPids=helpers(publisher.pid);assert.equal(cycle.helperPids.length,['vp9','av1'].includes(codec)?1:0);
    if(performanceSeconds){
      cycle.performance={scope:'Owned Syphon sender, publisher and browser on one Mac; independent decoded-track and presented identities, not calibrated latency or external-sender qualification',chunks:[],meetsTarget:true};
      for(let elapsed=0;elapsed<performanceSeconds;elapsed+=10){
        const sourceBefore=await sourceState();
        const before=await api(control,'/diagnostics');
        const [data,decoded,audio]=await Promise.all([observe(page,10),observeDecodedIdentities(page,10),withAudio?observeAudio(page):undefined]);
        if(withAudio){assert(tone.exitCode===null&&!tone.signalCode,'Owned tone fixture exited');requireStereoAudio(audio);}
        const after=await api(control,'/diagnostics');
        if(expectMediaActivity)assert.equal(after.macos_media_activity_active,true,'Sustained publisher lost its media activity');
        const sourceAfter=await sourceState();
        fs.writeFileSync(path.join(report,`sustained-${index}-${elapsed}.json`),JSON.stringify(data));
        fs.writeFileSync(path.join(report,`decoded-${index}-${elapsed}.json`),JSON.stringify(decoded));
        const pixels=analyze(data),seconds=(data.ended-data.started)/1000;
        const gaps=data.samples.slice(1).map((f,i)=>(f.mediaTime-data.samples[i].mediaTime)*1000).sort((a,b)=>a-b);
        const receivedFps=pixels.distinctIdentities/seconds,deliveryRatio=receivedFps/fps;
        const chunk={elapsed,seconds,pixels,receivedFps,deliveryRatio,
          source:{before:sourceBefore,after:sourceAfter,fps:(sourceAfter.publishedFrames-sourceBefore.publishedFrames)/(sourceAfter.time-sourceBefore.time)},
          p95MediaGapMs:gaps[Math.floor(gaps.length*.95)],maxMediaGapMs:Math.max(...gaps),
          publisherRssKiB:Number(execFileSync('/bin/ps',['-o','rss=','-p',String(publisher.pid)],{encoding:'utf8'}).trim()),
          beforeDiagnostics:before,afterDiagnostics:after};
        if(withAudio){chunk.audio=audio;assert.equal(after.audio.send_failures,0);}
        const decodedSeconds=(decoded.ended-decoded.started)/1000;
        const decodedGaps=decoded.samples.slice(1).map((f,i)=>(f.mediaTime-decoded.samples[i].mediaTime)*1000).sort((a,b)=>a-b);
        const decodedDistinct=new Set(decoded.samples.map(f=>f.identity)).size;
        chunk.decoded={seconds:decodedSeconds,distinctIdentities:decodedDistinct,receivedFps:decodedDistinct/decodedSeconds,
          deliveryRatio:decodedDistinct/decodedSeconds/fps,p95MediaGapMs:decodedGaps[Math.floor(decodedGaps.length*.95)],maxMediaGapMs:Math.max(...decodedGaps)};
        chunk.decoded.meetsTarget=chunk.decoded.deliveryRatio>=.95&&chunk.decoded.p95MediaGapMs<=2000/fps+2&&decoded.width===outputWidth&&decoded.height===outputHeight;
        chunk.source.meetsTarget=chunk.source.fps>=fps*.95;
        chunk.presentationMeetsTarget=deliveryRatio>=.95&&chunk.p95MediaGapMs<=2000/fps+2&&
          data.width===outputWidth&&data.height===outputHeight;
        chunk.meetsTarget=chunk.source.meetsTarget&&chunk.decoded.meetsTarget&&chunk.presentationMeetsTarget&&
          data.width===outputWidth&&data.height===outputHeight&&
          after.video.encode_failures===0&&after.video.encode_timeouts===0;
        cycle.performance.chunks.push(chunk);cycle.performance.meetsTarget&&=chunk.meetsTarget;save();
        console.log(`${encoder}: ${elapsed+10}s ${outputSize}/${fps} presented=${receivedFps.toFixed(2)} decoded=${chunk.decoded.receivedFps.toFixed(2)} fps ratio=${deliveryRatio.toFixed(3)} p95=${chunk.p95MediaGapMs.toFixed(1)}ms target=${chunk.meetsTarget}`);
      }
      assert(cycle.performance.meetsTarget,'Sustained output missed the delivery target');
    }
    if(withAudio){
      if(gui&&microphone){
        // Cycle 1 retains the system route while input is muted. Cycle 2 has
        // primary gain zero: input alone must play, and muting it must silence
        // the received track even though both owned output processes continue.
        ui('press','microphoneMuteButton');
        await waitFor(async()=>(await api(control,'/diagnostics')).audio.microphone_muted,5000,'Live input mute did not apply');
        await sleep(700);
        const [audio,video]=await Promise.all([observeAudio(page),observe(page)]);
        const expectSilence=!systemAudio||(mixedAudio&&cycle.requestedPrimaryGain===0);
        requireStereoAudio(audio,expectSilence);
        cycle.liveInputMuted={audio,video:analyze(video),expectedSilence:expectSilence,diagnostics:await api(control,'/diagnostics')};save();
        ui('press','microphoneMuteButton');
        await waitFor(async()=>!(await api(control,'/diagnostics')).audio.microphone_muted,5000,'Live input unmute did not apply');
        await sleep(700);cycle.liveInputUnmuted=await observeAudio(page);requireStereoAudio(cycle.liveInputUnmuted);
      }
      if(systemAudio){
        tone.stdin.write('silence\n');await sleep(700);
        cycle.secondApplicationOnly=await observeAudio(page);
        assert(cycle.secondApplicationOnly.spectra.filter(s=>s.tone440<-65&&s.tone880<-65&&s.excluded2000>-65).length>=25,
          'System mix did not retain the second application when the first went silent');
      }
      setToneSound(false);await sleep(700);
      const [audio,video]=await Promise.all([observeAudio(page),observe(page)]);
      requireStereoAudio(audio,true);cycle.silence={audio,video:analyze(video)};
      setToneSound(true);await sleep(700);
      cycle.resumedAudio=await observeAudio(page);requireStereoAudio(cycle.resumedAudio);
      const late=await receiver(browser,stream,publisher);
      const [lateAudio,lateVideo]=await Promise.all([observeAudio(late),observe(late)]);
      requireStereoAudio(lateAudio);cycle.lateReceiver={audio:lateAudio,video:analyze(lateVideo)};
      assert.equal(lateVideo.width,outputWidth);assert.equal(lateVideo.height,outputHeight);await late.close();
    }
    if(lifecycle){
      cycle.frameRateChanges=[];
      for(const targetFps of new Set([10,30,fps])){
        const sent=await page.evaluate(({targetFps,remoteToken})=>{
          const peer=Object.keys(window.session?.rpcs||{})[0];
          return !!peer&&typeof window.session.sendRequest==='function'&&
            window.session.sendRequest({requestVideoHack:true,keyname:'frameRate',value:targetFps,remote:remoteToken},peer)!==false;
        },{targetFps,remoteToken});
        assert(sent,'Could not request live FPS');
        await waitFor(async()=>(await api(control,'/diagnostics')).video.configured_fps===targetFps,15000,'FPS unchanged');
        await sleep(800);const before=await api(control,'/diagnostics'),start=Date.now(),data=await observe(page),seconds=(Date.now()-start)/1000;
        const after=await api(control,'/diagnostics'),captured=after.video.frames_captured-before.video.frames_captured;
        const distinct=new Set(data.samples.map(s=>s.identity)).size;
        const cadence={targetFps,seconds,captured,distinct,before,after};
        cycle.frameRateChanges.push(cadence);
        fs.writeFileSync(path.join(report,`received-${index}-fps-${targetFps}.json`),JSON.stringify(data));save();
        const detail=JSON.stringify({targetFps,seconds,captured,distinct});
        assert(distinct>=targetFps*seconds*.85&&distinct<=targetFps*seconds*1.1+2,'Decoded FPS mismatch: '+detail);
        assert(captured>=targetFps*seconds*.85&&captured<=targetFps*seconds*1.1+2,'Capture FPS mismatch: '+detail);
      }
      source.stdin.write('pause\n');await sleep(800);
      const staticBefore=await api(control,'/diagnostics');
      const pausedSource=await sourceState();assert(pausedSource.paused,'Owned source did not pause');
      cycle.static={sourceBefore:pausedSource,phases:[]};save();
      async function heldObservation(viewer,label,phase,silent){
        const [data,decoded,audio]=await Promise.all([observe(viewer,pauseSeconds/5),
          observeDecodedIdentities(viewer,pauseSeconds/5),withAudio?observeAudio(viewer):undefined]);
        fs.writeFileSync(path.join(report,`held-${index}-${phase}-${label}.json`),JSON.stringify(data));
        fs.writeFileSync(path.join(report,`held-decoded-${index}-${phase}-${label}.json`),JSON.stringify(decoded));
        const pixels=analyze(data,1),seconds=(data.ended-data.started)/1000;
        const gaps=data.samples.slice(1).map((s,i)=>(s.mediaTime-data.samples[i].mediaTime)*1000).sort((a,b)=>a-b);
        const decodedSeconds=(decoded.ended-decoded.started)/1000;
        const decodedGaps=decoded.samples.slice(1).map((s,i)=>(s.mediaTime-decoded.samples[i].mediaTime)*1000).sort((a,b)=>a-b);
        const observation={viewer:label,phase,seconds,pixels,frames:data.samples.length,
          identity:data.samples[0].identity,p95MediaGapMs:gaps[Math.floor(gaps.length*.95)],audio,
          decoded:{seconds:decodedSeconds,frames:decoded.samples.length,
            identities:[...new Set(decoded.samples.map(s=>s.identity))],
            p95MediaGapMs:decodedGaps[Math.floor(decodedGaps.length*.95)]}};
        cycle.static.phases.push(observation);save();
        console.log(`${encoder}: paused ${phase} ${label} presented=${(observation.frames/seconds).toFixed(2)} decoded=${(decoded.samples.length/decodedSeconds).toFixed(2)} fps`);
        assert.equal(pixels.distinctIdentities,1,'Paused image changed');
        assert.equal(observation.identity,pausedSource.identity&65535,'Receiver did not retain the last published source image');
        assert.equal(data.width,outputWidth);assert.equal(data.height,outputHeight);
        assert.equal(decoded.width,outputWidth);assert.equal(decoded.height,outputHeight);
        assert.deepEqual(observation.decoded.identities,[pausedSource.identity&65535]);
        assert(decoded.samples.length/decodedSeconds>=fps*.95,'Held decoded image delivery fell below target');
        assert(observation.decoded.p95MediaGapMs<=2000/fps+2,'Held decoded image media cadence stalled');
        assert(observation.frames/seconds>=fps*.95,'Held image delivery fell below target');
        assert(observation.p95MediaGapMs<=2000/fps+2,'Held image media cadence stalled');
        if(withAudio)requireStereoAudio(audio,silent);
        return observation;
      }
      await heldObservation(page,'existing','sound',false);
      const late=await receiver(browser,stream,publisher);
      if(withAudio){setToneSound(false);await sleep(700);}
      // Keep both ordinary receivers playing, but run the expensive pixel
      // oracle on one viewer at a time. Simultaneous canvas readbacks can
      // depress browser presentation even when both decoders receive 60 fps.
      // Every observed viewer still has the same pixel and cadence criteria.
      await heldObservation(page,'existing','silence',withAudio);
      await heldObservation(late,'late','silence',withAudio);
      if(withAudio){setToneSound(true);await sleep(700);}
      await heldObservation(page,'existing','resumed-audio',false);
      await heldObservation(late,'late','resumed-audio',false);
      const staticAfter=await api(control,'/diagnostics');
      cycle.static.sourceAfter=await sourceState();
      assert(cycle.static.sourceAfter.paused);assert.equal(cycle.static.sourceAfter.publishedFrames,pausedSource.publishedFrames);
      if(withAudio)assert.equal(staticAfter.audio.send_failures,0);
      cycle.staticReadback={before:staticBefore.syphon_readback,after:staticAfter.syphon_readback};
      assert.equal(staticAfter.syphon_readback.gpu_copies,staticBefore.syphon_readback.gpu_copies,'Paused sender triggered additional GPU readbacks');
      cycle.lateStatic=true;await late.close();source.stdin.write('resume\nresize 320 240\n');
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.source.width===320&&d.source.height===240;},10000,'Native Syphon resize absent');
      const resized=await observe(page);assert(new Set(resized.samples.map(s=>s.identity)).size>=30,'Resized stream frozen');
      cycle.resize={native:[320,240],decoded:[resized.width,resized.height],distinct:new Set(resized.samples.map(s=>s.identity)).size};
      source.stdin.write(`resize ${sourceWidth} ${sourceHeight}\n`);
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.source.width===sourceWidth&&d.source.height===sourceHeight;},10000,'Native Syphon restore absent');
      await sleep(800);
      const [restoredVideo,restoredAudio]=await Promise.all([observe(page),withAudio?observeAudio(page):undefined]);
      cycle.restored=analyze(restoredVideo);
      if(withAudio){requireStereoAudio(restoredAudio);cycle.restoredAudio=restoredAudio;}
      assert((await api(control,'/diagnostics')).source.resize_count>=2);
    }
    await page.close();
    if(gui){
      const start=Date.now();await toggleLive();
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing&&ready();},10000,'Stop did not complete');
      cycle.stopMs=Date.now()-start;assert(cycle.stopMs<5000);
      const stopped=await api(control,'/diagnostics');await sleep(500);cycle.stoppedDiagnostics=await api(control,'/diagnostics');
      if(expectMediaActivity)assert.equal(cycle.stoppedDiagnostics.macos_media_activity_active,false,'Stop retained the media activity');
      for(const key of ['frames_captured','frames_sent','alpha_packets_sent'])assert.equal(stopped.video[key],cycle.stoppedDiagnostics.video[key]);
      assert.equal(stopped.metrics.audio_packets_sent,cycle.stoppedDiagnostics.metrics.audio_packets_sent,'Audio packets continued after Stop');
      for(const pid of cycle.helperPids){assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH','Encoder helper survived Stop');}
    }
    cycle.passed=true;save();
  }
  if(loss==='none')await api(control,'/commands',{command:'quit'});
  else {
    const started=Date.now();
    if(loss==='kill')source.kill('SIGKILL');else source.stdin.write('retire\n');
    await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not stop after Syphon source loss');
    result.sourceLossMs=Date.now()-started;assert(result.sourceLossMs<5000);
    assert(fs.readFileSync(path.join(report,'publisher.log'),'utf8').includes('Syphon server disconnected'),'Missing actionable source-loss message');
    if(loss==='retire')assert(source.exitCode===null&&!source.signalCode,'Retired sender owner should remain alive');
  }
  await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');
  result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,loss==='none'?0:3);assert(!fs.existsSync(discovery));
  if(interactControls||(gui&&withAudio)){
    publisher=launch(exe,[...args,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher-relaunch');
    await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode);return fs.existsSync(discovery)&&!!find('advancedToggle');},15000,'Relaunched GUI not ready');
    const restoredControl=JSON.parse(fs.readFileSync(discovery));assert.equal(restoredControl.pid,publisher.pid);
    if(!Number(find('advancedToggle')?.AXValue))ui('press','advancedToggle');
    assert.equal(find('alphaBackgroundModeSelect')?.AXTitle,mode==='chroma'?'Chroma background':'Opaque background');
    assert.equal(find('alphaBackgroundColorButton')?.AXTitle,'#'+color.toUpperCase());
    if(interactControls)result.controlInteractions.persistedAfterRelaunch=true;
    if(withAudio){
      assert.equal(find('audioSourceSelect')?.AXTitle,systemAudio?'System audio (all apps)':'No audio');
      assert.equal(find('microphoneDeviceSelect')?.AXTitle,microphone?result.audioInteractions.microphoneTitle:'No microphone');
      assert.equal(Number(find('microphoneMuteButton')?.AXValue),0);
      if(mixedAudio)assert.equal(Number(find('primaryAudioGainSpin')?.AXValue),0);
      const idle=await api(restoredControl,'/diagnostics');
      assert(!idle.app.live&&!idle.app.capturing);assert.equal(idle.metrics.audio_packets_sent,0);
      result.audioInteractions.persistedAfterRelaunch=true;
      result.audioInteractions.relaunchStayedIdle=true;
    }
    await api(restoredControl,'/commands',{command:'quit'});
    await waitFor(()=>publisher.exitCode!==null,10000,'Relaunched publisher did not quit');
    result.relaunchedPublisherExit=await publisher.closed;assert.equal(result.relaunchedPublisherExit.code,0);assert(!fs.existsSync(discovery));
  }
  assert(!fs.readFileSync(path.join(report,'publisher.log'),'utf8').includes(remoteToken),'Remote token exposed in log');
  for(const pid of result.cycles.flatMap(c=>c.helperPids))assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
  if(interference){interference.stdin.write('quit\n');result.secondToneExit=await interference.closed;assert.equal(result.secondToneExit.code,0);}
  if(tone){tone.stdin.write('quit\n');result.toneExit=await tone.closed;assert.equal(result.toneExit.code,0);}
  if(loss==='kill')assert.equal((await source.closed).signal,'SIGKILL');
  else {source.stdin.write('quit\n');assert.equal((await source.closed).code,0);}if(!syphon){result.fixtureFinal=JSON.parse(source.output.trim().split('\n').at(-1));assert(result.fixtureFinal.paintCount>=60);}result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
  if(gui&&publisher?.exitCode===null){try{fs.writeFileSync(path.join(report,'failed-ui.json'),execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),'dump'],{encoding:'utf8',timeout:10000}));}catch{}}
}finally{
  if(browser)await browser.close();
  for(const child of children)child.kill('SIGTERM');
  await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
  save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
