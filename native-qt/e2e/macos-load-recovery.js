'use strict';
// Real packaged publisher, existing authenticated VDO.Ninja controls and receiver.
// A requested 4K workload is not proof of encoder overload: retain measured
// capture/send/receive cadence separately and require recovery at the baseline.
const assert=require('node:assert/strict');
const {sleep,waitFor,observeDecoded,requireMoving}=require('./macos-media-receiver');
const audio=require('./macos-continuous-audio');

module.exports=async function loadRecovery({source,page,stream,remoteToken,diagnostics,result,save,encoded}) {
  result.scope='Three live 720p60 -> 4K60 -> 720p60 cycles with continuous stereo; same-host generated fixture, not isolated encoder efficiency or physical audio qualification';
  result.cycles=[];result.responses=[];result.failures=[];result.passed=false;
  const checkedDiagnostics=async()=>{
    const began=performance.now(),d=await diagnostics();
    const ms=performance.now()-began;result.responses.push(ms);
    assert(ms<2000,'Diagnostics unresponsive for two seconds under load');
    return d;
  };
  async function change(width,height) {
    const began=performance.now();
    for(const [keyname,value] of Object.entries({width,height})) {
      const sent=await page.evaluate(({keyname,value,stream,remoteToken})=>{
        const peers=window.session?.rpcs||{};
        const peer=Object.keys(peers).find(id=>peers[id]?.streamID===stream);
        return !!peer&&window.session.sendRequest({requestVideoHack:true,keyname,value,remote:remoteToken},peer)!==false;
      },{keyname,value,stream,remoteToken});
      assert(sent,'Existing video-setting control was not sent');
      await waitFor(async()=>(await checkedDiagnostics()).video['configured_'+keyname]===value,15000,'Video-setting control did not commit');
    }
    await waitFor(()=>page.evaluate(({width,height})=>[...document.querySelectorAll('video')].some(v=>!v.paused&&v.videoWidth===width&&v.videoHeight===height),{width,height}),15000,'Receiver dimensions did not change');
    return performance.now()-began;
  }
  async function observe(seconds,width,height,recovered) {
    await source.evaluate(()=>{fixture.trace=[];fixture.record=true;});
    const before=await checkedDiagnostics();
    const diagnosticsStarted=performance.now();
    let running=true,samplingError;
    const samples=[];
    const sampling=(async()=>{
      while(running) {samples.push(await checkedDiagnostics());await sleep(500);}
    })().catch(error=>{samplingError=error;});
    let video;
    try {video=await observeDecoded(page,seconds*1000,null,'camera',true);}
    finally {running=false;await sampling;}
    const after=await checkedDiagnostics();
    const diagnosticsEnded=performance.now();
    const sourceTrace=await source.evaluate(()=>{fixture.record=false;return fixture.trace;});
    const pcm=await audio.drain(page),audioCheck=audio.analyze(pcm,seconds-.35);
    const entry={video,before,after,samples,sourceTrace,pcm,audioCheck,recovered,diagnosticsStarted,diagnosticsEnded,passed:false};
    // Store evidence before any assertion can fail.
    result.cycles.at(-1)[recovered?'recovery':'stress']=entry;save();
    if(encoded)entry.encoded=await encoded('cycle-'+result.cycles.length+'-'+(recovered?'recovery':'stress'));
    if(samplingError)throw samplingError;
    const distinct=new Set(video.observations.map(frame=>frame.id)).size;
    const elapsed=(video.ended-video.started)/1000;
    entry.receivedFps=distinct/elapsed;
    entry.sourceFps=new Set(sourceTrace.filter(x=>x.time>=video.started&&x.time<=video.ended).map(x=>x.id)).size/elapsed;
    entry.senderFps=(after.video.frames_sent-before.video.frames_sent)/((diagnosticsEnded-diagnosticsStarted)/1000);
    entry.belowRequestedCadence=entry.receivedFps<57;
    try {
    requireMoving(video,recovered?'Recovered baseline':'4K workload');
    if(encoded) {
      assert.equal(entry.encoded.errors.length,0,'Encoded evidence probe failed');
      assert(entry.encoded.streams.some(s=>s.frames.length>0),'Encoded evidence is empty');
      assert(entry.encoded.streams.every(s=>!s.dropped&&!s.error),'Encoded evidence is incomplete');
    }
    assert.equal(video.width,width);assert.equal(video.height,height);
    assert.equal(after.video.encode_hard_failures,before.video.encode_hard_failures,'Hard encoder failure');
    assert(audioCheck.passed,'Continuous audio changed during video reconfiguration/load');
    assert(after.app.live&&after.app.capturing,'Publisher stopped during settings changes');
    if(recovered) {
      assert(entry.sourceFps>=57,'Source did not recover its 60 fps cadence');
      assert(entry.receivedFps>=57,'Received baseline did not recover 60 fps cadence');
      assert.equal(after.video.encode_failures,before.video.encode_failures,'Encoder failures after recovery');
      assert.equal(after.video.encode_timeouts,before.video.encode_timeouts,'Encoder timeouts after recovery');
    }
    entry.passed=true;
    } catch(error) {
      entry.error=String(error);
      result.failures.push({cycle:result.cycles.length,phase:recovered?'recovery':'stress',error:String(error)});
    }
    save();
  }
  result.audioObserver=await audio.start(page);
  try {
    if(encoded)result.initialEncoded=await encoded('initial');
    for(let cycle=0;cycle<3;cycle++) {
      const entry={cycle:cycle+1};result.cycles.push(entry);save();
      entry.upsizeMs=await change(3840,2160);
      await observe(15,3840,2160,false);
      entry.downsizeMs=await change(1280,720);
      await observe(10,1280,720,true);
    }
    assert.equal(result.failures.length,0,'Load/recovery phase failures: '+JSON.stringify(result.failures));
    result.passed=true;
  } finally {await audio.stop(page);save();}
};
