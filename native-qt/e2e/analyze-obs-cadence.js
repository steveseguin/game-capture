'use strict';
// Match publisher capture/packet identities to the OBS recording's wall-clock
// interval. Legacy traces without wall time use their last eight seconds and
// explicitly identify that weaker comparison.
const fs=require('fs');
const [traceFile,obsFile,sourceFile]=process.argv.slice(2);
if(!traceFile||!obsFile)throw Error('Usage: node analyze-obs-cadence.js frames.csv obs-runtime-results.json');
const rows=fs.readFileSync(traceFile,'utf8').trim().split(/\r?\n/).slice(1).map(line=>{
  const [stage,now,capture,source,id,wall]=line.split(',');
  return {stage,now:Number(now),capture:Number(capture),source:Number(source),id:Number(id),wall:Number(wall)};
});
const cadence=JSON.parse(fs.readFileSync(obsFile,'utf8').replace(/^\uFEFF/,'' )).cadence;
if(!cadence)throw Error('OBS recording evidence is missing');
const aligned=rows.every(r=>Number.isFinite(r.wall))&&Number.isFinite(cadence.recordingStartMs);
const lastCapture=rows.filter(r=>r.stage==='capture').at(-1);
if(!lastCapture)throw Error('Capture trace is empty');
const seconds=aligned?(cadence.recordingEndMs-cadence.recordingStartMs)/1000:8;
const inWindow=r=>aligned?r.wall>=cadence.recordingStartMs&&r.wall<=cadence.recordingEndMs:
  r.now>lastCapture.now-seconds*1e7&&r.now<=lastCapture.now;
const inputs=new Map(rows.filter(r=>r.stage==='submit').map(r=>[r.source,r.id]));
function summarize(stage) {
  let samples=rows.filter(r=>r.stage===stage&&inWindow(r));
  // A packet sent to multiple peers represents a single encoded image.
  if(stage==='sent'||stage==='alpha-sent')samples=samples.filter((r,i)=>!i||r.source!==samples[i-1].source);
  const ids=samples.map(r=>r.id>=0?r.id:inputs.get(r.source));
  const unreadable=ids.filter(x=>x===undefined||x<0).length;
  let changed=0,repeated=0;
  for(let i=1;i<ids.length;i++) {
    if(ids[i]===undefined||ids[i]<0||ids[i-1]===undefined||ids[i-1]<0)continue;
    if(ids[i]===ids[i-1])repeated++;else changed++;
  }
  return {frames:samples.length,framesPerSecond:samples.length/seconds,changedPerSecond:changed/seconds,repeated,unreadable};
}
const result={alignedToRecording:aligned,seconds,
  publisher:Object.fromEntries(['capture','submit','packet','sent'].map(s=>[s,summarize(s)])),
  obs:{recordedFps:cadence.recordedFps,changedPerSecond:cadence.changedFramesPerSecond,
    edgeChangesPerSecond:cadence.edgeChangesPerSecond,renderSkipped:cadence.renderSkipped,outputSkipped:cadence.outputSkipped}};
for(const stage of ['alpha-pair','alpha-sent'])if(rows.some(r=>r.stage===stage))result.publisher[stage]=summarize(stage);
if(rows.some(r=>r.stage==='alpha-sent')) {
  const packetIndexes=new Map(rows.filter(r=>r.stage==='packet').map((r,i)=>[r.source,i]));
  const keyframes=new Set(rows.filter(r=>r.stage==='keyframe').map(r=>r.source));
  const delivered=rows.filter(r=>r.stage==='alpha-sent');
  result.alphaPredictiveGaps=[];
  for(let i=1;i<delivered.length;i++) {
    const a=packetIndexes.get(delivered[i-1].source),b=packetIndexes.get(delivered[i].source);
    if(a!==undefined&&b>a+1&&!keyframes.has(delivered[i].source))
      result.alphaPredictiveGaps.push({source:delivered[i].source,missingPrimaryPackets:b-a-1,wallMs:delivered[i].wall});
  }
}
if(sourceFile) {
  const uploads=fs.readFileSync(sourceFile,'utf8').trim().split(/\r?\n/).filter(x=>/^\d+,/.test(x))
    .map(line=>{const [now,wall,frame,ok]=line.split(',');return {now:Number(now),wall:Number(wall),frame:Number(frame),ok:Number(ok)};})
    .filter(r=>Number.isFinite(cadence.recordingStartMs)?r.wall>=cadence.recordingStartMs&&r.wall<=cadence.recordingEndMs:inWindow(r));
  const gaps=uploads.slice(1).map((r,i)=>(r.now-uploads[i].now)/10000).sort((a,b)=>a-b);
  const sourceSeconds=Number.isFinite(cadence.recordingStartMs)?(cadence.recordingEndMs-cadence.recordingStartMs)/1000:seconds;
  result.sender={seconds:sourceSeconds,frames:uploads.length,framesPerSecond:uploads.length/sourceSeconds,failed:uploads.filter(r=>!r.ok).length,
    medianGapMs:gaps[Math.floor(gaps.length*.5)],p95GapMs:gaps[Math.floor(gaps.length*.95)],maxGapMs:gaps.at(-1)};
}
console.log(JSON.stringify(result,null,2));
if(Object.values(result.publisher).some(s=>!s.frames||s.unreadable)||result.alphaPredictiveGaps?.length||
  (result.sender&&(!result.sender.frames||result.sender.failed)))process.exitCode=1;
