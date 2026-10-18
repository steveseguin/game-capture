'use strict';
// Real packaged sender and browser viewers. Closing a viewer uses normal page
// lifecycle; no synthetic signaling messages or private VDO.Ninja API calls.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{chromium}=require('playwright');
const {receiverAt,observe,requireMoving,observeAudio,sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
for(const key of ['app','reports','encoder','source-ui-helper','expected-executable-sha256'])assert(opts[key],key);
const diagnosticSchema=opts['diagnostic-schema']||'classified';assert(['classified','legacy'].includes(diagnosticSchema));
const leaveMode=opts['leave-mode']||'page-close';assert(['page-close','hangup'].includes(leaveMode));
const closeObservationMs=Number(opts['close-observation-ms']||15000);assert(Number.isInteger(closeObservationMs)&&closeObservationMs>=15000&&closeObservationMs<=120000);
const cycles=Number(opts.cycles||3);assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=10);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const result={scope:'Packaged Mac viewer close/rejoin with surviving-viewer video and stereo audio; same-host browser, no performance qualification',
  encoder:opts.encoder,leaveMode,diagnosticSchema,expectedExecutableSha256:opts['expected-executable-sha256'],cycles:[],trackCloseObservations:[],counterGateFailures:[],harnesses:{},passed:false};
for(const name of ['macos-viewer-disconnect.js','macos-independent-sender.js','macos-media-receiver.js']){
  const file=path.join(__dirname,name);result.harnesses[name]=sha(fs.readFileSync(file));fs.copyFileSync(file,path.join(report,name));
}
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
let sender,browser,senderReport,control,stream,log;
const clean=v=>String(v).replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi,'<url>').replaceAll(stream||'gcwan-unused','<owned-session>');
async function diagnostics(){
  const response=await fetch(control.base_url+'/diagnostics',{headers:{Authorization:'Bearer '+control.token},signal:AbortSignal.timeout(5000)});
  assert(response.ok);return response.json();
}
const snapshot=d=>({time:Date.now(),peers:d.metrics.peer_count,activeVideoPeers:d.metrics.active_video_peers,
  framesSent:d.video.frames_sent,encodeFailures:d.video.encode_failures,encodeTimeouts:d.video.encode_timeouts,
  sendFailures:d.video.send_failures,reasons:d.video.peer_send_failure_reasons,audioSendFailures:d.audio.send_failures,
  peerStates:d.peers.map(p=>({state:p.last_connection_state,videoActive:p.media.last_observed_video_track_active,
    audioActive:p.media.last_observed_audio_track_active,dataOpen:p.transport.data_channel_open,
    retired:p.transport.transport_retired,disconnected:p.transport.disconnected_since_steady_ms>0}))});
