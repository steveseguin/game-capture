#!/usr/bin/env node
'use strict';
// Packaged publisher -> public VDO.Ninja viewer; receiver counters, not startup-only checks.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn, execFile} = require('child_process');
const {promisify} = require('util');
const execFileAsync = promisify(execFile);
const {chromium} = require('playwright');
const opts = Object.fromEntries(process.argv.slice(2).map(s => { const i=s.indexOf('='); return [s.slice(2,i),s.slice(i+1)]; }));
const publisher = path.resolve(opts.publisher);
const senderExe = opts.sender ? path.resolve(opts.sender) : null;
const windowVideo = opts['window-video'] ? path.resolve(opts['window-video']) : null;
if (!senderExe && !windowVideo) throw Error('--sender or --window-video is required');
if (windowVideo && ['resize','color-check','control-source-restart','shutdown-source-loss'].some(k=>opts[k]==='1'))
  throw Error('Spout fixture options cannot be used with --window-video');
const run = path.resolve(opts.reports, crypto.randomUUID());
fs.mkdirSync(run,{recursive:true});
if (!fs.existsSync(path.join(path.dirname(publisher),'platforms/qwindows.dll'))) throw Error('Complete package required');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const children = new Set();
const browsers = new Set();
function launch(exe,args,name,env={}) {
  const child=spawn(exe,args,{windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  children.add(child);
  const log=fs.createWriteStream(path.join(run,name+'.log'));
  child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false});
  child.on('exit',()=>{children.delete(child);log.end();});
  child.on('error',e=>log.write(String(e)));
  return child;
}
async function api(control,route,body) {
  const res=await fetch(control.base_url+route,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  const data=await res.json(); if(!res.ok) throw Error(JSON.stringify(data)); return data;
}
async function stats(page) {
  return page.evaluate(async()=>{
    const all=[];
    for(const pc of window.reviewPCs||[]) {
      if(pc.connectionState==='closed') continue;
      const reports=await pc.getStats();
      for(const r of reports.values()) if(r.type==='inbound-rtp') {
        all.push({...r,codec:reports.get(r.codecId)?.mimeType,connectionState:pc.connectionState});
      }
    }
    return all;
  });
}
async function waitVideo(page,timeout=45000) {
  const start=Date.now(); let last=[];
  while(Date.now()-start<timeout) {
    last=await stats(page);
    if(last.some(s=>s.kind==='video'&&s.framesDecoded>15&&s.framesPerSecond>0)) return Date.now()-start;
    await sleep(300);
  }
  throw Error('No advancing decoded video: '+JSON.stringify(last));
}
async function measure(page,ms) {
  const before=await stats(page); await sleep(ms); const after=await stats(page);
  return after.map(b=>{
    const a=before.find(x=>x.id===b.id);
    if(!a) return {kind:b.kind,changedStream:true};
    const seconds=(b.timestamp-a.timestamp)/1000;
    const delta=k=>(b[k]||0)-(a[k]||0);
    return {kind:b.kind,codec:b.codec,seconds,width:b.frameWidth,height:b.frameHeight,
      fps:delta('framesDecoded')/seconds,kbps:delta('bytesReceived')*8/seconds/1000,
      framesDecoded:delta('framesDecoded'),framesDropped:delta('framesDropped'),
      packetsReceived:delta('packetsReceived'),packetsLost:delta('packetsLost'),
      freezeCount:delta('freezeCount'),freezeSeconds:delta('totalFreezesDuration'),
      jitter:b.jitter,decodeMs:delta('totalDecodeTime')*1000/Math.max(1,delta('framesDecoded')),
      audioRms:Math.sqrt(Math.max(0,delta('totalAudioEnergy'))/Math.max(.001,delta('totalSamplesDuration'))),
      concealedSamples:delta('concealedSamples'),totalSamples:delta('totalSamplesReceived')};
  });
}
async function motionProbe(page) {
  return page.evaluate(async(generic)=>{
    const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth>0);
    if(!video)return {moving:false,error:'No decoded video'};
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});const centers=[],changes=[];let previous;
    for(let sample=0;sample<5;sample++) {
      ctx.drawImage(video,0,0,160,90);
      const pixels=ctx.getImageData(0,0,160,90).data;let xSum=0,count=0;
      if(previous) {
        let sum=0;for(let i=0;i<pixels.length;i++)if(i%4!==3)sum+=Math.abs(pixels[i]-previous[i]);
        changes.push(sum/(160*90*3));
      }
      previous=pixels;
      // Track the fixture's blue box, rather than codec noise or frame counters.
      for(let i=0;i<pixels.length;i+=4)if(pixels[i]<100&&pixels[i+1]<150&&pixels[i+2]>180) {
        xSum+=(i/4)%160;count++;
      }
      if(count>10)centers.push(xSum/count);
      await new Promise(r=>setTimeout(r,300));
    }
    return generic ? {moving:changes.filter(c=>c>1).length>=2,meanPixelChanges:changes} :
      {moving:centers.length>=3&&Math.max(...centers)-Math.min(...centers)>1,blueBoxCenters:centers};
  },Boolean(windowVideo));
}
async function saveFrame(page,name) {
  const url=await page.evaluate(()=>{
    const v=[...document.querySelectorAll('video')].find(v=>v.videoWidth>0);
    if(!v)return null;
    const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png');
  });
  if(url)fs.writeFileSync(path.join(run,name+'.png'),Buffer.from(url.split(',')[1],'base64'));
}
async function colorProbe(page) {
  return page.evaluate(()=>{
    const v=[...document.querySelectorAll('video')].find(v=>v.videoWidth>0);
    const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(v,0,0);
    const expected=[[180,60,60],[60,180,60],[60,60,180],[180,180,60],[60,180,180],[180,60,180],[128,128,128],[240,240,240]];
    return expected.map((rgb,i)=>{
      const pixels=ctx.getImageData(Math.floor((i+.5)*c.width/8)-8,Math.floor(c.height/16)-8,16,16).data;
      const actual=[0,0,0];for(let p=0;p<pixels.length;p+=4)for(let k=0;k<3;k++)actual[k]+=pixels[p+k]/256;
      return {expected:rgb,actual,maxError:Math.max(...rgb.map((v,k)=>Math.abs(v-actual[k])))};
    });
  });
}
async function audioProbe(page) {
  return page.evaluate(async()=>{
    const tracks=(window.reviewPCs||[]).flatMap(pc=>pc.getReceivers()).map(r=>r.track).filter(t=>t?.kind==='audio'&&t.readyState==='live');
    if(!tracks.length)return {error:'No live audio track'};
    const ctx=new AudioContext();await ctx.resume();
    try {
      const source=ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
      const analyser=ctx.createAnalyser();analyser.fftSize=8192;
      source.connect(analyser);
      await new Promise(r=>setTimeout(r,700));
      const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);
      let peak=1;for(let i=2;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      return {sampleRate:ctx.sampleRate,dominantHz:peak*ctx.sampleRate/analyser.fftSize,
        peakDb:bins[peak],rms:Math.sqrt(samples.reduce((a,x)=>a+x*x,0)/samples.length),
        clippedSamples:samples.filter(x=>Math.abs(x)>=.999).length};
    } finally {await ctx.close();}
  });
}
async function main() {
  const fps=Number(opts.fps||30), width=Number(opts.width||1280),height=Number(opts.height||720);
  const senderName='ReceiverReview_'+crypto.randomUUID().replaceAll('-','');
  const senderArgs=[`--name=${senderName}`,`--width=${width}`,`--height=${height}`,`--fps=${Number(opts['source-fps']||fps)}`,`--pattern=${opts['color-check']==='1'?'color-bars':'animated'}`,'--duration-ms=1800000'];
  if(opts.resize==='1')senderArgs.push('--resize-after-ms=20000','--resize-width=1280','--resize-height=960');
  let sourceBrowser,sourcePage;
  let sender=windowVideo?null:launch(senderExe,senderArgs,'source');
  if(windowVideo) {
    const {pathToFileURL}=require('url');
    const html=path.join(run,'browser-source.html');
    fs.writeFileSync(html,`<!doctype html><title>${senderName}</title><style>html,body{margin:0;background:black;overflow:hidden}video{width:100vw;height:100vh;object-fit:contain}</style><video autoplay loop muted src="${pathToFileURL(windowVideo).href}"></video>`);
    sourceBrowser=await chromium.launch({headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    browsers.add(sourceBrowser);
    const sourceContext=await sourceBrowser.newContext({viewport:{width,height}});
    sourcePage=await sourceContext.newPage();await sourcePage.goto(pathToFileURL(html).href);
    await sourcePage.waitForFunction(()=>document.querySelector('video').currentTime>1);
  }
  const toneArgs=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'audio-test-tone.ps1'),'-DurationMs','1800000','-Amplitude','0.08'];
  let tone=launch('powershell.exe',toneArgs,'tone');
  await sleep(2500);
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  browsers.add(browser);
  let proxy, proxyPort, blockedUntil=0, proxyConnections=0;
  let handshakeProxy, stallHandshake=false, stalledHandshakes=0;
  const handshakeSockets=new Set();
  const upstreams=new Set();
  if(opts.faults==='1') {
    const {WebSocketServer,WebSocket}=require('ws');
    proxy=new WebSocketServer({host:'127.0.0.1',port:0});
    await new Promise(r=>proxy.once('listening',r));proxyPort=proxy.address().port;
    proxy.on('connection',client=>{
      if(Date.now()<blockedUntil){client.close(1013,'Review outage');return;}
      proxyConnections++;
      const remote=new WebSocket('wss://wss.vdo.ninja:443');upstreams.add(remote);const queued=[];
      client.on('message',(data,binary)=>{if(remote.readyState===1)remote.send(data,{binary});else queued.push([data,binary]);});
      remote.on('open',()=>{for(const [data,binary] of queued)remote.send(data,{binary});});
      remote.on('message',(data,binary)=>{if(client.readyState===1)client.send(data,{binary});});
      remote.on('close',()=>{upstreams.delete(remote);client.close();});
      remote.on('error',()=>client.close());client.on('error',()=>remote.terminate());
      client.on('close',()=>remote.terminate());
    });
    if(opts['shutdown-handshake-stall']==='1') {
      const net=require('net');const backendPort=proxyPort;
      handshakeProxy=net.createServer(socket=>{
        handshakeSockets.add(socket);socket.on('close',()=>handshakeSockets.delete(socket));
        socket.on('error',()=>socket.destroy());
        if(stallHandshake) {
          // Accept the TCP connection and consume its HTTP upgrade request,
          // but send no response: a real pending WebSocket handshake.
          socket.once('data',()=>stalledHandshakes++);return;
        }
        const backend=net.connect(backendPort,'127.0.0.1');handshakeSockets.add(backend);
        backend.on('close',()=>{handshakeSockets.delete(backend);socket.destroy();});
        backend.on('error',()=>socket.destroy());socket.on('close',()=>backend.destroy());
        socket.pipe(backend);backend.pipe(socket);
      });
      await new Promise(r=>handshakeProxy.listen(0,'127.0.0.1',r));
      proxyPort=handshakeProxy.address().port;
    }
  }
  const results=[];
  console.log('Artifacts:',run);
  try {
    for(const entry of (opts.cases||'auto:h264,software:h264,nvenc:h264,ffmpeg_nvenc:h264,qsv:h264,amf:h264,auto:vp9,auto:av1,auto:h265').split(',')) {
      blockedUntil=0;
      stallHandshake=false;
      if(sender && (sender.killed||sender.exitCode!==null)) {
        sender=launch(senderExe,senderArgs,'source-next-case');await sleep(2000);
      }
      const [encoder,codec]=entry.split(':');const name=encoder+'-'+codec;
      const controlPath=path.join(run,name+'-control.json');
      const stream='review'+crypto.randomBytes(10).toString('hex');
      const result={name,requested:{encoder,codec,width,height,fps},source:windowVideo?{
        type:'browser-window',video:windowVideo,browser:sourceBrowser.version(),
        sha256:crypto.createHash('sha256').update(fs.readFileSync(windowVideo)).digest('hex')
      }:{type:'spout'},stages:[]};results.push(result);
      console.log('Starting',name);
      const proc=launch(publisher,['--headless',`--stream=${stream}`,'--password=false',
        ...(windowVideo?['--source=window',`--window=${senderName}`]:['--source=spout',`--spout-sender=${senderName}`]),
        '--audio-source=default-output',`--width=${width}`,`--height=${height}`,`--fps=${fps}`,
        '--bitrate-kbps=4000',`--video-encoder=${encoder}`,`--video-codec=${codec}`,'--duration-ms=240000',
        ...(opts['video-controls']==='1'?['--remote-control']:[]),
        ...(opts['ffmpeg-options']?[`--ffmpeg-options=${opts['ffmpeg-options']}`]:[]),
        ...(proxyPort?[`--server=ws://127.0.0.1:${proxyPort}`]:[]),
        '--local-control','--local-control-port=0',`--local-control-discovery=${controlPath}`,
        `--diagnostics-out=${path.join(run,name+'-exit.json')}`],name,
        {LOCALAPPDATA:run,QT_PLUGIN_PATH:path.dirname(publisher),QT_QPA_PLATFORM_PLUGIN_PATH:path.join(path.dirname(publisher),'platforms')});
      let control,context,page;
      try {
        const deadline=Date.now()+25000;
        while(Date.now()<deadline) {
          if(proc.exitCode!==null)throw Error('Publisher exited '+proc.exitCode);
          if(fs.existsSync(controlPath)) {
            control=JSON.parse(fs.readFileSync(controlPath));
            const d=await api(control,'/diagnostics');
            if(d.app.live&&d.source.has_frame){result.startup=d;break;}
          }
          await sleep(300);
        }
        if(!result.startup)throw Error('Publisher never became live');
        context=await browser.newContext({viewport:{width:1280,height:800}});
        await context.addInitScript(()=>{
          window.reviewPCs=[];window.reviewChannels=[];const Original=window.RTCPeerConnection;
          window.RTCPeerConnection=new Proxy(Original,{construct(target,args){
            const pc=new target(...args);window.reviewPCs.push(pc);
            pc.addEventListener('datachannel',e=>window.reviewChannels.push(e.channel));
            const create=pc.createDataChannel.bind(pc);
            pc.createDataChannel=(...args)=>{const channel=create(...args);window.reviewChannels.push(channel);return channel;};
            return pc;
          }});
        });
        page=await context.newPage();
        await page.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput`,{waitUntil:'domcontentloaded',timeout:45000});
        result.initialConnectMs=await waitVideo(page);
        await sleep(2000);
        result.stages.push({name:'steady',metrics:await measure(page,15000)});
        result.audio=await audioProbe(page);result.motion=await motionProbe(page);
        if(opts['color-check']==='1') {
          result.colors=await colorProbe(page);
          result.colorMaxError=Math.max(...result.colors.map(c=>c.maxError));
          result.colorAccurate=result.colorMaxError<=4;
          console.log(name,'maximum RGB patch error',result.colorMaxError,'within 4 levels',result.colorAccurate);
        }
        await saveFrame(page,name+'-steady');
        if(sourcePage) {
          await sourcePage.evaluate(()=>document.querySelector('video').pause());await sleep(2500);
          result.browserPause={motion:await motionProbe(page)};
          await saveFrame(page,name+'-browser-paused');
          await sourcePage.evaluate(async()=>{const v=document.querySelector('video');v.currentTime=7;await v.play();});
          await sleep(2500);result.browserResume={motion:await motionProbe(page),metrics:await measure(page,8000)};
          await sourcePage.screenshot({path:path.join(run,name+'-source-browser.png')});
          if(result.browserPause.motion.moving||!result.browserResume.motion.moving)throw Error('Browser playback controls did not reach the receiver');
          console.log(name,'browser pause, seek and resume verified');
        }
        await page.reload({waitUntil:'domcontentloaded'});
        result.reloadRecoveryMs=await waitVideo(page);
        result.stages.push({name:'viewer-reload',metrics:await measure(page,8000)});
        result.refreshResponse=await api(control,'/commands',{command:'refresh_peer_transports'});
        await sleep(3000);await waitVideo(page);
        result.stages.push({name:'transport-refresh',metrics:await measure(page,8000)});
        if(opts['video-controls']==='1') {
          result.videoControls=[];
          for(const target of [{w:1280,h:720,f:Number(opts['control-fps']||30),bitrate:1000},{w:width,h:height,f:fps,bitrate:8000}]) {
            await page.evaluate(({target,remote})=>{
              const channel=window.reviewChannels.find(c=>c.readyState==='open');
              if(!channel)throw Error('No open receiver data channel');
              channel.send(JSON.stringify({action:'requestResolution',remote,value:{w:target.w,h:target.h,f:target.f}}));
            },{target,remote:stream});
            const deadline=Date.now()+30000;let ready=false;
            while(Date.now()<deadline) {
              const current=await stats(page);
              ready=current.some(m=>m.kind==='video'&&m.frameWidth===target.w&&m.frameHeight===target.h&&m.framesPerSecond>=target.f*.8);
              if(ready)break;await sleep(300);
            }
            if(!ready) {
              result.failedVideoControl={target,metrics:await measure(page,4000),diagnostics:await api(control,'/diagnostics')};
              throw Error('Runtime resolution/FPS change was not received: '+JSON.stringify(target));
            }
            await page.evaluate(({bitrate,remote})=>{
              window.reviewChannels.find(c=>c.readyState==='open').send(JSON.stringify({action:'bitrate',remote,value:bitrate}));
            },{bitrate:target.bitrate,remote:stream});
            await sleep(4000);
            const metrics=await measure(page,8000),motion=await motionProbe(page);
            const entry={target,metrics,motion,diagnostics:await api(control,'/diagnostics')};result.videoControls.push(entry);
            if(entry.diagnostics.video.configured_bitrate_kbps!==target.bitrate)throw Error('Runtime bitrate change was not applied');
            if(!motion.moving||!metrics.some(m=>m.kind==='video'&&m.width===target.w&&m.height===target.h&&m.fps>=target.f*.8&&m.fps<=target.f*1.15))
              throw Error('Runtime video controls did not preserve moving video at the requested format');
            if(!metrics.some(m=>m.kind==='audio'&&m.audioRms>.001))throw Error('Audio stopped during runtime video controls');
            if(opts['control-source-restart']==='1'&&result.videoControls.length===1) {
              sender.kill();await sleep(6000);
              sender=launch(senderExe,senderArgs,'source-during-controls');
              await sleep(5000);await waitVideo(page);
              entry.afterSourceRestart={metrics:await measure(page,8000),motion:await motionProbe(page)};
              if(!entry.afterSourceRestart.motion.moving||!entry.afterSourceRestart.metrics.some(m=>
                m.kind==='video'&&m.width===target.w&&m.height===target.h&&m.fps>=target.f*.8&&m.fps<=target.f*1.15))
                throw Error('Source restart lost the runtime video format or cadence');
              if(!entry.afterSourceRestart.metrics.some(m=>m.kind==='audio'&&m.audioRms>.001))
                throw Error('Audio stopped after source restart during runtime controls');
            }
          }
          result.stages.push({name:'after-video-controls',metrics:await measure(page,8000)});
        }
        if(opts['audio-controls']==='1') {
          result.audioControls=[];
          for(let cycle=0;cycle<2;cycle++) {
            const send=rate=>page.evaluate(rate=>{
              const channel=window.reviewChannels.find(c=>c.readyState==='open');
              if(!channel)throw Error('No open receiver data channel');
              channel.send(JSON.stringify({audioBitrate:rate}));
            },rate);
            await send(0);await sleep(2500);
            const muted=await measure(page,3000);
            if(muted.some(m=>m.kind==='audio'&&m.packetsReceived>0))throw Error('Audio packets continued after route mute');
            await send(-1);await sleep(2500);
            const resumed=await audioProbe(page);
            result.audioControls.push({muted,resumed});
            if(Math.abs(resumed.dominantHz-440)>10||resumed.rms<.001)throw Error('Audio did not resume with the expected tone');
            result.stages.push({name:'after-audio-unmute-'+(cycle+1),metrics:await measure(page,8000)});
          }
          tone.kill();await sleep(6000);
          result.silentAudio=await audioProbe(page);
          if(result.silentAudio.rms>.002)throw Error('Receiver retained sound after source stopped');
          tone=launch('powershell.exe',[...toneArgs,'-FrequencyHz','880'],'tone-restarted');
          await sleep(5000);result.restartedAudio=await audioProbe(page);
          if(Math.abs(result.restartedAudio.dominantHz-880)>10||result.restartedAudio.rms<.001)throw Error('Restarted audio source was not received');
          result.stages.push({name:'after-audio-source-restart',metrics:await measure(page,8000)});
          tone.kill();tone=launch('powershell.exe',toneArgs,'tone-restored');await sleep(2000);
        }
        if(opts.stress==='1') {
          const second=await context.newPage();
          await second.goto(page.url(),{waitUntil:'domcontentloaded',timeout:45000});
          await waitVideo(second);await sleep(2000);
          const both=await Promise.all([measure(page,8000),measure(second,8000)]);
          result.stages.push({name:'two-viewers-original',metrics:both[0]},
            {name:'two-viewers-new',metrics:both[1]});
          await second.close();await sleep(2000);
          result.stages.push({name:'after-second-viewer-leaves',metrics:await measure(page,8000)});
          result.encoderCrashes=[];
          for(let attempt=0;attempt<2;attempt++) {
            // Only terminate FFmpeg children of this harness-owned publisher.
            if(!Number.isInteger(proc.pid)||proc.exitCode!==null)throw Error('Publisher is not running');
            const command=`$encoders = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${proc.pid} AND Name = 'ffmpeg.exe'"); if ($encoders.Count -ne 1) { throw 'Expected one owned encoder process' }; $encoders | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.ProcessId }`;
            const killed=await execFileAsync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true});
            result.encoderCrashes.push({pid:Number(killed.stdout.trim())});
            await sleep(5000);await waitVideo(page);
            const motion=await motionProbe(page);
            result.encoderCrashes[attempt].motion=motion;
            if(!motion.moving)throw Error('Encoder recovery returned a frozen image');
            result.stages.push({name:'after-encoder-crash-'+(attempt+1),metrics:await measure(page,8000)});
          }
        }
        if(proxy) {
          const connectionsBefore=proxyConnections;
          blockedUntil=Date.now()+5000;
          for(const upstream of upstreams)upstream.terminate();
          const deadline=Date.now()+45000;
          while(proxyConnections<=connectionsBefore&&Date.now()<deadline)await sleep(300);
          result.signalingReconnected=proxyConnections>connectionsBefore;
          if(!result.signalingReconnected)throw Error('Publisher did not reconnect signaling');
          await page.reload({waitUntil:'domcontentloaded'});await waitVideo(page);
          result.stages.push({name:'after-signaling-outage',metrics:await measure(page,8000)});
          if(sender) {
            sender.kill();result.sourceOutage={metrics:await measure(page,6000)};
            sender=launch(senderExe,senderArgs,'source-restarted');
            await sleep(5000);await waitVideo(page);
            result.stages.push({name:'after-source-restart',metrics:await measure(page,8000)});
            result.restartedMotion=await motionProbe(page);
            await saveFrame(page,name+'-source-restarted');
          }
        }
        if(opts.observe==='1') {
          result.stages.push({name:'extended-recovery',metrics:await measure(page,30000)});
          result.extendedMotion=await motionProbe(page);
          if(!result.extendedMotion.moving)throw Error('Extended recovery returned a frozen image');
        }
        result.final=await api(control,'/diagnostics');
        if(opts['color-check']==='1') {
          result.finalColors=await colorProbe(page);
          result.colorMaxError=Math.max(result.colorMaxError,...result.finalColors.map(c=>c.maxError));
          result.colorAccurate=result.colorMaxError<=4;
          console.log(name,'initial + final maximum RGB patch error',result.colorMaxError);
        }
        result.receivedCodecs=[...new Set(result.stages.flatMap(s=>s.metrics)
          .filter(m=>m.kind==='video').map(m=>m.codec))];
        const expectedCodec={h264:'video/H264',h265:'video/H265',vp9:'video/VP9',av1:'video/AV1'}[codec];
        result.codecPreserved=result.receivedCodecs.every(c=>c===expectedCodec);
        result.fullRate=result.stages.every(s=>s.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.95));
        if(opts.resize==='1'&&(result.final.source.width!==1280||result.final.source.height!==960||result.final.source.resize_count<1)) {
          throw Error('Publisher did not observe the live source resize');
        }
        result.ok=result.motion.moving&&(!proxy||!sender||result.restartedMotion.moving)&&
          Math.abs(result.audio.dominantHz-440)<10&&result.audio.clippedSamples===0&&
          result.stages.every(s=>s.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.8&&m.width===width&&m.height===height)&&s.metrics.some(m=>m.kind==='audio'&&m.audioRms>.001));
        console.log(name,'delivery',result.ok,'full rate',result.fullRate,'encoder',result.final.video.active_encoder,'received codecs',result.receivedCodecs,
          'FPS',result.stages.map(s=>[s.name,s.metrics.find(m=>m.kind==='video')?.fps]));
      } catch(e) {result.error=String(e);result.ok=false;console.log(name,result.error);
        if(control)try{result.final=await api(control,'/diagnostics');}catch{}
        if(page)try{await page.screenshot({path:path.join(run,name+'-failure.png')});}catch{}
      } finally {
        if(opts['shutdown-source-loss']==='1') {sender.kill();await sleep(1500);}
        if(handshakeProxy) {
          const before=stalledHandshakes;stallHandshake=true;
          for(const upstream of upstreams)upstream.terminate();
          const deadline=Date.now()+3000;
          while(stalledHandshakes===before&&Date.now()<deadline)await sleep(50);
          result.handshakeStallObserved=stalledHandshakes>before;
          if(!result.handshakeStallObserved)result.ok=false;
        }
        if(opts['shutdown-signaling-loss']==='1'&&proxy) {
          blockedUntil=Date.now()+60000;
          for(const upstream of upstreams)upstream.terminate();
          await sleep(300);
        }
        const shutdownStarted=Date.now();
        if(proc.exitCode===null&&control)try{await api(control,'/commands',{command:'quit'});}catch(e){result.quitRequestError=String(e);}
        const deadline=shutdownStarted+10000;
        while(proc.exitCode===null&&proc.signalCode===null&&Date.now()<deadline)await sleep(100);
        result.shutdown={elapsedMs:Date.now()-shutdownStarted,exitCode:proc.exitCode,signal:proc.signalCode,
          forced:proc.exitCode===null&&proc.signalCode===null};
        if(result.shutdown.forced)proc.kill();
        if(result.shutdown.forced||result.shutdown.exitCode!==0)result.ok=false;
        if(context)await context.close();
        try {
          if(!Number.isInteger(proc.pid))throw Error('Publisher has no process ID');
          const remaining=await execFileAsync('powershell.exe',['-NoProfile','-Command',
            `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${proc.pid} AND Name = 'ffmpeg.exe'").Count`],{windowsHide:true,timeout:5000});
          result.shutdown.remainingEncoders=Number(remaining.stdout.trim());
        } catch(e) {result.shutdown.inspectionError=String(e);}
        if(result.shutdown.remainingEncoders!==0)result.ok=false;
        console.log(name,'shutdown',result.shutdown,'overall',result.ok);
        const exitPath=path.join(run,name+'-exit.json');
        if(fs.existsSync(exitPath))try{result.exitDiagnostics=JSON.parse(fs.readFileSync(exitPath));}catch{}
        fs.writeFileSync(path.join(run,'results.json'),JSON.stringify({publisher,sha256:crypto.createHash('sha256').update(fs.readFileSync(publisher)).digest('hex'),browser:browser.version(),results},null,2));
      }
    }
  } finally {await browser.close();if(sourceBrowser)await sourceBrowser.close();for(const child of children)child.kill();
    for(const socket of handshakeSockets)socket.destroy();if(handshakeProxy)handshakeProxy.close();
    if(proxy){for(const client of proxy.clients)client.terminate();for(const upstream of upstreams)upstream.terminate();proxy.close();}}
  if(results.some(r=>!r.ok))process.exitCode=1;
}
main().catch(async e=>{console.error(e);for(const child of children)child.kill();
  await Promise.allSettled([...browsers].map(browser=>browser.close()));process.exitCode=1;});
