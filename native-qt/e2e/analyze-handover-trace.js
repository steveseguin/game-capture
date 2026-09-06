'use strict';
const fs=require('fs');
const rows=fs.readFileSync(process.argv[2],'utf8').trim().split(/\r?\n/).slice(1).map(line=>{
  const [stage,now,capture,source,id]=line.split(',');return {stage,now:Number(now),capture:Number(capture),source:Number(source),id:Number(id)};
});
const packets=rows.filter(r=>r.stage==='packet'),submissions=rows.filter(r=>r.stage==='submit');
const sent=rows.filter(r=>r.stage==='sent');
const ms=(a,b)=>(a-b)/10000;
const handovers=rows.filter(r=>r.stage==='handover').map(h=>{
  const start=rows.filter(r=>r.stage==='prepare-start'&&r.now<=h.now).at(-1);
  const before=packets.filter(r=>r.now<h.now).at(-1),after=packets.find(r=>r.now>h.now);
  if(!start||!before||!after)throw Error('Handover trace is incomplete');
  const submission=submissions.find(r=>r.source===after.source);
  const lastSent=sent.filter(r=>r.now<h.now).at(-1),firstSent=sent.find(r=>r.now>h.now);
  return {at100ns:h.now,preparationMs:ms(h.now,start.now),commitToPacketMs:ms(after.now,h.now),
    packetGapMs:ms(after.now,before.now),sourceForwardMs:ms(after.source,before.source),
    commitToSentMs:firstSent?ms(firstSent.now,h.now):null,
    sentGapMs:lastSent&&firstSent?ms(firstSent.now,lastSent.now):null,
    firstLiveSource100ns:after.source,firstLiveId:submission?.id,
    sourceAdmittedAfterCommit:!!submission&&submission.now>h.now};
});
const result={handovers,sourceOrderPreserved:handovers.every(h=>h.sourceForwardMs>0&&h.sourceAdmittedAfterCommit)};
console.log(JSON.stringify(result,null,2));
if(!handovers.length||!result.sourceOrderPreserved)process.exitCode=1;