function checkCounterGates(snapshot,label){
  if(diagnosticSchema!=='classified')return;
  for(const key of ['empty_packet','packetizer_unavailable','pacer_failed','send_failed']){
    if(snapshot.reasons[key]!==0)result.counterGateFailures.push({label,reason:key,count:snapshot.reasons[key]});
  }
  const classified=Object.values(snapshot.reasons).reduce((a,b)=>a+b,0);
  if(classified!==snapshot.sendFailures)result.counterGateFailures.push({label,reason:'aggregate_mismatch',classified,total:snapshot.sendFailures});
  save();
}
async function awaitClosedTracks(label){
  const started=Date.now(),entry={label,boundMs:15000,observationLimitMs:closeObservationMs,samples:[]};result.trackCloseObservations.push(entry);
  while(true){
    const d=snapshot(await diagnostics()),elapsed=Date.now()-started;entry.samples.push({elapsed,...d});save();
    if(d.activeVideoPeers===0){entry.elapsedMs=elapsed;entry.within15Seconds=elapsed<=15000;save();return;}
    if(elapsed>=closeObservationMs)throw Error(label+': video track remained active at observation limit');
    await sleep(1000);
  }
}
async function openViewer(){
  return receiverAt(browser,`https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput&stereo=1&ab=510&audiocodec=red&hangupbutton`,null);
}
async function leave(page){
  if(leaveMode==='hangup'){
    await page.locator('#hangupbutton').click({timeout:10000});
    // The existing UI schedules session.hangup asynchronously; let its BYE
    // and normal teardown finish before destroying the tab.
    await sleep(1800);
  }
  await page.close();
}
async function picture(page,label){
  const r=await observe(page,2500),distinct=requireMoving(r,label);
  assert.equal(r.width,1920);assert.equal(r.height,1080);
  return {label,distinct,started:r.started,ended:r.ended,width:r.width,height:r.height,
    identityReadFailures:r.identityReadFailures,observations:r.observations,
    codecs:r.tracks.map(t=>t.codec)};
}
(async()=>{console.log('Reports: '+report);save();try{
  const args=[path.join(__dirname,'macos-independent-sender.js'),'--receiver-location=same-host',...['app','encoder','source-ui-helper','expected-executable-sha256'].map(k=>'--'+k+'='+opts[k]),'--reports='+path.join(report,'sender')];
  log=fs.createWriteStream(path.join(report,'sender-console.log'));
  sender=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe']});sender.closed=new Promise(resolve=>sender.once('close',resolve));
  sender.stdout.pipe(log,{end:false});sender.stderr.pipe(log,{end:false});
  sender.once('error',error=>{result.launchError=clean(error);});
  await waitFor(()=>{
    assert(!result.launchError,result.launchError);assert.equal(sender.exitCode,null,'Sender ended before discovery');
    const base=path.join(report,'sender');if(!fs.existsSync(base))return false;
    for(const name of fs.readdirSync(base)){
      const dir=path.join(base,name),request=path.join(dir,'private-receiver-request.json');
      if(fs.existsSync(request)){senderReport=dir;stream=JSON.parse(fs.readFileSync(request)).inputs.stream;
        control=JSON.parse(fs.readFileSync(path.join(dir,'private-control.json')));return true;}
    }return false;
  },60000,'Sender did not become ready');
  result.senderReport=path.relative(report,senderReport);result.sessionBindingSha256=sha(stream);
  result.initial=snapshot(await diagnostics());
  if(diagnosticSchema==='classified')assert(result.initial.reasons,'Candidate lacks classified send diagnostics');
  else assert.equal(result.initial.reasons,undefined,'Legacy comparison must use the legacy schema');save();
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();
  for(let index=0;index<cycles;index++){
    const entry={index,passed:false};result.cycles.push(entry);save();
    const survivor=await openViewer(),leaver=await openViewer();
    await waitFor(async()=>{const d=await diagnostics();return d.metrics.active_video_peers===2;},15000,'Both viewer tracks did not open');
    entry.beforeClose=snapshot(await diagnostics());entry.leavingPicture=await picture(leaver,'Leaving viewer '+index);save();
    entry.beforeHangup=snapshot(await diagnostics());
    // No viewer is leaving during this interval. Even a known closure reason
    // here is a failure; the lifecycle classification is not a blanket waiver.
    if(entry.beforeHangup.sendFailures!==entry.beforeClose.sendFailures){
      result.counterGateFailures.push({label:'cycle-'+index,reason:'send_failure_without_viewer_close',
        before:entry.beforeClose.sendFailures,after:entry.beforeHangup.sendFailures});save();
    }
    await leave(leaver);
    entry.survivingPicture=await picture(survivor,'Surviving viewer '+index);
    const audio=await observeAudio(survivor);entry.survivingAudioSpectra=audio.spectra;
    entry.goodStereoWindows=audio.spectra.filter(s=>s.rms>.001&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length;
    assert(entry.goodStereoWindows>=25,'Surviving viewer stereo audio failed');
    await waitFor(async()=>{const d=await diagnostics();return d.metrics.active_video_peers===1;},15000,'Closed viewer track remained active');
    entry.withSurvivor=snapshot(await diagnostics());save();
    await leave(survivor);
    await awaitClosedTracks('Last viewer in cycle '+index);
    await sleep(500);entry.afterTracksClosed=snapshot(await diagnostics());
    assert.equal(entry.afterTracksClosed.encodeFailures,0);assert.equal(entry.afterTracksClosed.encodeTimeouts,0);
    checkCounterGates(entry.afterTracksClosed,'cycle-'+index);
    entry.mediaAndTrackClosurePassed=true;entry.passed=!result.counterGateFailures.some(f=>f.label==='cycle-'+index);save();
  }
  // The final fresh viewer proves reception still starts after the last close.
  const fresh=await openViewer();result.finalRejoinPicture=await picture(fresh,'Final fresh viewer');await leave(fresh);
  const lastClose=Date.now();
  await awaitClosedTracks('Final fresh viewer');
  result.afterFinalTrackClosed=snapshot(await diagnostics());save();
  // Direct sessions have an existing 90-second ICE recovery retention period.
  // Require actual removal after that period, without changing app policy.
  await waitFor(async()=>{const d=await diagnostics();return d.metrics.peer_count===0;},105000,'Retained direct sessions were not pruned');
  result.lastCloseToSessionRemovalMs=Date.now()-lastClose;
  await sleep(500);result.final=snapshot(await diagnostics());save();
  assert.equal(result.final.encodeFailures,0);assert.equal(result.final.encodeTimeouts,0);
  checkCounterGates(result.final,'final');
  sender.stdin.end('finish\n');await waitFor(()=>sender.exitCode!==null,15000,'Sender cleanup did not finish');await sender.closed;
  const local=JSON.parse(fs.readFileSync(path.join(senderReport,'results.json')));assert.equal(sender.exitCode,0);assert(local.passed);
  assert.equal(local.executableSha256,result.expectedExecutableSha256);assert.equal(local.sessionBindingSha256,result.sessionBindingSha256);
  result.publisherExitCode=local.exitCode;result.publisherDiscoveryRemoved=!fs.existsSync(path.join(senderReport,'private-control.json'));
  assert(result.publisherDiscoveryRemoved);result.observedUnavailableSends=diagnosticSchema==='classified'?result.final.reasons.track_unavailable+result.final.reasons.transport_unavailable:null;
  result.observedTrackClosedDuringSend=diagnosticSchema==='classified'?(result.final.reasons.track_closed_during_send||0):null;
  result.completed=true;
  result.counterGatePassed=diagnosticSchema==='classified'?result.counterGateFailures.length===0:null;
  result.timingGatePassed=result.trackCloseObservations.every(o=>o.within15Seconds);
  result.passed=result.counterGatePassed!==false&&result.timingGatePassed;
  if(!result.passed){result.error='Media/cleanup workflows completed; retained counter or 15-second timing gate failures';process.exitCode=1;}
}catch(error){result.error=clean(error.stack||error);process.exitCode=1;}
finally{
  if(browser)await browser.close();
  if(sender&&sender.exitCode===null&&!result.launchError){if(!sender.stdin.writableEnded)sender.stdin.end('finish\n');try{await waitFor(()=>sender.exitCode!==null,15000,'Sender cleanup timeout');}catch{sender.kill('SIGTERM');}await sender.closed;}
  if(log)await new Promise(resolve=>log.end(resolve));save();console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
}})();
