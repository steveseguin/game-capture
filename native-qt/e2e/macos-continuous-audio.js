'use strict';
// Continuous received PCM evidence. One bounded summary per 100 ms, with no
// timer-driven holes between observations. This is not a lip-sync measurement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function start(page, {shortWindowRmsFloor=null,badWindowPcmBudget=2} = {}) {
  assert(shortWindowRmsFloor===null || (Number.isFinite(shortWindowRmsFloor) && shortWindowRmsFloor>=0 && shortWindowRmsFloor<=1));
  assert(Number.isInteger(badWindowPcmBudget) && badWindowPcmBudget>=0 && badWindowPcmBudget<=16);
  const inspectShortWindows=shortWindowRmsFloor!==null;
  return page.evaluate(async ({inspectShortWindows,shortWindowRmsFloor,badWindowPcmBudget}) => {
    if (window.macContinuousAudio) throw Error('Continuous audio observer already installed');
    const track = window.reviewPCs.filter(p => p.connectionState === 'connected')
      .flatMap(p => p.getReceivers()).map(r => r.track).find(t => t?.kind === 'audio' && t.readyState === 'live');
    if (!track) throw Error('No live received audio track');
    const context = new AudioContext({sampleRate:48000});
    const code = `class Continuity extends AudioWorkletProcessor {
      constructor() {
        super(); this.n = Math.round(sampleRate / 10); this.pos = 0; this.active = false; this.budget = ${badWindowPcmBudget};
        this.inspectShortWindows = ${!!inspectShortWindows};
        this.shortFloor = ${shortWindowRmsFloor};
        this.shortN = Math.round(sampleRate / 100);
        this.pcm = new Float32Array(this.n*2);
        this.coefficients = [440,880,2000].map(hz => 2*Math.cos(2*Math.PI*hz/sampleRate));
        this.reset();
        this.port.onmessage = e => { if(e.data === 'budget') this.budget=${badWindowPcmBudget}; if(e.data === 'start') {
          this.active = true; this.pos = 0; this.reset(); this.port.postMessage({started:true});
        }};
      }
      reset() {
        this.energy = [0,0]; this.q1 = [[0,0,0],[0,0,0]]; this.q2 = [[0,0,0],[0,0,0]];
        this.clipped = 0; this.missing = 0; this.invalid = 0;
        if(this.inspectShortWindows) {this.shortEnergy=[0,0];this.shortRms=[];}
      }
      process(inputs, outputs) {
        if(!this.active) return true;
        const input = inputs[0], size = outputs[0][0].length;
        for(let i=0;i<size;i++) {
          if(this.pos === 0) this.firstFrame = currentFrame+i;
          if(input.length !== 2) this.missing++;
          for(let ch=0;ch<2;ch++) {
            let v = input[ch]?.[i] ?? 0;
            if(!Number.isFinite(v)) {this.invalid++;v=0;}
            this.pcm[this.pos*2+ch]=v;
            this.energy[ch] += v*v;
            if(this.inspectShortWindows) this.shortEnergy[ch] += v*v;
            if(Math.abs(v)>=.999) this.clipped++;
            for(let f=0;f<3;f++) {
              const q = v+this.coefficients[f]*this.q1[ch][f]-this.q2[ch][f];
              this.q2[ch][f]=this.q1[ch][f];this.q1[ch][f]=q;
            }
          }
          ++this.pos;
          if(this.inspectShortWindows && this.pos % this.shortN === 0) {
            this.shortRms.push(this.shortEnergy.map(v=>Math.sqrt(v/this.shortN)));
            this.shortEnergy=[0,0];
          }
          if(this.pos === this.n) {
            const amplitude=this.q1.map((ch,c)=>ch.map((q,f)=>2*Math.sqrt(Math.max(0,
              q*q+this.q2[c][f]**2-this.coefficients[f]*q*this.q2[c][f]))/this.n));
            const rms=this.energy.map(v=>Math.sqrt(v/this.n));
            const bad=rms.some(v=>v<.001)||amplitude.some((ch,i)=>ch[i]<.005||ch[i]<10*ch[1-i]||ch[2]>ch[i]/Math.pow(10,25/20))||this.clipped||this.missing||this.invalid;
            const row={frame:this.firstFrame,frames:this.n,rms,amplitude,
              clipped:this.clipped,missing:this.missing,invalid:this.invalid};
            if(this.inspectShortWindows) {row.shortWindowFrames=this.shortN;row.shortRms=this.shortRms;}
            const shortBad=this.inspectShortWindows && this.shortRms.some(ch=>ch.some(v=>v<this.shortFloor));
            if((bad||shortBad)&&this.budget>0) {row.pcm=Array.from(this.pcm);this.budget--;}
            this.port.postMessage(row);
            this.pos=0;this.reset();
          }
        }
        return true;
      }
    } registerProcessor('mac-continuity',Continuity);`;
    const url=URL.createObjectURL(new Blob([code],{type:'application/javascript'}));
    let input,node;
    try {
      await context.audioWorklet.addModule(url);
      input=context.createMediaStreamSource(new MediaStream([track]));
      node=new AudioWorkletNode(context,'mac-continuity',{outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'});
      input.connect(node);node.connect(context.destination); // Worklet output stays zero.
      let rows=[],error=null,ready;
      const started=new Promise(resolve=>{ready=resolve;});
      node.onprocessorerror=()=>{error='Audio worklet processor failed';};
      node.port.onmessage=e=>{
        if(e.data.started) {ready();return;}
        if(rows.length>=2000) {error='Continuous audio evidence queue overflow';return;}
        rows.push(e.data);
      };
      await context.resume();
      // Explicit startup settling only; no intervals are discarded after start.
      await new Promise(resolve=>setTimeout(resolve,500));
      node.port.postMessage('start');
      let timeout;
      try {await Promise.race([started,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Audio worklet did not start')),5000);})]);}
      finally {clearTimeout(timeout);}
      let lastWall=performance.timeOrigin+performance.now(),lastFrame=null;
      window.macContinuousAudio={
        drain() {
          const now=performance.timeOrigin+performance.now(),batch=rows;rows=[];
          node.port.postMessage('budget');
          const previousEndFrame=lastFrame;
          if(batch.length) lastFrame=batch.at(-1).frame+batch.at(-1).frames;
          const result={rows:batch,sampleRate:context.sampleRate,previousEndFrame,
            started:lastWall,ended:now,state:context.state,trackState:track.readyState,error,
            audioClock:context.getOutputTimestamp(),pageTimeOrigin:performance.timeOrigin};
          lastWall=now;return result;
        },
        async close() {input.disconnect();node.disconnect();node.port.close();await context.close();delete window.macContinuousAudio;}
      };
      return {sampleRate:context.sampleRate,windowFrames:4800,startupSettlingMs:500,
        ...(inspectShortWindows?{shortWindowFrames:480,shortWindowRmsFloor,badWindowPcmBudget,shortWindowScope:'10 ms RMS on every sample; not a proof against shorter glitches or concealed packet loss'}:{}),
        scope:'Continuous received-track Web Audio PCM, 100 ms summaries; not physical playback or A/V synchronization'};
    } catch(error) {
      input?.disconnect();node?.disconnect();node?.port.close();await context.close();throw error;
    } finally {URL.revokeObjectURL(url);}
  }, {inspectShortWindows,shortWindowRmsFloor,badWindowPcmBudget});
}

async function drain(page) {return page.evaluate(()=>window.macContinuousAudio.drain());}
async function stop(page) {return page.evaluate(()=>window.macContinuousAudio?.close());}

function analyze(batch, minimumSeconds = 0) {
  const rows=batch.rows,errors=[];
  let expected=batch.previousEndFrame,frames=0,gaps=0,silent=0,channelErrors=0,isolationErrors=0,clipped=0,missing=0,invalid=0;
  for(const row of rows) {
    if(expected!==null && row.frame!==expected) gaps++;
    expected=row.frame+row.frames;frames+=row.frames;
    silent+=row.rms.some(v=>v<.001)?1:0;
    channelErrors+=(row.amplitude[0][0]<.005||row.amplitude[1][1]<.005||
      row.amplitude[0][0]<10*row.amplitude[0][1]||row.amplitude[1][1]<10*row.amplitude[1][0])?1:0;
    isolationErrors+=row.amplitude.some((ch,i)=>ch[2]>ch[i]/Math.pow(10,25/20))?1:0;
    clipped+=row.clipped;missing+=row.missing;invalid+=row.invalid;
  }
  const seconds=frames/batch.sampleRate,wallSeconds=(batch.ended-batch.started)/1000;
  if(batch.error) errors.push(batch.error);
  if(batch.state!=='running'||batch.trackState!=='live') errors.push('Audio context or received track stopped');
  if(seconds<minimumSeconds||Math.abs(seconds-wallSeconds)>.35) errors.push('Incomplete continuous audio clock coverage');
  if(gaps||silent||channelErrors||isolationErrors||clipped||missing||invalid) errors.push('Received PCM content/continuity assertion failed');
  return {passed:errors.length===0,seconds,wallSeconds,windows:rows.length,gaps,silentWindows:silent,
    channelErrors,isolationErrors,clippedSamples:clipped,missingChannelFrames:missing,invalidSamples:invalid,errors};
}

function requireContinuous(batch, minimumSeconds) {
  const result=analyze(batch,minimumSeconds);
  assert(result.passed,JSON.stringify(result));return result;
}

// Independent received-track recording. Stream chunks to disk throughout the
// run instead of retaining a long recording in the browser's memory.
async function record(page, file, {includeVideo=false,sourceStreamKey=null} = {}) {
  const key='macAudioRecording'+crypto.randomBytes(8).toString('hex');
  const fd=fs.openSync(file,'wx');let closed=false;
  const metadata={path:path.basename(file),scope:includeVideo?
    'MediaRecorder A/V pair on one recording timeline; VP8/Opus re-encoding, not physical display/speaker timing':
    'Independent MediaRecorder of the received audio track; Opus re-encoding'};
  try {
    await page.exposeFunction(key,base64=>{fs.writeSync(fd,Buffer.from(base64,'base64'));});
    metadata.started=await page.evaluate(async ({key,includeVideo,sourceStreamKey})=>{
      const available=sourceStreamKey?window[sourceStreamKey]?.getTracks():
        window.reviewPCs.filter(p=>p.connectionState==='connected').flatMap(p=>p.getReceivers()).map(r=>r.track);
      const audio=available?.find(t=>t?.kind==='audio'&&t.readyState==='live');
      const video=available?.find(t=>t?.kind==='video'&&t.readyState==='live');
      if(!audio||(includeVideo&&!video))throw Error('Missing live track for independent recording');
      const recorder=new MediaRecorder(new MediaStream(includeVideo?[video,audio]:[audio]),{
        mimeType:includeVideo?'video/webm;codecs=vp8,opus':'audio/webm;codecs=opus',audioBitsPerSecond:128000,
        ...(includeVideo?{videoBitsPerSecond:1500000}: {})});
      let pending=Promise.resolve(),writeError=null;
      recorder.ondataavailable=e=>{if(e.data.size)pending=pending.then(async()=>{
        const bytes=new Uint8Array(await e.data.arrayBuffer());let binary='';
        for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
        await window[key](btoa(binary));
      }).catch(error=>{writeError=String(error);});};
      window[key+'Stop']=async()=>{
        let timer;
        try {await new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(Error('Audio recorder stop timed out')),5000);
          recorder.onstop=resolve;recorder.onerror=e=>reject(Error(e.error?.message||'Audio recorder failed'));recorder.stop();
        });await pending;if(writeError)throw Error(writeError);}
        finally {clearTimeout(timer);delete window[key+'Stop'];}
        return performance.timeOrigin+performance.now();
      };
      recorder.start(2000);return performance.timeOrigin+performance.now();
    },{key,includeVideo,sourceStreamKey});
  } catch(error) {fs.closeSync(fd);throw error;}
  return {metadata,async stop() {
    if(closed)return;
    try {metadata.ended=await page.evaluate(key=>window[key+'Stop'](),key);}
    finally {closed=true;fs.closeSync(fd);metadata.bytes=fs.statSync(file).size;
      metadata.sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
  }};
}
module.exports={start,drain,stop,analyze,requireContinuous,record};
