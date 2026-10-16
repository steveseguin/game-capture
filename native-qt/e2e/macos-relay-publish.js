#!/usr/bin/env node
'use strict';
// Packaged publisher -> public TURN -> real browser. Controlled media only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const {receive}=require('./audio-settings-packaged-e2e');
const {sleep,waitFor,installReceiverProbe,observeDecoded,requireMoving}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');assert(i>2);return [arg.slice(2,i),arg.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','fixture','tone-helper','microphone-device','reports'])assert(opts[key],'Required --'+key);
const encoders=(opts.encoders||'videotoolbox,x264').split(',');assert(encoders.every(e=>['videotoolbox','x264'].includes(e)));
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture');assert(fs.existsSync(path.join(app,'Contents/Frameworks')));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result={scope:'Packaged Mac relay-only publishing through the normally discovered public TURN service, real initial/late browser receivers, controlled Syphon video and virtual stereo input. No host network changes.',
  executableSha256:hash(exe),harnessSha256:hash(__filename),receiverSha256:hash(path.join(__dirname,'audio-settings-packaged-e2e.js')),
  fixtureSha256:hash(path.resolve(opts.fixture)),toneSha256:hash(path.resolve(opts['tone-helper'])),cases:[],passed:false};
for(const name of ['macos-relay-publish.js','audio-settings-packaged-e2e.js','macos-media-receiver.js','macos-syphon-fixture.mm','macos-audio-tone.mm'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let browser;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
  const child=spawn(path.resolve(program),args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);
  let output='';child.output=()=>output;child.stdout.on('data',data=>output+=data);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>{child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});});child.once('error',error=>child.launchError=String(error));});return child;
}
async function api(control,route,body){
  const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Control HTTP '+r.status);return r.json();
}
async function selectedPair(page){
  const evidence=await page.evaluate(async()=>{
    const pc=window.audioReviewPc,stats=await pc.getStats();
    const transport=[...stats.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId);
    const pair=stats.get(transport?.selectedCandidatePairId);
    if(!pair)throw Error('No selected ICE candidate pair');
    const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);
    const offered=(pc.remoteDescription.sdp.match(/^a=candidate:.*$/gm)||[]).map(line=>{
      const parts=line.trim().split(/\s+/);return {address:parts[4],port:Number(parts[5]),type:parts[7]};
    });
    const relayEndpointMatched=offered.some(c=>c.type==='relay'&&c.address===remote.address&&c.port===remote.port);
    const a=remote.address||'';
    const publicIpv4=/^\d+\.\d+\.\d+\.\d+$/.test(a)&&!(/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    return {connection:pc.connectionState,state:pair.state,localType:local.candidateType,remoteType:remote.candidateType,
      protocol:remote.protocol,relayProtocol:remote.relayProtocol,offeredTypes:offered.map(c=>c.type),relayEndpointMatched,publicIpv4,
      bytesReceived:pair.bytesReceived,currentRoundTripTime:pair.currentRoundTripTime,
      responsesReceived:pair.responsesReceived,selectedPairId:pair.id};
  });
  assert.equal(evidence.connection,'connected');assert.equal(evidence.state,'succeeded');
  assert(evidence.offeredTypes.length>0&&evidence.offeredTypes.every(type=>type==='relay'),'Publisher advertised a non-relay candidate');
  assert(['relay','prflx'].includes(evidence.remoteType)&&evidence.relayEndpointMatched,'Selected remote endpoint is not a publisher relay candidate');
  assert(evidence.publicIpv4,'This public-TURN workflow did not select a public IPv4 relay');
  assert(evidence.bytesReceived>1000,'Selected relay carried no received media');return evidence;
}
async function cadence(page,milliseconds){
  const video=await observeDecoded(page,milliseconds,null,'syphon'),distinctFrames=requireMoving(video,'Relayed video');
  const decodedFps=distinctFrames/((video.ended-video.started)/1000);
  assert.equal(video.width,640);assert.equal(video.height,360);assert(decodedFps>=28.5,'Relay delivery missed 95% of 30 fps');
  return {video,distinctFrames,decodedFps,pair:await selectedPair(page)};
}
(async()=>{console.log('Reports: '+report);try{
  const source=launch(opts.fixture,['Relay fixture '+crypto.randomUUID(),'premultiplied','flipped'],'source');
  const tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');
  await waitFor(()=>{assert(!source.launchError&&source.exitCode===null);return source.output().includes('"uuid"');},10000,'Source not ready');
  const sourceId=JSON.parse(source.output().trim().split('\n')[0]).uuid;
  await waitFor(()=>{assert(!tone.launchError&&tone.exitCode===null);return tone.output().includes('READY '+opts['microphone-device']);},10000,'Tone not ready');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});result.browserVersion=browser.version();
  for(const encoder of encoders){
    const entry={encoder,passed:false};result.cases.push(entry);const dir=path.join(report,encoder);fs.mkdirSync(dir);
    const discovery=path.join(dir,'control.json'),token=crypto.randomBytes(24).toString('hex');
    const c={stream:'macrelay'+crypto.randomBytes(12).toString('hex'),codec:'opus',red:false,bitrate:192,channels:2};
    let publisher,control;
    try{
      publisher=launch(exe,['--headless','--source=syphon','--syphon-server='+sourceId,'--syphon-alpha=premultiplied','--alpha-background=opaque','--alpha-background-color=#224488',
        '--stream='+c.stream,'--password=false','--ice-mode=relay','--audio-source=none','--include-microphone','--microphone-device='+opts['microphone-device'],
        '--audio-codec=opus','--audio-channels=2','--audio-bitrate-kbps=192','--no-audio-red','--video-codec=h264','--video-encoder='+encoder,
        '--width=640','--height=360','--fps=30','--bitrate-kbps=1200','--max-viewers=4','--remote-control','--remote-token='+token,
        '--duration-ms=240000','--local-control','--local-control-port=0','--local-control-discovery='+discovery],encoder+'-publisher');
      await waitFor(async()=>{
        for(const child of [publisher,source,tone])assert(!child.launchError&&child.exitCode===null&&!child.signalCode,'Owned process exited');
        if(!fs.existsSync(discovery))return false;control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
        return (await api(control,'/diagnostics')).app.live;
      },20000,'Publisher not live');
      await waitFor(()=>{c.viewerUrl=publisher.output().match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1];return !!c.viewerUrl;},10000,'No viewer URL');
      async function routing(expected,maximum=expected){
        const d=await api(control,'/diagnostics');assert.equal(d.signaling.ice_mode,'relay');
        assert.equal(d.video.hardware_encoder,encoder==='videotoolbox');
        const peers=d.peers.filter(p=>p.media.last_observed_video_track_active);
        assert(peers.length>=expected&&peers.length<=maximum,'Unexpected active relay peer count');
        assert(peers.every(p=>p.transport.selected_ice_path==='TURN/RELAY'),'Native media bypassed TURN');return d;
      }
      entry.receiver=await receive(browser,c,dir,discovery,token,undefined,{preparePage:installReceiverProbe,observePlayback:async({page,measure})=>{
        entry.initialRouting=await routing(1);entry.initialCadence=await cadence(page,20000);
        const lateDir=path.join(dir,'late');fs.mkdirSync(lateDir);
        entry.lateReceiver=await receive(browser,c,lateDir,discovery,undefined,undefined,{preparePage:installReceiverProbe,observePlayback:async({page:late})=>{
          entry.simultaneousRouting=await routing(2);
          const [first,second]=await Promise.all([cadence(page,10000),cadence(late,10000)]);entry.simultaneous={first,second};
          await measure('initial-with-late-relay-viewer',192);
        }});assert(entry.lateReceiver.ok,'Late relayed receiver failed');
        // A closed browser can remain in the shared ICE recovery grace period.
        // Stop below must remove every peer, including that retained session.
        await measure('initial-after-late-relay-close',192);entry.finalRouting=await routing(1,2);
        await api(control,'/commands',{command:'stop'});
        await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},5000,'Stop failed');
        const before=await api(control,'/diagnostics');await sleep(1000);entry.stoppedDiagnostics=await api(control,'/diagnostics');
        assert.equal(entry.stoppedDiagnostics.peers.length,0);assert.equal(entry.stoppedDiagnostics.macos_media_activity_active,false);
        assert.equal(entry.stoppedDiagnostics.video.frames_sent,before.video.frames_sent);assert.equal(entry.stoppedDiagnostics.metrics.audio_packets_sent,before.metrics.audio_packets_sent);
        await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,5000,'Quit failed');
        entry.publisherExit=await publisher.closed;assert.equal(entry.publisherExit.code,0);assert(!fs.existsSync(discovery));
      }});assert(entry.receiver.ok,'Initial relayed receiver failed');entry.passed=true;
    }catch(error){entry.error=String(error.stack||error);}
    finally{
      if(publisher&&publisher.exitCode===null&&control)await api(control,'/commands',{command:'quit'}).catch(()=>{});
      if(publisher){await Promise.race([publisher.closed,sleep(5000)]);if(publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGTERM');entry.passed=false;entry.forcedCleanup=true;}entry.publisherExit=await publisher.closed;if(entry.publisherExit.code!==0||fs.existsSync(discovery))entry.passed=false;assert(!publisher.output().includes(token),'Remote token in log');}
      save();console.log(encoder+': '+(entry.passed?'passed':'failed'));
    }
  }
  result.passed=result.cases.length===encoders.length&&result.cases.every(c=>c.passed);assert(result.passed,'Relay workflow failure');
}catch(error){result.error=String(error.stack||error);process.exitCode=1;}
finally{
  if(browser)await browser.close().catch(()=>{});
  for(const child of children)child.stdin.write('quit\n');
  await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
  save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
