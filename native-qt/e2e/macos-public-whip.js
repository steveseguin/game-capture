#!/usr/bin/env node
'use strict';
// Packaged arm64 app -> trusted public HTTPS WHIP -> one owned browser viewer.
// The VDO.Ninja WHIP service requires its viewer to register before publishing.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {spawn}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,installReceiverProbe,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
for(const key of ['app','reports','fixture','tone-helper','microphone-device'])assert(opts[key],'Missing --'+key);
assert.equal(process.platform,'darwin');
const relayOnly=opts['ice-mode']==='relay';
assert(!opts['ice-mode']||relayOnly,'Optional --ice-mode must be relay');
const receiverReconnect=opts['receiver-reconnect']==='true';
assert(!opts['receiver-reconnect']||['true','false'].includes(opts['receiver-reconnect']));
assert(!receiverReconnect||relayOnly,'Receiver recovery currently requires --ice-mode=relay');
const encoders=(opts.encoders||'videotoolbox,x264').split(',');
assert(encoders.length&&encoders.every(e=>['videotoolbox','x264'].includes(e)));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const exe=path.join(path.resolve(opts.app),'Contents/MacOS/game-capture');
assert(fs.existsSync(path.join(path.resolve(opts.app),'Contents/Frameworks')),'Use a deployed bundle');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Public trusted HTTPS WHIP signaling with one local browser receiver; no remote media-route or TURN qualification implied',
  endpoint:'https://whip.vdo.ninja',executableSha256:hash(exe),harnessSha256:hash(__filename),
  receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),cases:[],passed:false};
