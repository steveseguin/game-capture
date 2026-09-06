'use strict';
const fs=require('fs');
const file=process.argv[2];
if(!file)throw Error('Usage: analyze-sustained-review.js case-sustained.json');
const r=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const percentile=(values,f)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*f))];};
const summary=values=>({min:percentile(values,0),median:percentile(values,.5),p95:percentile(values,.95),max:percentile(values,1)});
const memory=r.samples.filter(s=>s.processes).map(s=>{
  const publisher=s.processes.find(p=>p.ProcessName==='game-capture');
  if(!publisher)throw Error('Publisher process is missing from resource evidence');
  return {minute:(s.wallMs-r.startedMs)/60000,publisherPrivateMiB:publisher.PrivateMemorySize64/1048576,
    publisherWorkingMiB:publisher.WorkingSet64/1048576,handles:publisher.HandleCount,threads:publisher.ThreadCount,
    encoderPrivateMiB:s.processes.filter(p=>p.ProcessName==='ffmpeg').reduce((sum,p)=>sum+p.PrivateMemorySize64/1048576,0),
    encoderCount:s.processes.filter(p=>p.ProcessName==='ffmpeg').length};
});
const steady=memory.filter(s=>s.minute>=2);
function trend(key) {
  const points=steady.length?steady:memory;
  if(!points.length)return null;
  const mx=points.reduce((n,p)=>n+p.minute,0)/points.length,my=points.reduce((n,p)=>n+p[key],0)/points.length;
  const divisor=points.reduce((n,p)=>n+(p.minute-mx)**2,0);
  return {...summary(points.map(p=>p[key])),first:points[0][key],last:points.at(-1)[key],
    slopePerMinute:divisor?points.reduce((n,p)=>n+(p.minute-mx)*(p[key]-my),0)/divisor:0};
}
const viewers=[0,1].map(index=>{
  const metrics=r.samples.map(s=>s.metrics?.[index]?.find(m=>m.kind==='video')).filter(Boolean);
  const audio=r.samples.map(s=>s.metrics?.[index]?.find(m=>m.kind==='audio')).filter(Boolean);
  return {index,windows:metrics.length,fps:summary(metrics.map(m=>m.fps)),
    receiverProcessingMs:summary(metrics.map(m=>m.processingMs)),jitterBufferMs:summary(metrics.map(m=>m.jitterBufferMs)),
    decodeMs:summary(metrics.map(m=>m.decodeMs)),
    firstProcessingMs:metrics[0]?.processingMs,lastProcessingMs:metrics.at(-1)?.processingMs,
    drops:metrics.reduce((n,m)=>n+m.framesDropped,0),freezes:metrics.reduce((n,m)=>n+m.freezeCount,0),
    videoPacketsLost:metrics.reduce((n,m)=>n+m.packetsLost,0),audioConcealedSamples:audio.reduce((n,m)=>n+m.concealedSamples,0)};
});
const checkpoints=r.checkpoints.map(c=>({index:c.index,minute:(c.startedMs-r.startedMs)/60000,
  fault:c.fault,coverage:c.coverage,recording:c.recording&&{
    file:c.recording.file,sha256:c.recording.sha256,frames:c.recording.frames,invalid:c.recording.invalid,
    distinctChangesPerSecond:c.recording.changesPerSecond,repeats:c.recording.repeats},audio:c.audio}));
// Both fields use the publisher's steady clock; wire input timestamps are in
// 100 ns units. Ignore retired peers, whose last-sent timestamp is stale.
const inputAges=r.samples.filter(s=>s.diagnostics).map(s=>{
  const ages=s.diagnostics.peers.filter(p=>p.media.last_observed_video_track_active)
    .map(p=>s.diagnostics.generated_steady_ms-p.media.last_primary_transport_pts/10000);
  return ages.length?Math.max(...ages):NaN;
}).filter(Number.isFinite);
// Diagnostics timestamps the start of collection; peer media counters are
// read later under their own locks. A send during collection can therefore
// produce a negative age. Preserve its count instead of treating it as latency.
const validInputAges=inputAges.filter(age=>age>=0);
const result={ok:r.ok,error:r.error,requestedMinutes:r.requestedMs/60000,
  actualMinutes:(r.completedMs-r.startedMs)/60000,viewers,
  publisherLastSentInputAgeMs:{...summary(validInputAges),first:validInputAges[0],last:validInputAges.at(-1),
    validSamples:validInputAges.length,nonAtomicNegativeSamples:inputAges.length-validInputAges.length},
  signalingRecoveredInMeasuredWindows:r.samples.filter(s=>s.diagnostics).every(s=>
    s.diagnostics.app.live&&!s.diagnostics.app.reconnecting),
  memory:{publisherPrivateMiB:trend('publisherPrivateMiB'),publisherWorkingMiB:trend('publisherWorkingMiB'),
    encoderPrivateMiB:trend('encoderPrivateMiB'),handles:trend('handles'),threads:trend('threads'),
    encoderCounts:[...new Set(memory.map(m=>m.encoderCount))]},checkpoints};
console.log(JSON.stringify(result,null,2));
if(!r.ok||r.completedMs-r.startedMs<r.requestedMs||checkpoints.length!==5||
  !result.signalingRecoveredInMeasuredWindows||
  checkpoints.some(c=>!c.recording?.frames||c.recording.invalid||!(c.coverage>=.98&&c.coverage<=1.02)))process.exitCode=1;
