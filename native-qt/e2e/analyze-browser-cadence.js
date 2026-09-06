'use strict';
const fs=require('fs');
const [traceFile,resultsFile,caseName]=process.argv.slice(2);
if(!traceFile||!resultsFile||!caseName)throw Error('Usage: analyze-browser-cadence.js frames.csv results.json case-name');
const run=JSON.parse(fs.readFileSync(resultsFile,'utf8').replace(/^\uFEFF/,''));
const result=run.results.find(r=>r.name===caseName);
const recording=result?.identityRecording;
if(!recording?.receiver||!recording?.source)throw Error('Completed source and receiver recordings required');
const rows=fs.readFileSync(traceFile,'utf8').trim().split(/\r?\n/).slice(1).map(l=>{
  const [stage,now,capture,source,id,wall]=l.split(',');
  return {stage,now:Number(now),capture:Number(capture),source:Number(source),id:Number(id),wall:Number(wall)};
});
if(rows.some(r=>!Number.isFinite(r.wall)))throw Error('Wall-aligned trace required');
const inputs=new Map(rows.filter(r=>r.stage==='submit').map(r=>[r.source,r.id]));
const clip=recording.receiver,seconds=(clip.endMs-clip.startMs)/1000;
const publisher={};
for(const stage of ['capture','submit','packet','sent']) {
  let samples=rows.filter(r=>r.stage===stage&&r.wall>=clip.startMs&&r.wall<=clip.endMs);
  if(stage==='sent')samples=samples.filter((r,i)=>!i||r.source!==samples[i-1].source);
  const ids=samples.map(r=>r.id>=0?r.id:inputs.get(r.source));
  let changes=0,repeats=0;
  for(let i=1;i<ids.length;i++)if(ids[i]>=0&&ids[i-1]>=0){if(ids[i]===ids[i-1])repeats++;else changes++;}
  publisher[stage]={frames:ids.length,framesPerSecond:ids.length/seconds,changesPerSecond:changes/seconds,
    repeats,invalid:ids.filter(id=>!(id>=0)).length};
}
const counterDeltas=(clip.after||recording.after).filter(r=>r.kind==='video').map(after=>{
  const before=(clip.before||recording.before).find(r=>r.id===after.id);
  if(!before)throw Error('Receiver changed during recording');
  return {decoded:after.framesDecoded-before.framesDecoded,dropped:after.framesDropped-before.framesDropped};
});
const decoded=counterDeltas.reduce((n,r)=>n+r.decoded,0);
const expectedFreshFps=Math.min(result.requested.fps,result.source.fixture.fps);
if(!(expectedFreshFps>0))throw Error('Requested and source frame rates required');
const sentIds=rows.filter(r=>r.stage==='sent'&&r.wall>=clip.startMs-1000&&r.wall<=clip.endMs+1000)
  .filter((r,i,all)=>!i||r.source!==all[i-1].source).map(r=>inputs.get(r.source));
const matchAt=sentIds.findIndex((id,i)=>id===clip.ids[0]&&
  clip.ids.every((value,j)=>value===sentIds[i+j]));
const compact=c=>{const {ids,before,after,...summary}=c;return summary;};
const evidence={case:caseName,publisherSha256:run.sha256,
  sourceGeometry:result.source.geometry,
  source:compact(recording.source),receiver:compact(clip),publisher,counterDeltas,
  recorderCoverage:clip.frames/decoded,
  minimumChangesPerSecond:expectedFreshFps*.95,
  freshCadencePassed:clip.changesPerSecond>=expectedFreshFps*.95,
  receiverMatchesContiguousSentSequence:matchAt>=0,
  skippedBeforeReadbackAtExit:result.final?.video.frames_skipped_before_readback,
  earlierCallbackProbe:{observedFps:result.initialIdentity.uniqueObservedFps,missedCallbacks:result.initialIdentity.missedCallbacks}};
for(const stage of ['capture-arrival','capture-rejected'])if(rows.some(r=>r.stage==='capture-arrival')) {
  const samples=rows.filter(r=>r.stage===stage&&r.wall>=clip.startMs&&r.wall<=clip.endMs);
  publisher[stage]={frames:samples.length,framesPerSecond:samples.length/seconds};
}
const arrivals=rows.filter(r=>r.stage==='capture-arrival');
if(arrivals.length) {
  const times=new Map(arrivals.map(r=>[r.source,r.now]));
  const costs=rows.filter(r=>r.stage==='capture'&&r.wall>=clip.startMs&&r.wall<=clip.endMs&&times.has(r.capture))
    .map(r=>(r.now-times.get(r.capture))/10000).sort((a,b)=>a-b);
  evidence.captureReadbackAndPublishMs={samples:costs.length,
    median:costs[Math.floor(costs.length*.5)],p95:costs[Math.floor(costs.length*.95)],max:costs.at(-1)};
  const window=arrivals.filter(r=>r.wall>=clip.startMs&&r.wall<=clip.endMs);
  evidence.longArrivalTimestampGapsMs=window.slice(1).map((r,i)=>(r.source-window[i].source)/10000)
    .filter(ms=>ms>1500/expectedFreshFps);
}
console.log(JSON.stringify(evidence,null,2));
// Report content cadence separately from evidence completeness. A recording
// with many repeated images must not pass just because its container is 60 FPS.
if(!decoded||evidence.recorderCoverage<.98||evidence.recorderCoverage>1.02||recording.source.invalid||clip.invalid||
  !evidence.freshCadencePassed||
  ['capture','submit','packet','sent'].some(stage=>!publisher[stage].frames||publisher[stage].invalid))process.exitCode=1;
