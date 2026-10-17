'use strict';
// A hosted browser receives only the explicitly supplied owned synthetic stream.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os'),assert=require('assert/strict');
const {chromium}=require('playwright');
const {receiver,observe,requireMoving,observeAudio}=require('./macos-media-receiver');
const audio=require('./macos-continuous-audio');
const inputs=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)).inputs;
assert(/^gcwan[0-9a-f]{32}$/.test(inputs.stream));assert(['videotoolbox','x264'].includes(inputs.encoder));
console.log('::add-mask::'+inputs.stream);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const report=path.resolve('qa/reports/independent-receiver/export');fs.mkdirSync(report,{recursive:true});
const clean=value=>String(value).replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi,'<url>').replaceAll(inputs.stream,'<owned-session>');
const result={scope:'Independent hosted Linux browser receiving synthetic picture/stereo audio from the packaged Mac candidate; excludes physical playback, A/V synchronization and controlled performance comparison',
  runId:process.env.GITHUB_RUN_ID,sourceRevision:process.env.GITHUB_SHA,encoder:inputs.encoder,
  sessionBindingSha256:sha(inputs.stream),expectedPublisherExecutableSha256:'dc4311c7c648fdf8d5cf3a196e8bfd1ee9160e96c34420132ff83a3f39b36dc4',
  host:{platform:os.platform(),release:os.release(),arch:os.arch(),logicalCpus:os.cpus().length},intervals:[],passed:false,harnesses:{}};
for(const name of ['macos-independent-receiver.js','macos-media-receiver.js','macos-continuous-audio.js']){
  const file=path.join(__dirname,name);result.harnesses[name]=sha(fs.readFileSync(file));fs.copyFileSync(file,path.join(report,name));
}
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
const picture=r=>({started:r.started,ended:r.ended,width:r.width,height:r.height,observations:r.observations,
  identityReadFailures:r.identityReadFailures,rowDisagreements:r.rowDisagreements,observerError:r.observerError,
  tracks:r.tracks.map(t=>Object.fromEntries(['codec','framesDecoded','framesReceived','framesDropped','packetsReceived','packetsLost','bytesReceived','frameWidth','frameHeight','framesPerSecond','freezeCount','totalFreezesDuration'].filter(k=>k in t).map(k=>[k,t[k]])))});
let browser,page;
(async()=>{save();try{
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GITHUB_|ACTIONS_|GH_)/.test(k)));
  browser=await chromium.launch({headless:true,env,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();page=await receiver(browser,inputs.stream,null);
  result.audioObserver=await audio.start(page);save();
  for(let index=0;index<6;index++){
    const observed=await observe(page,10000),batch=await audio.drain(page);
    const entry={index,video:picture(observed),audio:{...batch,rows:batch.rows.map(({pcm,...row})=>row)},passed:false};result.intervals.push(entry);save();
    entry.distinctFrames=requireMoving(observed,'Independent interval '+index);
    assert.equal(observed.width,1920);assert.equal(observed.height,1080);
    entry.receivedDistinctFps=entry.distinctFrames/((observed.ended-observed.started)/1000);
    entry.audioCheck=audio.requireContinuous(batch,9.5);entry.passed=true;save();
  }
  await audio.stop(page);
  result.transport=await page.evaluate(async()=>{
    const output=[];for(const pc of window.reviewPCs.filter(pc=>pc.connectionState==='connected')){
      const stats=await pc.getStats();for(const t of stats.values())if(t.type==='transport'&&t.selectedCandidatePairId){
        const pair=stats.get(t.selectedCandidatePairId),local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);
        output.push({state:pair.state,currentRoundTripTime:pair.currentRoundTripTime,
          localType:local?.candidateType,remoteType:remote?.candidateType,protocol:local?.protocol,relayProtocol:local?.relayProtocol});
      }
    }return output;
  });
  const late=await receiver(browser,inputs.stream,null),observed=await observe(late,4000);
  result.lateVideo=picture(observed);result.lateDistinctFrames=requireMoving(observed,'Independent late receiver');
  const receivedAudio=await observeAudio(late);result.lateAudioSpectra=receivedAudio.spectra;
  const good=receivedAudio.spectra.filter(s=>s.rms>.001&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20);
  assert(good.length>=25,'Late receiver stereo tones were not isolated');result.passed=true;
}catch(error){result.error=clean(error.stack||error);process.exitCode=1;}
finally{
  try{if(page)await audio.stop(page);}catch{}
  if(browser)await browser.close();save();console.log(JSON.stringify({passed:result.passed,report,error:result.error}));
}})();
