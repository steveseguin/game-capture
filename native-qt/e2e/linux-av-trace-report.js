'use strict';
// Offline attribution for a bounded linux-av-sync --trace-capture=true run.
// The received pulse/phase ID and native per-draw ID are different markers.
// Compare rates in the same windows; join native stages by capture timestamp.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {gunzipSync}=require('zlib');
const report=path.resolve(process.argv[2]),input=JSON.parse(fs.readFileSync(path.join(report,'results.json')));
assert(input.traceCapture&&input.frameTrace);
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const data=fs.readFileSync(path.join(report,input.frameTrace.path)),lines=data.toString().trim().split(/\r?\n/);
assert.equal(lines.shift(),'stage,now100ns,capture100ns,output100ns,id,wallMs');
const rows=lines.map(line=>{const cells=line.split(',');assert.equal(cells.length,6);const [stage,...values]=cells;const [now,capture,output,id,wall]=values.map(Number);assert(values.every(v=>v!==''&&Number.isSafeInteger(Number(v))));return {stage,now,capture,output,id,wall};});
const captures=new Map();for(const row of rows)if(row.stage==='capture'){assert(!captures.has(row.capture),'Capture timestamps must be unique for exact joins');captures.set(row.capture,row);}
const percentile=(values,p)=>{const ordered=[...values].sort((a,b)=>a-b);return ordered.length?ordered[Math.min(ordered.length-1,Math.floor(ordered.length*p))]:null;};
function summarize(selected,seconds){
  const stages={};
  for(const stage of ['capture','submit']){
    const group=selected.filter(r=>r.stage===stage);let changes=0,repeatedContent=0,reusedCapture=0,repeatedContentFromNewCapture=0,unknown=0;
    for(let i=0;i<group.length;i++){
      const row=group[i],previous=group[i-1];
      if(row.id<0){unknown++;continue;}
      if(!previous||previous.id<0||row.id!==previous.id)changes++;
      else {repeatedContent++;if(row.capture!==previous.capture)repeatedContentFromNewCapture++;}
      if(previous&&row.capture===previous.capture)reusedCapture++;
    }
    stages[stage]={rows:group.length,observedFps:group.length/seconds,contentChangesPerSecond:changes/seconds,unknownIds:unknown,repeatedContent,reusedCapture,repeatedContentFromNewCapture};
  }
  const submissions=selected.filter(r=>r.stage==='submit'),joined=submissions.filter(r=>captures.has(r.capture)),ages=joined.map(r=>(r.now-captures.get(r.capture).now)/10000);
  return {seconds,stages,submissionJoins:{matched:joined.length,missing:submissions.length-joined.length,identityMismatches:joined.filter(r=>r.id!==captures.get(r.capture).id).length},captureCallbackToSubmissionMs:{median:percentile(ages,.5),p95:percentile(ages,.95),maximum:ages.length?Math.max(...ages):null}};
}
const samples=input.samples.map(sample=>{
  const compressed=fs.readFileSync(path.join(report,sample.file));assert.equal(hash(compressed),sample.sha256);
  const {observed,trace}=JSON.parse(gunzipSync(compressed)),start=observed.started,end=observed.ended;
  const selected=rows.filter(r=>r.wall>=start&&r.wall<end),draws=new Map();
  for(const frame of trace){assert(Number.isInteger(frame.frameId));assert(!draws.has(frame.frameId),'Diagnostic window exceeds the native identity period');draws.set(frame.frameId,frame.wall);}
  const ages=selected.filter(r=>r.stage==='capture'&&draws.has(r.id)).map(r=>r.wall-draws.get(r.id));
  return {file:sample.file,startWallMs:start,endWallMs:end,receivedPulseChangesFps:sample.receivedFps,sourcePulseChangesFps:sample.sourceFps,sourceDraws:trace.length,originalIntervalPassed:sample.passed,sourceDrawToCaptureWallMs:{matched:ages.length,median:percentile(ages,.5),p95:percentile(ages,.95),maximum:ages.length?Math.max(...ages):null},...summarize(selected,(end-start)/1000)};
});
const result={scope:'Diagnostic attribution only, not a performance or A/V qualification. Native capture/submit content and capture-timestamp reuse, aligned to decoded receiver observation windows using host wall time. Boundary events may differ by a frame; repeated source content can originate upstream of the capture callback.',traceSha256:hash(data),rows:rows.length,possiblyTruncated:rows.length>=100000,stages:Object.fromEntries([...new Set(rows.map(r=>r.stage))].map(stage=>[stage,rows.filter(r=>r.stage===stage).length])),samples};
result.traceComplete=rows.length>0&&!result.possiblyTruncated&&samples.length>0&&samples.every(s=>Object.values(s.stages).every(stage=>stage.rows>0&&stage.unknownIds===0)&&s.submissionJoins.missing===0&&s.submissionJoins.identityMismatches===0);
const output=path.join(report,'frame-trace-analysis.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output,rows:rows.length,possiblyTruncated:result.possiblyTruncated}));