if(relayOnly){result.iceMode='relay';result.scope='Public trusted HTTPS WHIP with publisher relay-only media to one local browser; selected public relay endpoint must match its SDP offer';}
if(receiverReconnect)result.receiverReconnect=true;
for(const name of ['macos-public-whip.js','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let browser;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_)/.test(k)));
  const p=spawn(path.resolve(program),args,{env,cwd:report,stdio:['pipe','pipe','pipe']});children.add(p);
  p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});let output='';p.stdout.on('data',d=>output+=d);p.output=()=>output;
  p.on('error',e=>p.launchError=String(e));p.closed=new Promise(resolve=>p.once('close',(code,signal)=>{children.delete(p);log.end();resolve({code,signal});}));return p;
}
async function api(control,route,body){
  const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  assert(r.ok,'Control status '+r.status);return r.json();
}
function audioCheck(value,silent=false){
  assert(value.tracks.some(t=>t.codec==='audio/opus'&&t.packetsReceived>20),'No received Opus');
  assert(value.spectra.filter(s=>silent?s.rms<.0005:s.rms>.001&&s.tone440>-65&&s.tone880>-65&&
    s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length>=25,'Wrong stereo tones/silence');
}
async function videoCheck(page){
  const video=await observeDecoded(page,6000,null,'syphon'),distinctFrames=requireMoving(video,'Public WHIP');
  assert.equal(video.width,640);assert.equal(video.height,360);assert(distinctFrames>=150,'Insufficient distinct decoded frames');
  return {video,distinctFrames};
}
async function relayRoute(page){
  const route=await page.evaluate(async()=>{
    const peers=window.reviewPCs.filter(p=>p.connectionState==='connected');
    if(peers.length!==1)throw Error('Expected exactly one connected WHIP peer');
    const pc=peers[0],stats=await pc.getStats();
    const transport=[...stats.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId);
    const pair=stats.get(transport?.selectedCandidatePairId);
    if(!pair)throw Error('No selected ICE pair');
    const remote=stats.get(pair.remoteCandidateId),local=stats.get(pair.localCandidateId);
    const offered=(pc.remoteDescription.sdp.match(/^a=candidate:.*$/gm)||[]).map(line=>{
      const parts=line.trim().split(/\s+/);return {address:parts[4],port:Number(parts[5]),type:parts[7]};
    });
    const address=remote.address||'';
    return {state:pair.state,localType:local.candidateType,remoteType:remote.candidateType,protocol:remote.protocol,
      offeredTypes:offered.map(c=>c.type),relayEndpointMatched:offered.some(c=>c.type==='relay'&&c.address===address&&c.port===remote.port),
      publicIpv4:/^\d+\.\d+\.\d+\.\d+$/.test(address)&&!(/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)),
      bytesReceived:pair.bytesReceived,responsesReceived:pair.responsesReceived,currentRoundTripTime:pair.currentRoundTripTime};
  });
  assert.equal(route.state,'succeeded');assert(route.offeredTypes.length&&route.offeredTypes.every(t=>t==='relay'),'Offer contains missing/non-relay candidates');
  assert(['relay','prflx'].includes(route.remoteType)&&route.relayEndpointMatched&&route.publicIpv4,'Selected endpoint is not an offered public relay');
  assert(route.bytesReceived>1000,'Relay carried no received media');return route;
}
(async()=>{console.log('Reports: '+report);try{
  const source=launch(opts.fixture,['Public WHIP fixture '+crypto.randomUUID(),'premultiplied','flipped'],'source');
  const tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');
  await waitFor(()=>{assert(!source.launchError&&source.exitCode===null);return source.output().includes('"uuid"');},10000,'Source not ready');
  const sourceId=JSON.parse(source.output().trim().split('\n')[0]).uuid;
  await waitFor(()=>{assert(!tone.launchError&&tone.exitCode===null);return tone.output().includes('READY '+opts['microphone-device']);},10000,'Tone not ready');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});result.browserVersion=browser.version();
  for(const encoder of encoders){
    const entry={encoder,passed:false,signaling:[]};result.cases.push(entry);
    const token='gcqa'+crypto.randomBytes(20).toString('hex'),discovery=path.join(report,encoder+'-control.json');
    let publisher,control;const page=await browser.newPage();
    try{
      await installReceiverProbe(page);
      page.on('websocket',socket=>{
        if(new URL(socket.url()).hostname!=='whip.vdo.ninja')return;
        socket.on('framesent',frame=>{try{const m=JSON.parse(String(frame.payload));if(m.join===token)entry.viewerRegistered=true;
          if(m.callback)entry.signaling.push({direction:'sent',callback:true,time:Date.now()});}catch{}});
        socket.on('framereceived',frame=>{try{const m=JSON.parse(String(frame.payload));
          entry.signaling.push({direction:'received',type:m.type,ownedStream:m.streamID===token,time:Date.now()});}catch{}});
      });
      const response=await page.goto('https://vdo.ninja/?whip='+token+'&autostart&cleanoutput&stereo=1',{waitUntil:'domcontentloaded',timeout:45000});
      entry.viewerSecurity=await response.securityDetails();
      await waitFor(()=>entry.viewerRegistered,20000,'Viewer did not register its owned WHIP stream');await sleep(500);
      publisher=launch(exe,['--headless','--source=syphon','--syphon-server='+sourceId,'--syphon-alpha=premultiplied','--alpha-background=opaque',
        '--output=whip','--output-url=https://whip.vdo.ninja','--output-token='+token,'--audio-source=none','--include-microphone',
        ...(relayOnly?['--ice-mode=relay']:[]),
        '--microphone-device='+opts['microphone-device'],'--audio-codec=opus','--audio-channels=2','--audio-bitrate-kbps=192','--no-audio-red',
        '--video-codec=h264','--video-encoder='+encoder,'--width=640','--height=360','--fps=30','--bitrate-kbps=1200',
        receiverReconnect?'--duration-ms=240000':'--duration-ms=120000','--local-control','--local-control-port=0','--local-control-discovery='+discovery],encoder);
      await waitFor(()=>{assert(!publisher.launchError&&publisher.exitCode===null);if(!fs.existsSync(discovery))return false;
        control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);return true;},15000,'Publisher not ready');
      entry.negotiation=[];
      await waitFor(async()=>{
        const d=await api(control,'/diagnostics'),status={state:d.output?.state,message:d.output?.message,icePath:d.output?.ice_path,reconnects:d.output?.reconnects};
        if(!entry.negotiation.length||JSON.stringify(entry.negotiation.at(-1).status)!==JSON.stringify(status))entry.negotiation.push({time:Date.now(),status});
        return page.evaluate(async()=>{for(const pc of window.reviewPCs)for(const s of (await pc.getStats()).values())
          if(s.type==='inbound-rtp'&&s.kind==='video'&&s.framesDecoded>15)return true;return false;});
      },40000,'No decoded WHIP video');
      entry.initial=await videoCheck(page);entry.audio=await observeAudio(page);audioCheck(entry.audio);
      if(relayOnly)entry.initialRelay=await relayRoute(page);
      tone.stdin.write('silence\n');await sleep(700);entry.silence=await observeAudio(page);audioCheck(entry.silence,true);
      tone.stdin.write('sound\n');await sleep(700);entry.restoredAudio=await observeAudio(page);audioCheck(entry.restoredAudio);
      source.stdin.write('pause\n');await sleep(700);entry.static=await observeDecoded(page,2500,null,'syphon');
      assert.equal(new Set(entry.static.observations.map(f=>f.id)).size,1);assert(entry.static.observations.length>50,'Static capture lost pacing');
      source.stdin.write('resume\n');await sleep(500);entry.resumed=await videoCheck(page);
      const diag=await api(control,'/diagnostics');assert.equal(diag.output.state,2);assert.equal(diag.video.hardware_encoder,encoder==='videotoolbox');
      assert.equal(diag.source.source_id,sourceId);assert(diag.audio.active_microphone_source.includes('BlackHole'));
      assert(!JSON.stringify(diag).includes(token),'WHIP token in diagnostics');entry.output=diag.output;
      if(relayOnly){assert.equal(diag.output.ice_path,'TURN/RELAY');entry.finalRelay=await relayRoute(page);}
      fs.writeFileSync(path.join(report,encoder+'-diagnostics.json'),JSON.stringify(diag,null,2));
      if(receiverReconnect){
        const started=Date.now(),priorReconnects=diag.output.reconnects;
        entry.recovery={priorReconnects,statusChanges:[]};entry.viewerRegistered=false;
        // Reload destroys this receiver's peer and signaling socket. Keep the
        // publisher and owned sources running; a fresh viewer registers before
        // the native output worker retries its WHIP offer.
        await page.reload({waitUntil:'domcontentloaded',timeout:45000});
        await waitFor(()=>entry.viewerRegistered,20000,'Reloaded viewer did not register');
        entry.recovery.viewerRegisteredMs=Date.now()-started;
        await waitFor(async()=>{
          assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited during receiver recovery');
          const d=await api(control,'/diagnostics');assert(d.app.live&&d.app.capturing,'Receiver reload stopped capture');
          const status={state:d.output.state,message:d.output.message,reconnects:d.output.reconnects};
          if(!entry.recovery.statusChanges.length||JSON.stringify(entry.recovery.statusChanges.at(-1).status)!==JSON.stringify(status))
            entry.recovery.statusChanges.push({elapsedMs:Date.now()-started,status});
          if(d.output.reconnects<=priorReconnects||d.output.state!==2)return false;
          return page.evaluate(async()=>{for(const pc of window.reviewPCs)for(const s of (await pc.getStats()).values())
            if(s.type==='inbound-rtp'&&s.kind==='video'&&s.framesDecoded>15)return true;return false;});
        },90000,'Publisher did not recover after receiver reload');
        entry.recovery.decodedReadyMs=Date.now()-started;
        entry.recovery.video=await videoCheck(page);entry.recovery.audio=await observeAudio(page);audioCheck(entry.recovery.audio);
        entry.recovery.relay=await relayRoute(page);
        const recovered=await api(control,'/diagnostics');assert.equal(recovered.output.ice_path,'TURN/RELAY');
        assert.equal(recovered.source.source_id,sourceId);assert.equal(recovered.video.hardware_encoder,encoder==='videotoolbox');
        assert(recovered.video.frames_captured>diag.video.frames_captured,'Capture did not advance through recovery');
        assert(!JSON.stringify(recovered).includes(token),'WHIP token in recovered diagnostics');entry.recovery.output=recovered.output;
        fs.writeFileSync(path.join(report,encoder+'-recovered-diagnostics.json'),JSON.stringify(recovered,null,2));
      }
      const signalingBeforeStop=entry.signaling.length;
      await api(control,'/commands',{command:'stop'});
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},15000,'Stop failed');
      const stopped=await api(control,'/diagnostics');await sleep(1000);const after=await api(control,'/diagnostics');
      assert.equal(after.video.frames_sent,stopped.video.frames_sent);assert.equal(after.macos_media_activity_active,false);
      entry.stopped=true;entry.deleteObserved=entry.signaling.slice(signalingBeforeStop).some(m=>m.direction==='received'&&m.type==='delete'&&m.ownedStream);
      assert(entry.deleteObserved,'Viewer did not receive owned WHIP DELETE');
      await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,15000,'Quit failed');
      entry.publisherExit=await publisher.closed;assert.equal(entry.publisherExit.code,0);assert(!fs.existsSync(discovery));
      assert(!publisher.output().includes(token),'WHIP token in publisher output');entry.passed=true;
    }catch(error){entry.error=String(error.stack||error);}
    finally{
      if(publisher&&publisher.exitCode===null&&control)await api(control,'/commands',{command:'quit'}).catch(()=>{});
      if(publisher){await Promise.race([publisher.closed,sleep(15000)]);if(publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGTERM');entry.forcedCleanup=true;entry.passed=false;}
        entry.publisherExit=await publisher.closed;if(entry.publisherExit.code!==0||fs.existsSync(discovery))entry.passed=false;}
      await page.close();source.stdin.write('resume\n');tone.stdin.write('sound\n');save();console.log(encoder+': '+(entry.passed?'passed':'failed'));
    }
  }
  for(const p of [source,tone]){p.stdin.write('quit\n');await Promise.race([p.closed,sleep(5000)]);assert.equal(p.exitCode,0,'Fixture did not quit normally');}
  result.passed=result.cases.length===encoders.length&&result.cases.every(c=>c.passed);assert(result.passed,'Public WHIP workflow failed');
}catch(error){result.error=String(error.stack||error);process.exitCode=1;}
finally{for(const p of children)p.kill('SIGTERM');if(browser)await browser.close().catch(()=>{});await Promise.all([...children].map(p=>p.closed));save();console.log(JSON.stringify({report,passed:result.passed}));}})();
