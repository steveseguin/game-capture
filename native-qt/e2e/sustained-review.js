'use strict';
const fs=require('fs'),path=require('path');
const {promisify}=require('util');
const execFile=promisify(require('child_process').execFile);
const recording=require('./identity-recording');

exports.run=async function({page,context,sourcePage,control,proc,name,output,publisher,fps,duration,
  measure,stats,motionProbe,audioProbe,api,waitVideo,refreshTransport,sleep,lossCdp,interruptSignaling}) {
  if(!(duration>=60000)||!lossCdp||!interruptSignaling)throw Error('Sustained review requires duration, loss interception and signaling proxy');
  const result={startedMs:Date.now(),requestedMs:duration,samples:[],checkpoints:[]};
  const save=()=>fs.writeFileSync(path.join(output,name+'-sustained.json'),JSON.stringify(result,null,2));
  const second=await context.newPage();
  const check=metrics=>{
    if(!metrics.some(m=>m.kind==='video'&&m.fps>=fps*.95))throw Error('Sustained session lost full-rate video');
    if(!metrics.some(m=>m.kind==='audio'&&m.audioRms>.001))throw Error('Sustained session lost audio');
  };
  async function resources() {
    if(!Number.isInteger(proc.pid)||proc.exitCode!==null)throw Error('Publisher exited during sustained review');
    const command=`$ids=@(${proc.pid})+@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${proc.pid}" | Select-Object -ExpandProperty ProcessId); @(Get-Process -Id $ids -ErrorAction Stop | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,HandleCount,@{Name='ThreadCount';Expression={$_.Threads.Count}}) | ConvertTo-Json -Compress`;
    const {stdout}=await execFile('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,timeout:10000});
    const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));return Array.isArray(rows)?rows:[rows];
  }
  async function sample(ms=30000) {
    const s={wallMs:Date.now(),metrics:await Promise.all([measure(page,ms),measure(second,ms)])};
    result.samples.push(s);save();s.metrics.forEach(check);
    s.processes=await resources();s.diagnostics=await api(control,'/diagnostics');
    s.motion=await motionProbe(page);if(!s.motion.moving)throw Error('Sustained receiver froze');
    save();console.log(name,'sustained minute',((Date.now()-result.startedMs)/60000).toFixed(1),
      'viewer FPS',s.metrics.map(m=>m.find(x=>x.kind==='video')?.fps.toFixed(2)),
      'publisher private MiB',s.processes.find(p=>p.Id===proc.pid)?.PrivateMemorySize64/1048576);
  }
  try {
    await second.goto(page.url(),{waitUntil:'domcontentloaded',timeout:45000});await waitVideo(second);
    result.startedMs=Date.now();
    for(let index=0;index<=4;index++) {
      const due=result.startedMs+duration*index/4;
      while(Date.now()<due) {
        const left=due-Date.now();
        if(left<3000){await sleep(left);break;}
        await sample(Math.min(30000,left));
      }
      const checkpoint={index,startedMs:Date.now()};result.checkpoints.push(checkpoint);save();
      if(index===1) {
        checkpoint.fault={kind:'packet-loss',percent:5};
        try {
          await lossCdp.send('Network.emulateNetworkConditionsByRule',{offline:false,
            matchedNetworkConditions:[{urlPattern:'',latency:1,downloadThroughput:-1,uploadThroughput:-1,packetLoss:5}]});
          checkpoint.fault.metrics=await Promise.all([measure(page,12000),measure(second,12000)]);
        } finally {
          await lossCdp.send('Network.emulateNetworkConditionsByRule',{offline:false,
            matchedNetworkConditions:[{urlPattern:'',latency:1,downloadThroughput:-1,uploadThroughput:-1,packetLoss:0}]});
        }
        if(!checkpoint.fault.metrics[0].some(m=>m.kind==='video'&&(m.packetsLost>0||m.nackCount>0)))
          throw Error('Sustained packet loss was not observed');
      } else if(index===2) {
        checkpoint.fault={kind:'transport-refresh',result:await refreshTransport(control,page)};
      } else if(index===3) {
        checkpoint.fault={kind:'signaling-outage',result:await interruptSignaling()};
      } else if(index===4) {
        checkpoint.fault={kind:'viewer-reload'};
        await page.reload({waitUntil:'domcontentloaded'});
      }
      await waitVideo(page);await waitVideo(second);await sleep(4000);
      checkpoint.recoveryMs=Date.now()-checkpoint.startedMs;
      checkpoint.audio=await audioProbe(page);
      if(Math.abs(checkpoint.audio.dominantHz-440)>10||checkpoint.audio.clippedSamples!==0)throw Error('Sustained audio tone corrupted');
      await sample(8000);
      const clip=await recording.record(page,path.join(output,`${name}-sustained-${index}.webm`),10000);
      checkpoint.recording=clip;save();
      checkpoint.recording=await recording.analyze(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'),clip);
      const decoded=clip.after.reduce((sum,r)=>{const before=clip.before.find(b=>b.id===r.id);
        if(!before)throw Error('Receiver changed during recording');return sum+r.framesDecoded-before.framesDecoded;},0);
      checkpoint.coverage=checkpoint.recording.frames/decoded;
      save();
      if(!decoded||checkpoint.coverage<.98||checkpoint.coverage>1.02||checkpoint.recording.invalid||
        checkpoint.recording.changesPerSecond<fps*.95)throw Error('Sustained recording lost complete fresh-frame cadence');
      console.log(name,'sustained recording',index,'distinct FPS',checkpoint.recording.changesPerSecond);
    }
    result.completedMs=Date.now();result.ok=true;save();return result;
  } catch(e){result.error=String(e);result.ok=false;result.completedMs=Date.now();save();throw e;}
  finally {await second.close();}
};
