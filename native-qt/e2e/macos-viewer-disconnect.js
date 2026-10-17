'use strict';
// Real packaged sender and browser viewers. Closing a viewer uses normal page
// lifecycle; no synthetic signaling messages or private VDO.Ninja API calls.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{chromium}=require('playwright');
const {receiver,observe,requireMoving,observeAudio,sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
for(const key of ['app','reports','encoder','source-ui-helper','expected-executable-sha256'])assert(opts[key],key);
const cycles=Number(opts.cycles||3);assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=10);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const result={scope:'Packaged Mac viewer close/rejoin with surviving-viewer video and stereo audio; same-host browser, no performance qualification',
  encoder:opts.encoder,expectedExecutableSha256:opts['expected-executable-sha256'],cycles:[],harnesses:{},passed:false};
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
  sendFailures:d.video.send_failures,reasons:d.video.peer_send_failure_reasons,audioSendFailures:d.audio.send_failures});
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
  result.initial=snapshot(await diagnostics());assert(result.initial.reasons,'Candidate lacks classified send diagnostics');save();
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();
  for(let index=0;index<cycles;index++){
    const entry={index,passed:false};result.cycles.push(entry);save();
    const survivor=await receiver(browser,stream,null),leaver=await receiver(browser,stream,null);
    await waitFor(async()=>{const d=await diagnostics();return d.metrics.active_video_peers===2;},15000,'Both viewer tracks did not open');
    entry.beforeClose=snapshot(await diagnostics());entry.leavingPicture=await picture(leaver,'Leaving viewer '+index);save();
    await leaver.close();
    entry.survivingPicture=await picture(survivor,'Surviving viewer '+index);
    const audio=await observeAudio(survivor);entry.survivingAudioSpectra=audio.spectra;
    entry.goodStereoWindows=audio.spectra.filter(s=>s.rms>.001&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length;
    assert(entry.goodStereoWindows>=25,'Surviving viewer stereo audio failed');
    await waitFor(async()=>{const d=await diagnostics();return d.metrics.active_video_peers===1;},15000,'Closed viewer track remained active');
    entry.withSurvivor=snapshot(await diagnostics());save();
    await survivor.close();
    await waitFor(async()=>{const d=await diagnostics();return d.metrics.active_video_peers===0;},15000,'Last closed viewer track remained active');
    await sleep(500);entry.afterTracksClosed=snapshot(await diagnostics());
    assert.equal(entry.afterTracksClosed.encodeFailures,0);assert.equal(entry.afterTracksClosed.encodeTimeouts,0);
    const reasons=entry.afterTracksClosed.reasons;
    for(const key of ['empty_packet','packetizer_unavailable','pacer_failed','send_failed'])assert.equal(reasons[key],0,'Unexpected '+key);
    assert.equal(Object.values(reasons).reduce((a,b)=>a+b,0),entry.afterTracksClosed.sendFailures,'Aggregate failure count differs from reason totals');
    entry.passed=true;save();
  }
  // The final fresh viewer proves reception still starts after the last close.
  const fresh=await receiver(browser,stream,null);result.finalRejoinPicture=await picture(fresh,'Final fresh viewer');await fresh.close();
  const lastClose=Date.now();
  await waitFor(async()=>{const d=await diagnostics();return d.metrics.active_video_peers===0;},15000,'Final viewer track remained active');
  result.afterFinalTrackClosed=snapshot(await diagnostics());save();
  // Direct sessions have an existing 90-second ICE recovery retention period.
  // Require actual removal after that period, without changing app policy.
  await waitFor(async()=>{const d=await diagnostics();return d.metrics.peer_count===0;},105000,'Retained direct sessions were not pruned');
  result.lastCloseToSessionRemovalMs=Date.now()-lastClose;
  await sleep(500);result.final=snapshot(await diagnostics());save();
  assert.equal(result.final.encodeFailures,0);assert.equal(result.final.encodeTimeouts,0);
  for(const key of ['empty_packet','packetizer_unavailable','pacer_failed','send_failed'])assert.equal(result.final.reasons[key],0,'Final unexpected '+key);
  assert.equal(Object.values(result.final.reasons).reduce((a,b)=>a+b,0),result.final.sendFailures);
  sender.stdin.end('finish\n');await waitFor(()=>sender.exitCode!==null,15000,'Sender cleanup did not finish');await sender.closed;
  const local=JSON.parse(fs.readFileSync(path.join(senderReport,'results.json')));assert.equal(sender.exitCode,0);assert(local.passed);
  assert.equal(local.executableSha256,result.expectedExecutableSha256);assert.equal(local.sessionBindingSha256,result.sessionBindingSha256);
  result.publisherExitCode=local.exitCode;result.publisherDiscoveryRemoved=!fs.existsSync(path.join(senderReport,'private-control.json'));
  assert(result.publisherDiscoveryRemoved);result.observedUnavailableSends=result.final.reasons.track_unavailable+result.final.reasons.transport_unavailable;
  result.passed=true;
}catch(error){result.error=clean(error.stack||error);process.exitCode=1;}
finally{
  if(browser)await browser.close();
  if(sender&&sender.exitCode===null&&!result.launchError){if(!sender.stdin.writableEnded)sender.stdin.end('finish\n');try{await waitFor(()=>sender.exitCode!==null,15000,'Sender cleanup timeout');}catch{sender.kill('SIGTERM');}await sender.closed;}
  if(log)await new Promise(resolve=>log.end(resolve));save();console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
}})();
