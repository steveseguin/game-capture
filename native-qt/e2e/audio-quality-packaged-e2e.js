'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const {spawn,execFile}=require('child_process'),{promisify}=require('util');
const exec=promisify(execFile),{chromium}=require('playwright');
const observer=require('./audio-quality-observer');
const opts=Object.fromEntries(process.argv.slice(2).map(s=>{const i=s.indexOf('=');return [s.slice(2,i),s.slice(i+1)];}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(condition,message)=>{if(!condition)throw Error(message);};
async function until(fn,label,ms=40000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(200);}throw Error('Timeout: '+label);}
async function main(){
 const output=path.resolve(opts.output),publisher=path.resolve(opts.publisher);fs.mkdirSync(output,{recursive:true});
 check(fs.existsSync(path.join(path.dirname(publisher),'platforms/qwindows.dll')),'Complete package required');
 const {stdout:active}=await exec('powershell.exe',['-NoProfile','-Command',
  `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'game-capture.exe' -or ($_.Name -eq 'node.exe' -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match '(media-quality-packaged|audio-quality-packaged-e2e)') } | Select-Object -ExpandProperty ProcessId`],{windowsHide:true});
 check(!active.trim(),'Another publisher/quality workflow is active; run quality measurements sequentially');
 const children=[],browsers=[];let server;
 const launch=(exe,args,name,env={})=>{const log=fs.createWriteStream(path.join(output,name+'.log'));
  const p=spawn(exe,args,{windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});children.push(p);p.closed=new Promise(r=>p.on('close',c=>{log.end();r(c);}));return p;};
 const report={publisher,sha256:crypto.createHash('sha256').update(fs.readFileSync(publisher)).digest('hex'),cases:[]};
 const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
 try{
  server=await require('./browser-fixture-server').start(path.join(__dirname,'audio-quality-source.html'),path.join(__dirname,'audio-quality-source.html'));
  const sourceBrowser=await chromium.launch({channel:'chrome',headless:false,args:['--window-size=1320,900',
   '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  browsers.push(sourceBrowser);const sourcePage=await sourceBrowser.newPage({viewport:null});await sourcePage.goto(server.url);
  const title='AudioQuality'+crypto.randomBytes(8).toString('hex');await sourcePage.evaluate(title=>document.title=title,title);
  await until(()=>sourcePage.evaluate(()=>window.fixture?.frames>60),'source video and audio');
  await sourcePage.screenshot({path:path.join(output,'source.png')});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});browsers.push(browser);
  report.chrome=browser.version();report.logicalProcessors=os.cpus().length;
  const cases=(opts.cases||'opus,pcm,red').split(',');
  for(const name of cases){
   check(['opus','pcm','red','system'].includes(name),'Unknown audio case: '+name);
   const dir=path.join(output,name);fs.mkdirSync(dir,{recursive:true});
   const result={name,samples:[],stages:[],churn:[]};report.cases.push(result);save();
   const stream='quality'+crypto.randomBytes(8).toString('hex'),discovery=path.join(dir,'control.json');
   const app=launch(publisher,['--headless','--source=window','--window='+title,'--stream='+stream,'--password=false',
    '--width=1280','--height=720','--fps=60','--bitrate-kbps=8000','--audio-source='+ (name==='system'?'default-output':'selected-window'),
    '--audio-codec='+(name==='pcm'?'pcm':'opus'),...(name==='red'?['--audio-red']:[]),
    '--duration-ms=3600000','--local-control','--local-control-discovery='+discovery],name,{LOCALAPPDATA:dir,
      ...(opts.trace==='true'?{VERSUS_FRAME_TRACE:path.join(dir,'frame-trace.csv'),VERSUS_FRAME_TRACE_PATTERN:'alpha-moving-edge'}:{})});
   let page,cdp,control;
   const api=async(route,body)=>{control||=JSON.parse(fs.readFileSync(discovery,'utf8'));
    const res=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    check(res.ok,'Control failed '+route);return res.json();};
   async function resources(){
    const script=`$gpu=@(${opts.gpu==='true'?`Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop | Where-Object { $_.Name -like 'pid_${app.pid}_*' } | Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted`:''}); $p=Get-Process -Id ${app.pid} -ErrorAction Stop; [pscustomobject]@{wallMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); privateBytes=$p.PrivateMemorySize64; workingSet=$p.WorkingSet64; cpuMs=$p.TotalProcessorTime.TotalMilliseconds; handles=$p.HandleCount; threads=$p.Threads.Count; gpu=$gpu} | ConvertTo-Json -Compress -Depth 4`;
    const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,timeout:30000});return JSON.parse(stdout.replace(/^\uFEFF/,''));
   }
   async function stats(){return page.evaluate(async()=>{const pc=window.qualityPeers.find(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track.kind==='audio'));
    return [...(await pc.getStats()).values()].filter(s=>s.type==='inbound-rtp');});}
   async function audioTimestamp(){return page.evaluate(()=>{
    const pc=window.qualityPeers.find(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track.kind==='audio'));
    const source=pc.getReceivers().find(r=>r.track.kind==='audio').getSynchronizationSources()[0];
    if(!source)throw Error('No decoded audio RTP timestamp');
    // Chrome versions differ here: some expose an epoch timestamp, others
    // a DOMHighResTimeStamp relative to this page's time origin.
    return {...source,wall:source.timestamp>1e12?source.timestamp:performance.timeOrigin+source.timestamp};
   });}
   async function connect(){
    page=await browser.newPage();
    await page.addInitScript(()=>{window.qualityPeers=[];window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(T,args){const pc=new T(...args);window.qualityPeers.push(pc);return pc;}});});
    cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditionsByRule',{offline:false,matchedNetworkConditions:[{urlPattern:'',latency:1,downloadThroughput:-1,uploadThroughput:-1,packetLoss:0}]});
    let link;
    await until(()=>{link=fs.readFileSync(path.join(output,name+'.log'),'utf8').match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1];return link;},'viewer link');
    const url=new URL(link);url.searchParams.set('autostart','');url.searchParams.set('muted','');url.searchParams.set('cleanoutput','');
    await page.goto(url.href,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.qualityPeers.some(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track.kind==='audio')),
     null,{timeout:40000});
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.videoWidth===1280&&v.currentTime>1),null,{timeout:40000});
    result.negotiated=await page.evaluate(async()=>{
      const pc=window.qualityPeers.find(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track.kind==='audio'));
      const all=await pc.getStats(),audio=[...all.values()].find(s=>s.type==='inbound-rtp'&&s.kind==='audio');
      return {audioCodec:audio&&all.get(audio.codecId),audioAnswer:pc.localDescription.sdp.split('\r\n').find(l=>l.startsWith('m=audio '))};
    });
    check(result.negotiated.audioAnswer.split(' ')[3]===(name==='pcm'?'109':name==='red'?'63':'111'),'Wrong negotiated audio mode');
    await observer.install(page);
   }
   async function stage(label,seconds=12){
    const before=await stats();await page.evaluate(()=>window.qualityObserver.start());
    await sleep(seconds*1000);
    const after=await stats(),data=await page.evaluate(()=>window.qualityObserver.stop());
    fs.writeFileSync(path.join(dir,label+'.f32'),Buffer.from(data.pcmBase64,'base64'));delete data.pcmBase64;
    const analyzed=observer.analyze(data);
    const source=await sourcePage.evaluate(()=>window.fixture);
    const audioEvents=data.audio.filter((a,i)=>i&&a.amplitude[0][2]>.035&&data.audio[i-1].amplitude[0][2]<=.035).map(a=>a.wall);
    const delays=audioEvents.map(t=>source.flashEvents.map(s=>t-s.sourceAudioOnsetWall).filter(d=>d>=-100&&d<1500).sort((a,b)=>Math.abs(a)-Math.abs(b))[0]).filter(Number.isFinite);
    const sorted=delays.sort((a,b)=>a-b);analyzed.audio.delayMedianMs=sorted[Math.floor(sorted.length/2)];
    const sourceOffsets=source.flashEvents.slice(-10).map(s=>s.sourceAudioOnsetWall-s.wall).sort((a,b)=>a-b);
    analyzed.sync.sourceAudioMinusVideoMs=sourceOffsets[Math.floor(sourceOffsets.length/2)];
    analyzed.sync.adjustedMedianMs=analyzed.sync.medianMs-analyzed.sync.sourceAudioMinusVideoMs;
    const metrics=after.map(b=>{const a=before.find(a=>a.id===b.id);if(!a)return {kind:b.kind,changed:true};const seconds=(b.timestamp-a.timestamp)/1000,d=k=>(b[k]||0)-(a[k]||0);
     return {kind:b.kind,seconds,fps:d('framesDecoded')/seconds,framesDecoded:d('framesDecoded'),framesDropped:d('framesDropped'),freezeCount:d('freezeCount'),
      kbps:d('bytesReceived')*8/seconds/1000,packetsLost:d('packetsLost'),concealedSamples:d('concealedSamples'),totalSamples:d('totalSamplesReceived'),
      concealmentEvents:d('concealmentEvents'),silentConcealedSamples:d('silentConcealedSamples'),
      insertedSamplesForDeceleration:d('insertedSamplesForDeceleration'),removedSamplesForAcceleration:d('removedSamplesForAcceleration'),
      jitterBufferMs:d('jitterBufferDelay')*1000/Math.max(1,d('jitterBufferEmittedCount')),jitter:b.jitter};});
    const entry={label,metrics,...analyzed};result.stages.push(entry);save();
    fs.writeFileSync(path.join(dir,label+'-timing.json'),JSON.stringify({data,source,receiverBefore:before,receiverAfter:after},null,2));
    await page.screenshot({path:path.join(dir,label+'.png')});
    console.log(name,label,JSON.stringify(entry));return entry;
   }
   try{
    await until(async()=>fs.existsSync(discovery)&&(await api('/diagnostics')).app.live,'publisher live');
    await connect();await sleep(3000);
    result.initialDiagnostics=await api('/diagnostics');result.samples.push(await resources());
    await stage('steady');
    if(opts.record==='true'){
      await page.evaluate(()=>window.reviewPCs=window.qualityPeers);
      const recorder=require('./identity-recording');
      result.recording=await recorder.record(page,path.join(dir,'receiver.webm'),10000);
      result.recording=await recorder.analyze(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'),result.recording,24);
      const before=result.recording.before[0],after=result.recording.after.find(s=>s.id===before.id);
      result.recording.decoderCoverage=result.recording.frames/(after.framesDecoded-before.framesDecoded);
      check(!result.recording.invalid,'Invalid recorded frame time codes');
      check(result.recording.decoderCoverage>.98&&result.recording.decoderCoverage<1.02,'Incomplete receiver recording');
      save();
    }
    const noise=launch('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'audio-test-tone.ps1'),
      '-FrequencyHz','3000','-Amplitude','0.12','-DurationMs','24000'],name+'-unrelated-system-sound');
    await sleep(3000);await stage('unrelated-system-sound');noise.kill();await noise.closed;
    await sourcePage.evaluate(()=>window.setFixtureSilence(true));await sleep(1000);
    await stage('source-silence',6);
    await sourcePage.evaluate(()=>window.setFixtureSilence(false));await sleep(1000);
    if(opts.reconnect==='true'){
      const before=await audioTimestamp();
      await page.evaluate(()=>window.qualityObserver.close());await page.close();
      await until(async()=>{
        const diagnostics=await api('/diagnostics');
        const inactive=diagnostics.peers.every(p=>!p.media.last_observed_audio_track_active);
        if(inactive)result.idleDiagnostics=diagnostics;
        return inactive;
      },'all audio viewers inactive',120000);
      await sleep(Number(opts['gap-seconds']||8)*1000);await connect();await sleep(2000);
      const after=await audioTimestamp(),rate=name==='pcm'?32000:48000;
      const rtpElapsedMs=((after.rtpTimestamp-before.rtpTimestamp)>>>0)/rate*1000;
      result.reconnectClock={before,after,rtpElapsedMs,wallElapsedMs:after.wall-before.wall,
        errorMs:rtpElapsedMs-(after.wall-before.wall)};save();
      await stage('after-idle-reconnect');
      check(Math.abs(result.reconnectClock.errorMs)<250,'Audio RTP timeline omitted the interval without viewers');
    }
    if(opts.probe!=='true'){
      const seconds=Number(opts['soak-seconds']||120);const deadline=Date.now()+seconds*1000;
      const first=await stats();
      while(Date.now()<deadline){await sleep(Math.min(10000,deadline-Date.now()));
        result.samples.push({...await resources(),receiver:await stats(),diagnostics:await api('/diagnostics')});save();
        console.log(name,'soak',Math.round((seconds*1000-(deadline-Date.now()))/1000),'s',Math.round(result.samples.at(-1).privateBytes/1048576),'MiB');}
      result.soakStats={before:first,after:await stats()};await stage('after-soak');
      const cycles=Number(opts.cycles||8);
      for(let i=0;i<cycles;i++){
        await page.evaluate(()=>window.qualityObserver.close());await page.close();await sleep(500);await connect();await sleep(1500);
        result.churn.push({cycle:i,...await resources(),diagnostics:await api('/diagnostics')});save();
      }
      await stage('after-viewer-churn');
      const beforeRefresh=await api('/diagnostics');await api('/commands',{command:'refresh_peer_transports'});await sleep(4000);
      await page.evaluate(()=>window.qualityObserver.close());await page.close();await connect();await sleep(2000);
      result.transportRefresh={before:beforeRefresh,after:await api('/diagnostics')};await stage('after-transport-refresh');
      await cdp.send('Network.emulateNetworkConditionsByRule',{offline:false,matchedNetworkConditions:[{urlPattern:'',latency:1,downloadThroughput:-1,uploadThroughput:-1,packetLoss:5}]});
      await stage('five-percent-loss');
      await cdp.send('Network.emulateNetworkConditionsByRule',{offline:false,matchedNetworkConditions:[{urlPattern:'',latency:1,downloadThroughput:-1,uploadThroughput:-1,packetLoss:0}]});
      await sleep(3000);await stage('after-loss');
    }
    result.finalDiagnostics=await api('/diagnostics');result.samples.push(await resources());
    const quiet=result.stages.find(s=>s.label==='source-silence');
    result.checks=[{name:'silent-source-has-no-spurious-output',passed:quiet.audio.peak<.002}];
    if(opts.probe!=='true')result.checks.push({name:'network-loss-actually-applied',passed:
      result.stages.find(s=>s.label==='five-percent-loss').metrics.find(m=>m.kind==='audio').packetsLost>5});
    for(const s of result.stages.filter(s=>['steady','after-idle-reconnect','after-soak','after-viewer-churn','after-transport-refresh','after-loss'].includes(s.label))){
      result.checks.push({name:s.label+'-audio-not-clipped-or-silent',passed:s.audio.clippedSamples===0&&s.audio.silentWindows===0});
      result.checks.push({name:s.label+'-stereo-separation',passed:s.audio.medianAmplitudes[0][0]>.06&&s.audio.medianAmplitudes[1][1]>.06&&
        s.audio.medianAmplitudes[0][1]<.007&&s.audio.medianAmplitudes[1][0]<.007});
      result.checks.push({name:s.label+'-video-delivered',passed:s.metrics.find(m=>m.kind==='video').fps>57});
    }
    if(name!=='system')result.checks.push({name:'selected-window-excludes-independent-tone',passed:
      result.stages.find(s=>s.label==='unrelated-system-sound').audio.medianAmplitudes.every(ch=>ch[3]<.001)});
    result.completed=true;
    result.passed=result.checks.every(c=>c.passed);save();
    check(result.passed,'Quality assertions failed; inspect saved measurements');
   }catch(e){result.error=String(e);throw e;}finally{
    if(page)await page.close().catch(()=>{});
    await sourcePage.evaluate(()=>window.setFixtureSilence(false)).catch(()=>{});
    if(fs.existsSync(discovery))await api('/commands',{command:'quit'}).catch(()=>{});
    await Promise.race([app.closed,sleep(10000)]);if(app.exitCode===null)app.kill();await app.closed;result.exitCode=app.exitCode;save();
    if(result.completed)check(app.exitCode===0,'Publisher did not exit cleanly');
   }
  }
  report.completed=true;save();
 }catch(e){report.error=String(e);save();throw e;}finally{
  for(const p of children)if(p.exitCode===null)p.kill();await Promise.all(children.map(p=>p.closed));
  for(const b of browsers)await b.close();server?.close();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
