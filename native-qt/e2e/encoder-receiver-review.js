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
const frameIdentity = require('./frame-identity');
const opts = Object.fromEntries(process.argv.slice(2).map(s => { const i=s.indexOf('='); return [s.slice(2,i),s.slice(i+1)]; }));
const captureCadenceMin=Number(opts['capture-cadence-min']||0.8);
if(!(captureCadenceMin>0&&captureCadenceMin<=1))throw Error('Capture cadence minimum must be in (0,1]');
const bitrateCeilingRatio=Number(opts['bitrate-ceiling-ratio']||0);
if(!Number.isFinite(bitrateCeilingRatio)||bitrateCeilingRatio<0||
  (bitrateCeilingRatio>0&&bitrateCeilingRatio<1))throw Error('Bitrate ceiling ratio must be zero (disabled) or at least one');
const publisher = path.resolve(opts.publisher);
const senderExe = opts.sender ? path.resolve(opts.sender) : null;
const windowVideo = opts['window-video'] ? path.resolve(opts['window-video']) : null;
if(opts['frame-identity']==='1'&&!windowVideo)throw Error('Frame identity requires --window-video');
if(opts['handover-identity']==='1'&&opts['frame-identity']!=='1')throw Error('Handover identity requires --frame-identity=1');
if(opts['identity-recording']==='1'&&opts['frame-identity']!=='1')throw Error('Identity recording requires --frame-identity=1');
if(opts.sustained==='1'&&(!windowVideo||opts['frame-identity']!=='1'||opts.faults!=='1'||
  !(Number(opts['packet-loss'])>0)||!(Number(opts['soak-ms'])>=60000)))
  throw Error('Sustained review requires browser frame identities, faults, packet loss and at least 60 seconds');
if(opts['obs-cadence']==='1'&&(!opts['obs-plugin-repo']||opts['video-controls']!=='1'))throw Error('OBS cadence requires the OBS runtime and --video-controls=1');
if((opts['native-loss']||opts['obs-half-opacity']==='1')&&(!opts['obs-plugin-repo']||opts.faults!=='1'))
  throw Error('Native loss/half-opacity review requires OBS and faults');
if(opts['native-loss']&&!(Number.isInteger(Number(opts['native-loss']))&&Number(opts['native-loss'])>0&&Number(opts['native-loss'])<=100))
  throw Error('Native loss percent must be an integer from 1 to 100');
if(opts['obs-half-opacity']==='1'&&opts['obs-alpha']==='0')throw Error('Half-opacity review requires OBS alpha');
if(opts['obs-plugin-repo']&&(!senderExe||opts['color-check']==='1'))throw Error('OBS alpha runtime requires the moving Spout fixture');
if (!senderExe && !windowVideo) throw Error('--sender or --window-video is required');
if (windowVideo && ['resize','color-check','control-source-restart','shutdown-source-loss'].some(k=>opts[k]==='1'))
  throw Error('Spout fixture options cannot be used with --window-video');
const run = path.resolve(opts.reports, crypto.randomUUID());
fs.mkdirSync(run,{recursive:true});
if (!fs.existsSync(path.join(path.dirname(publisher),'platforms/qwindows.dll'))) throw Error('Complete package required');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const children = new Set();
const browsers = new Set();
const fixtureServers = new Set();
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
    if(last.some(s=>s.kind==='video'&&s.framesDecoded>15&&s.framesPerSecond>0)&&
      await page.evaluate(()=>[...document.querySelectorAll('video')].some(v=>v.videoWidth>0&&!v.paused&&v.readyState>=2)))
      return Date.now()-start;
    await sleep(300);
  }
  throw Error('No playing video element with advancing decoded video: '+JSON.stringify(last));
}
async function refreshTransport(control,page) {
  const before=await api(control,'/diagnostics'),started=Date.now();
  const response=await api(control,'/commands',{command:'refresh_peer_transports'});
  let after;
  while(Date.now()-started<45000) {
    after=await api(control,'/diagnostics');
    // A rebuild intentionally rotates the wire session. Match the logical peer
    // by UUID and creation time, then require its transport generation to grow.
    if(after.peers.some(peer=>before.peers.some(old=>old.uuid===peer.uuid&&old.created_steady_ms===peer.created_steady_ms&&
      peer.signaling.client_transport_generation>old.signaling.client_transport_generation)&&
      peer.last_connection_state==='connected'&&peer.media.last_observed_video_track_active)) {
      await waitVideo(page);
      return {response,before,after,recoveredMs:Date.now()-started};
    }
    await sleep(300);
  }
  throw Error('Transport refresh did not reconnect a new transport generation');
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
      nackCount:delta('nackCount'),pliCount:delta('pliCount'),keyFramesDecoded:delta('keyFramesDecoded'),
      freezeCount:delta('freezeCount'),freezeSeconds:delta('totalFreezesDuration'),
      jitter:b.jitter,decodeMs:delta('totalDecodeTime')*1000/Math.max(1,delta('framesDecoded')),
      jitterBufferMs:delta('jitterBufferDelay')*1000/Math.max(1,delta('jitterBufferEmittedCount')),
      processingMs:b.kind==='video'?delta('totalProcessingDelay')*1000/Math.max(1,delta('framesDecoded')):null,
      audioRms:Math.sqrt(Math.max(0,delta('totalAudioEnergy'))/Math.max(.001,delta('totalSamplesDuration'))),
      concealedSamples:delta('concealedSamples'),totalSamples:delta('totalSamplesReceived')};
  });
}
async function identityProbe(page,source,ms) {
  const before=await stats(page),sourceBefore=await source.evaluate(()=>window.reviewIdentity);
  const result=await frameIdentity.probe(page,ms);
  const after=await stats(page);result.sourceBefore=sourceBefore;result.sourceAfter=await source.evaluate(()=>window.reviewIdentity);
  result.receiver=after.filter(b=>b.kind==='video').map(b=>{
    const a=before.find(x=>x.id===b.id);if(!a)return {changedStream:true};
    return {seconds:(b.timestamp-a.timestamp)/1000,framesDecoded:b.framesDecoded-a.framesDecoded,
      framesDropped:(b.framesDropped||0)-(a.framesDropped||0),freezeCount:(b.freezeCount||0)-(a.freezeCount||0)};
  });
  return result;
}
function requireReadableIdentity(result) {
  if(result.error||!(result.callbacks>0&&result.unique>0)||result.invalid/result.callbacks>.01)
    throw Error('Source frame identity was unavailable or unreliable');
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
  const fixtureDuration=Math.max(1800000,(600000+Number(opts['soak-ms']||0)*2+Number(opts['control-cycles']||1)*60000)*
    (opts.cases||'auto:h264,software:h264,nvenc:h264,ffmpeg_nvenc:h264,qsv:h264,amf:h264,auto:vp9,auto:av1,auto:h265').split(',').length);
  const senderName='ReceiverReview_'+crypto.randomUUID().replaceAll('-','');
  const senderArgs=[`--name=${senderName}`,`--width=${width}`,`--height=${height}`,`--fps=${Number(opts['source-fps']||fps)}`,`--pattern=${opts['obs-plugin-repo']?'alpha-moving-edge':opts['color-check']==='1'?'color-bars':'animated'}`,`--duration-ms=${fixtureDuration}`];
  if(opts.resize==='1')senderArgs.push('--resize-after-ms=20000','--resize-width=1280','--resize-height=960');
  if(opts['frame-trace']==='1')senderArgs.push(`--frame-trace=${path.join(run,'source-frames.csv')}`);
  if(opts['source-precise-pacing']==='0')senderArgs.push('--precise-pacing=0');
  let sourceBrowser,sourcePage,sourceFixture;
  let sender=windowVideo?null:launch(senderExe,senderArgs,'source');
  if(windowVideo) {
    let playbackVideo=windowVideo;
    if(opts['frame-identity']==='1') {
      playbackVideo=path.join(run,'source-frame-ids.webm');
      await frameIdentity.makeClip(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'),windowVideo,playbackVideo,Number(opts['source-fps']||fps));
      sourceFixture={video:playbackVideo,sha256:crypto.createHash('sha256').update(fs.readFileSync(playbackVideo)).digest('hex'),
        frameIds:'embedded-12-bit-with-complement',fps:Number(opts['source-fps']||fps),seconds:20};
    }
    const html=path.join(run,'browser-source.html');
    fs.writeFileSync(html,`<!doctype html><title>${senderName}</title><style>html,body{margin:0;background:black;overflow:hidden}video{width:100vw;height:100vh;object-fit:contain}</style><video autoplay loop muted src="/video"></video>`);
    if(opts['frame-identity']==='1')fs.appendFileSync(html,frameIdentity.sourceScript);
    const fixtureServer=await require('./browser-fixture-server').start(html,playbackVideo);
    fixtureServers.add(fixtureServer);
    sourceBrowser=await chromium.launch({headless:false,args:[`--window-size=${width},${height+120}`,'--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    browsers.add(sourceBrowser);
    // WGC captures the physical window, not Playwright's emulated viewport.
    // Let responsive layout follow the real client area when Windows constrains
    // the requested size to the current desktop; otherwise the marker is clipped.
    const sourceContext=await sourceBrowser.newContext({viewport:null});
    sourcePage=await sourceContext.newPage();await sourcePage.goto(fixtureServer.url);
    await sourcePage.waitForFunction(()=>document.querySelector('video').currentTime>1);
  }
  const toneArgs=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'audio-test-tone.ps1'),'-DurationMs',String(fixtureDuration),'-Amplitude','0.08'];
  let tone=launch('powershell.exe',toneArgs,'tone');
  await sleep(2500);
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  browsers.add(browser);
  let proxy, proxyPort, blockedUntil=0, proxyConnections=0;
  const udpRelay=opts['native-loss']?require('./udp-loss-relay').create():null;
  let relayError;
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
      let outgoing=Promise.resolve(),incoming=Promise.resolve();
      const failed=e=>{relayError=String(e);client.terminate();remote.terminate();};
      client.on('message',(data,binary)=>{outgoing=outgoing.then(async()=>{
        if(udpRelay){data=await udpRelay.transform(data,true);binary=false;if(data===null)return;}
        if(remote.readyState===1)remote.send(data,{binary});else queued.push([data,binary]);
      }).catch(failed);});
      remote.on('open',()=>{for(const [data,binary] of queued)remote.send(data,{binary});});
      remote.on('message',(data,binary)=>{incoming=incoming.then(async()=>{
        if(udpRelay){data=await udpRelay.transform(data,false);binary=false;if(data===null)return;}
        if(client.readyState===1)client.send(data,{binary});
      }).catch(failed);});
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
      if(sourcePage)await sourcePage.evaluate(async()=>{
        const video=document.querySelector('video');if(video.paused)await video.play();
      });
      const [encoder,codec]=entry.split(':');const name=encoder+'-'+codec;
      const controlPath=path.join(run,name+'-control.json');
      const stream='review'+crypto.randomBytes(10).toString('hex');
      const result={name,startedAt:new Date().toISOString(),requested:{encoder,codec,width,height,fps},source:windowVideo?{
        type:'browser-window',video:windowVideo,browser:sourceBrowser.version(),
        ...(sourceFixture?{fixture:sourceFixture}:{}),
        sha256:crypto.createHash('sha256').update(fs.readFileSync(windowVideo)).digest('hex')
      }:{type:'spout',sender:senderExe,sha256:crypto.createHash('sha256').update(fs.readFileSync(senderExe)).digest('hex'),
        requestedFps:Number(opts['source-fps']||fps),precisePacing:opts['source-precise-pacing']!=='0'},stages:[]};results.push(result);
      if(sourcePage)result.source.geometry=await sourcePage.evaluate(()=>({
        innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,
        screenWidth:screen.width,screenHeight:screen.height,
        video:document.querySelector('video').getBoundingClientRect().toJSON()}));
      console.log('Starting',name);
      const proc=launch(publisher,['--headless',`--stream=${stream}`,'--password=false',
        ...(windowVideo?['--source=window',`--window=${senderName}`]:['--source=spout',`--spout-sender=${senderName}`]),
        '--audio-source=default-output',`--width=${width}`,`--height=${height}`,`--fps=${fps}`,
        '--bitrate-kbps=4000',`--video-encoder=${encoder}`,`--video-codec=${codec}`,`--duration-ms=${600000+Number(opts['soak-ms']||0)*2+Number(opts['control-cycles']||1)*60000}`,
        ...(['video-controls','replacement-failure','rapid-controls','shutdown-preparation','session-pressure'].some(k=>opts[k]==='1')?['--remote-control']:[]),
        ...(opts['obs-plugin-repo']&&opts['obs-alpha']!=='0'?['--alpha-workflow']:[]),
        ...(opts['ffmpeg-options']?[`--ffmpeg-options=${opts['ffmpeg-options']}`]:[]),
        ...(proxyPort?[`--server=ws://127.0.0.1:${proxyPort}`]:[]),
        '--local-control','--local-control-port=0',`--local-control-discovery=${controlPath}`,
        `--diagnostics-out=${path.join(run,name+'-exit.json')}`],name,
        {LOCALAPPDATA:run,QT_PLUGIN_PATH:path.dirname(publisher),QT_QPA_PLATFORM_PLUGIN_PATH:path.join(path.dirname(publisher),'platforms'),
          ...(opts['frame-trace']==='1'?{VERSUS_FRAME_TRACE:path.join(run,name+'-frames.csv'),
            ...(opts['obs-plugin-repo']?{VERSUS_FRAME_TRACE_PATTERN:'alpha-moving-edge'}:{})}:{})});
      let control,context,page,lossCdp,obsAlpha;
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
          window.reviewPCs=[];window.reviewChannels=[];
          const Original=window.RTCPeerConnection;
          window.RTCPeerConnection=new Proxy(Original,{construct(target,args){
            const pc=new target(...args);window.reviewPCs.push(pc);
            pc.addEventListener('datachannel',e=>window.reviewChannels.push(e.channel));
            const create=pc.createDataChannel.bind(pc);
            pc.createDataChannel=(...args)=>{const channel=create(...args);window.reviewChannels.push(channel);return channel;};
            return pc;
          }});
        });
        page=await context.newPage();
        if(Number(opts['packet-loss']||0)>0) {
          lossCdp=await context.newCDPSession(page);
          await lossCdp.send('Network.enable');
          // Chromium binds the P2P interceptor when a socket is created.
          // Install its zero-loss profile before the viewer creates WebRTC.
          await lossCdp.send('Network.emulateNetworkConditionsByRule',{offline:false,
            matchedNetworkConditions:[{urlPattern:'',latency:1,downloadThroughput:-1,
              uploadThroughput:-1,packetLoss:0}]});
        }
        await page.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput`,{waitUntil:'domcontentloaded',timeout:45000});
        result.initialConnectMs=await waitVideo(page);
        await sleep(2000);
        const steadyBefore=await api(control,'/diagnostics');
        result.stages.push({name:'steady',metrics:await measure(page,15000)});
        const steadyAfter=await api(control,'/diagnostics');
        result.initialCapture={before:steadyBefore,after:steadyAfter,
          fps:(steadyAfter.video.frames_captured-steadyBefore.video.frames_captured)*1000/(steadyAfter.generated_steady_ms-steadyBefore.generated_steady_ms)};
        console.log(name,'initial fresh capture FPS',result.initialCapture.fps);
        if(opts['capture-cadence']==='1'&&!(result.initialCapture.fps>=fps*captureCadenceMin))throw Error('Initial fresh capture cadence below requested minimum');
        result.audio=await audioProbe(page);result.motion=await motionProbe(page);
        if(opts['frame-identity']==='1') {
          result.initialIdentity=await identityProbe(page,sourcePage,10000);
          console.log(name,'initial unique observed FPS',result.initialIdentity.uniqueObservedFps,'invalid',result.initialIdentity.invalid);
          requireReadableIdentity(result.initialIdentity);
        }
        if(opts['identity-recording']==='1') {
          const recording=require('./identity-recording');
          const clips=await Promise.all([
            recording.record(sourcePage,path.join(run,name+'-source.webm'),10000,true),
            recording.record(page,path.join(run,name+'-receiver.webm'),10000)]);
          result.identityRecording={before:clips[1].before,after:clips[1].after,source:clips[0],receiver:clips[1]};
          // Decode sequentially, after recording, to avoid measurement load.
          for(let i=0;i<clips.length;i++) {
            const evidence=await recording.analyze(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'),clips[i]);
            result.identityRecording[i?'receiver':'source']=evidence;
            if(evidence.invalid||!evidence.frames)throw Error('Recording identities could not be decoded');
            console.log(name,i?'receiver recording':'source recording',evidence.framesPerSecond,'FPS',evidence.changesPerSecond,'distinct changes/sec');
          }
          const decoded=clips[1].after.reduce((sum,r)=>{
            const before=clips[1].before.find(b=>b.id===r.id);
            if(!before)throw Error('Receiver changed during identity recording');
            return sum+r.framesDecoded-before.framesDecoded;
          },0);
          result.identityRecording.coverage=result.identityRecording.receiver.frames/decoded;
          if(!decoded||result.identityRecording.coverage<.98||result.identityRecording.coverage>1.02)
            throw Error('Recording frame count does not cover the receiver decoding window');
        }
        if(opts['color-check']==='1') {
          result.colors=await colorProbe(page);
          result.colorMaxError=Math.max(...result.colors.map(c=>c.maxError));
          result.colorAccurate=result.colorMaxError<=4;
          console.log(name,'maximum RGB patch error',result.colorMaxError,'within 4 levels',result.colorAccurate);
        }
        await saveFrame(page,name+'-steady');
        if(sourcePage) {
          await sourcePage.evaluate(()=>document.querySelector('video').pause());await sleep(2500);
          result.browserPause={motion:await motionProbe(page),metrics:await measure(page,4000)};
          await saveFrame(page,name+'-browser-paused');
          await sourcePage.evaluate(async()=>{const v=document.querySelector('video');v.currentTime=7;await v.play();});
          await sleep(2500);result.browserResume={motion:await motionProbe(page),metrics:await measure(page,8000)};
          await sourcePage.screenshot({path:path.join(run,name+'-source-browser.png')});
          if(result.browserPause.motion.moving||!result.browserResume.motion.moving||
            !result.browserPause.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.95))throw Error('Browser playback controls did not preserve the paused stream or resume motion');
          console.log(name,'browser pause, seek and resume verified');
          if(opts['window-resize']==='1') {
            const session=await sourcePage.context().newCDPSession(sourcePage);
            const original=await session.send('Browser.getWindowForTarget');
            result.windowResizes=[];
            try {
              for(const bounds of [{width:960,height:640},original.bounds]) {
                await session.send('Browser.setWindowBounds',{windowId:original.windowId,bounds});
                await sleep(4000);await waitVideo(page);
                const actual=await session.send('Browser.getWindowBounds',{windowId:original.windowId});
                const entry={requested:bounds,actual:actual.bounds,motion:await motionProbe(page),metrics:await measure(page,8000),diagnostics:await api(control,'/diagnostics')};
                result.windowResizes.push(entry);
                if(actual.bounds.width!==bounds.width||actual.bounds.height!==bounds.height||!entry.motion.moving||
                  !entry.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.8&&m.width===width&&m.height===height))
                  throw Error('Live browser resize did not preserve moving output');
              }
            } finally {await session.send('Browser.setWindowBounds',{windowId:original.windowId,bounds:original.bounds});await session.detach();}
            console.log(name,'live browser resize and restore verified');
          }
        }
        await page.reload({waitUntil:'domcontentloaded'});
        result.reloadRecoveryMs=await waitVideo(page);
        result.stages.push({name:'viewer-reload',metrics:await measure(page,8000)});
        result.transportRefresh=await refreshTransport(control,page);
        result.refreshResponse=result.transportRefresh.response;
        await sleep(2000);
        result.stages.push({name:'transport-refresh',metrics:await measure(page,8000)});
        if(opts['obs-plugin-repo']) {
          const previousRelayPeers=new Set(udpRelay?.snapshot().map(r=>r.uuid));
          obsAlpha=await require('./obs-alpha-runtime').start({repo:opts['obs-plugin-repo'],stream,output:path.join(run,name+'-obs'),
            expectedPluginHash:opts['expected-plugin-sha256'],width,height,fps:opts['obs-cadence']==='1'?fps:undefined,
            alpha:opts['obs-alpha']!=='0',cadenceMinimum:Number(opts['obs-cadence-min']||.95)});
          result.obsAlpha=obsAlpha.evidence;
          await obsAlpha.sample('initial');
          if(udpRelay) {
            result.nativeRelayPeers=[...new Set(udpRelay.snapshot().filter(r=>!previousRelayPeers.has(r.uuid)&&r.rtp>0).map(r=>r.uuid))];
            if(!result.nativeRelayPeers.length)throw Error('Native OBS media did not traverse the UDP relay');
          }
          result.obsObserverBeforeReload=await page.evaluate(()=>({visibility:document.visibilityState,
            videos:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,readyState:v.readyState,paused:v.paused}))}));
          // Exercise browser reattachment with the native alpha viewer present.
          await page.reload({waitUntil:'domcontentloaded'});await waitVideo(page);
          result.obsObserverAudio=await audioProbe(page);
        }
        if(opts['video-controls']==='1') {
          result.videoControls=[];
          const targets=Array.from({length:Number(opts['control-cycles']||1)},()=>[{w:Number(opts['control-width']||1280),h:Number(opts['control-height']||720),f:Number(opts['control-fps']||30),bitrate:1000},{w:width,h:height,f:fps,bitrate:8000}]).flat();
          for(const target of targets) {
            if(opts['presentation-trace']==='1')await require('./presentation-trace').start(page);
            const transitionIdentity=opts['handover-identity']==='1'?frameIdentity.probe(page,18000):null;
            const transitionBefore=await stats(page);
            const combined=opts['combined-video-controls']==='1'||
              (opts['combined-video-controls']==='alternate'&&Math.floor(result.videoControls.length/2)%2===1);
            await page.evaluate(({target,remote,combined})=>{
              const channel=window.reviewChannels.find(c=>c.readyState==='open');
              if(!channel)throw Error('No open receiver data channel');
              channel.send(JSON.stringify({action:'requestResolution',remote,value:{w:target.w,h:target.h,f:target.f},
                ...(combined?{targetBitrate:target.bitrate}:{})}));
            },{target,remote:stream,combined});
            const deadline=Date.now()+30000;let ready=false;
            while(Date.now()<deadline) {
              const current=await stats(page);
              ready=current.some(m=>m.kind==='video'&&m.frameWidth===target.w&&m.frameHeight===target.h&&
                m.framesPerSecond>=target.f*.8&&m.framesPerSecond<=target.f*1.15);
              if(ready)break;await sleep(300);
            }
            if(!ready) {
              result.failedVideoControl={target,metrics:await measure(page,4000),diagnostics:await api(control,'/diagnostics')};
              throw Error('Runtime resolution/FPS change was not received: '+JSON.stringify(target));
            }
            if(!combined)await page.evaluate(({bitrate,remote})=>{
              window.reviewChannels.find(c=>c.readyState==='open').send(JSON.stringify({action:'bitrate',remote,value:bitrate}));
            },{bitrate:target.bitrate,remote:stream});
            await sleep(4000);
            const captureBefore=await api(control,'/diagnostics');
            const sourceBefore=sourcePage?await sourcePage.evaluate(()=>{
              const q=document.querySelector('video').getVideoPlaybackQuality();
              return {at:performance.now(),total:q.totalVideoFrames,dropped:q.droppedVideoFrames};
            }):null;
            const metrics=await measure(page,8000),motion=await motionProbe(page);
            const entry={target,combined,metrics,motion,transitionBefore,transitionAfter:await stats(page),diagnostics:await api(control,'/diagnostics')};result.videoControls.push(entry);
            if(opts['presentation-trace']==='1')entry.presentation=await require('./presentation-trace').stop(page);
            if(transitionIdentity) {
              entry.transitionIdentity=await transitionIdentity;requireReadableIdentity(entry.transitionIdentity);
              let previous=null;entry.transitionIdentity.backwardIds=[];
              for(const row of entry.transitionIdentity.rows)if(row.id!==null) {
                if(previous!==null&&(row.id-previous+fps*20)%(fps*20)>fps*5)
                  entry.transitionIdentity.backwardIds.push({previous,current:row.id,at:row.at});
                previous=row.id;
              }
              if(entry.transitionIdentity.backwardIds.length)throw Error('Source frame identity moved backward during handover');
            }
            entry.transition=entry.transitionAfter.map(after=>{
              const before=transitionBefore.find(x=>x.id===after.id);
              if(!before)return {kind:after.kind,changedStream:true};
              const delta=k=>Number.isFinite(after[k])&&Number.isFinite(before[k])?after[k]-before[k]:null;
              return {kind:after.kind,seconds:(after.timestamp-before.timestamp)/1000,
                framesDropped:delta('framesDropped'),freezeCount:delta('freezeCount'),
                freezeSeconds:delta('totalFreezesDuration'),concealedSamples:delta('concealedSamples'),
                samplesReceived:delta('totalSamplesReceived'),packetsLost:delta('packetsLost')};
            });
            entry.captureBefore=captureBefore;
            if(sourcePage) {
              const after=await sourcePage.evaluate(()=>{
                const q=document.querySelector('video').getVideoPlaybackQuality();
                return {at:performance.now(),total:q.totalVideoFrames,dropped:q.droppedVideoFrames};
              });
              entry.sourcePlayback={before:sourceBefore,after,
                presentedFps:((after.total-after.dropped)-(sourceBefore.total-sourceBefore.dropped))*1000/(after.at-sourceBefore.at)};
            }
            const captureSeconds=(entry.diagnostics.generated_steady_ms-captureBefore.generated_steady_ms)/1000;
            entry.captureFps=(entry.diagnostics.video.frames_captured-captureBefore.video.frames_captured)/captureSeconds;
            console.log(name,'runtime target FPS',target.f,'fresh capture FPS',entry.captureFps);
            entry.captureFullRate=entry.captureFps>=target.f*.95;
            if(opts['capture-cadence']==='1'&&!(entry.captureFps>=target.f*captureCadenceMin))throw Error('Fresh capture cadence did not follow runtime FPS');
            if(entry.diagnostics.video.configured_bitrate_kbps!==target.bitrate)throw Error('Runtime bitrate change was not applied');
            if(obsAlpha)await obsAlpha.sample('control-'+result.videoControls.length);
            if(!motion.moving||!metrics.some(m=>m.kind==='video'&&m.width===target.w&&m.height===target.h&&m.fps>=target.f*.8&&m.fps<=target.f*1.15))
              throw Error('Runtime video controls did not preserve moving video at the requested format');
            if(!metrics.some(m=>m.kind==='audio'&&m.audioRms>.001))throw Error('Audio stopped during runtime video controls');
            if(opts['frame-identity']==='1') {
              entry.identity=await identityProbe(page,sourcePage,10000);
              console.log(name,'target',target.f,'unique observed FPS',entry.identity.uniqueObservedFps,'missed callbacks',entry.identity.missedCallbacks);
              requireReadableIdentity(entry.identity);
            }
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
          if(obsAlpha) {
            result.obsTransportRefresh=await refreshTransport(control,page);
            await obsAlpha.sample('transport-refresh');
            result.stages.push({name:'obs-transport-refresh',metrics:await measure(page,8000)});
            if(!(await motionProbe(page)).moving)throw Error('Browser lost moving video after OBS transport refresh');
            if(opts['obs-cadence']==='1')await obsAlpha.recordCadence(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'));
          }
        }
        if(opts['obs-half-opacity']==='1') {
          sender.kill();await sleep(2000);
          sender=launch(senderExe,senderArgs.map(a=>a.startsWith('--pattern=')?'--pattern=alpha-half':a),'source-half');
          await sleep(4000);await obsAlpha.sample('half-opacity','alpha-half');
          await refreshTransport(control,page);await obsAlpha.sample('half-opacity-refresh','alpha-half');
          sender.kill();await sleep(2000);sender=launch(senderExe,senderArgs,'source-moving-restored');
          await sleep(4000);await waitVideo(page);await obsAlpha.sample('moving-restored');
          if(!(await motionProbe(page)).moving)throw Error('Moving source did not recover after half-opacity review');
        }
        if(udpRelay) {
          if(relayError)throw Error(relayError);
          const before=udpRelay.snapshot();udpRelay.setLoss(Number(opts['native-loss']));
          result.nativePacketLoss={percent:Number(opts['native-loss']),before};
          try {result.nativePacketLoss.browserMetrics=await measure(page,12000);}
          finally {udpRelay.setLoss(0);result.nativePacketLoss.after=udpRelay.snapshot();}
          if(relayError||result.nativePacketLoss.after.some(r=>r.errors.length))throw Error('UDP relay failed: '+
            (relayError||JSON.stringify(result.nativePacketLoss.after.filter(r=>r.errors.length))));
          const native=result.nativePacketLoss.after.filter(r=>result.nativeRelayPeers.includes(r.uuid));
          result.nativePacketLoss.nativeDropped=native.reduce((n,r)=>n+r.dropped-(before.find(b=>b.uuid===r.uuid&&b.session===r.session&&b.relayPort===r.relayPort)?.dropped||0),0);
          if(!result.nativePacketLoss.nativeDropped)throw Error('No native OBS RTP packets were dropped');
          await sleep(6000);await obsAlpha.sample('native-packet-loss-recovery');
          if(opts['obs-cadence']==='1')await obsAlpha.recordCadence(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'));
          result.nativePacketLoss.recovery=await measure(page,8000);
          if(!result.nativePacketLoss.recovery.some(m=>m.kind==='video'&&m.fps>=fps*.95)||
            !result.nativePacketLoss.recovery.some(m=>m.kind==='audio'&&m.audioRms>.001))throw Error('Native-loss workflow did not recover video/audio');
          console.log(name,'native OBS RTP drops',result.nativePacketLoss.nativeDropped,'recovered');
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
        if(Number(opts['packet-loss']||0)>0) {
          const percent=Number(opts['packet-loss']);
          if(!Number.isFinite(percent)||percent>100)throw Error('packet-loss must be in (0,100]');
          const cdp=lossCdp;
          result.packetLoss={percent,baselineEmulatedLatencyMs:1};
          try {
            await cdp.send('Network.enable');
            // The empty URL pattern applies CDP's documented WebRTC packet
            // loss emulation to this receiver's P2P connections as well.
            await cdp.send('Network.emulateNetworkConditionsByRule',{offline:false,
              matchedNetworkConditions:[{urlPattern:'',latency:0,downloadThroughput:-1,
                uploadThroughput:-1,packetLoss:percent}]});
            result.packetLoss.metrics=await measure(page,12000);
          } finally {
            try {await cdp.send('Network.emulateNetworkConditionsByRule',{
              offline:false,matchedNetworkConditions:opts.sustained==='1'?
                [{urlPattern:'',latency:1,downloadThroughput:-1,uploadThroughput:-1,packetLoss:0}]:[]});}
            finally {if(opts.sustained!=='1'){await cdp.detach();lossCdp=null;}}
          }
          // packetsLost is a net estimate: successful retransmission can bring
          // it back to zero. Receiver NACKs also prove missing video packets.
          result.packetLoss.observed=result.packetLoss.metrics.some(m=>
            m.kind==='video'&&(m.packetsLost>0||m.nackCount>0));
          if(!result.packetLoss.observed)throw Error('Requested WebRTC packet loss was not observed');
          await sleep(4000);
          result.packetLoss.recovery={metrics:await measure(page,8000),motion:await motionProbe(page)};
          if(!result.packetLoss.recovery.motion.moving||
            !result.packetLoss.recovery.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.95)||
            !result.packetLoss.recovery.metrics.some(m=>m.kind==='audio'&&m.audioRms>.001))
            throw Error('Full-rate moving video and audio did not recover after packet loss');
          console.log(name,'packet loss observed; moving full-rate video and audio recovered');
          if(obsAlpha)await obsAlpha.sample('browser-packet-loss-recovery');
        }
        if(opts['rapid-controls']==='1') {
          const burstStarted=Date.now();
          const targets=Array.from({length:3},()=>[
            {w:640,h:360,f:30,targetBitrate:1000},
            {w:960,h:540,f:45,targetBitrate:2500},
            {w:640,h:360,f:30,targetBitrate:1200},
            {w:width,h:height,f:fps,targetBitrate:8000}]).flat();
          const during=measure(page,8000);
          for(const target of targets) {
            await page.evaluate(({remote,target})=>{
              window.reviewChannels.find(c=>c.readyState==='open').send(JSON.stringify({
                action:'requestResolution',remote,value:{w:target.w,h:target.h,f:target.f},targetBitrate:target.targetBitrate}));
            },{remote:stream,target});
            await sleep(60);
          }
          result.rapidControls={targets,during:await during};
          let ready=false;const deadline=Date.now()+30000;
          while(Date.now()<deadline) {
            const d=await api(control,'/diagnostics'),s=await stats(page);
            ready=d.peer_operation_executor.queued_ordinary===0&&d.peer_operation_executor.in_flight===0&&
              d.video.configured_bitrate_kbps===8000&&d.video.configured_fps===fps&&
              s.some(m=>m.kind==='video'&&m.frameWidth===width&&m.frameHeight===height&&m.framesPerSecond>=fps*.8);
            if(ready)break;await sleep(300);
          }
          if(!ready)throw Error('Rapid controls did not settle on the last requested format and bitrate');
          result.rapidControls.settledMs=Date.now()-burstStarted;
          result.rapidControls.settledDiagnostics=await api(control,'/diagnostics');
          result.rapidControls.motion=await motionProbe(page);
          if(!result.rapidControls.motion.moving)throw Error('Rapid controls left a frozen image');
          result.stages.push({name:'after-rapid-controls',metrics:await measure(page,8000)});
        }
        if(opts['session-pressure']==='1') {
          if(encoder!=='nvenc'||codec!=='h264')throw Error('Session pressure currently requires explicit NVENC H.264');
          const before=await api(control,'/diagnostics');
          const pressure=await require('./encoder-session-pressure').start({
            ffmpeg:path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'),launch,name});
          result.sessionPressure=pressure.evidence;
          try {
            if(!pressure.evidence.exhausted)throw Error('No session exhaustion observed within the 12-helper bound');
            const logPath=path.join(run,name+'.log'),offset=fs.statSync(logPath).size;
            await page.evaluate(({remote})=>window.reviewChannels.find(c=>c.readyState==='open').send(
              JSON.stringify({action:'bitrate',remote,value:1000})),{remote:stream});
            let rejected=false;const deadline=Date.now()+15000;
            while(Date.now()<deadline) {
              if(fs.readFileSync(logPath).subarray(offset).toString().includes('replacement failed preparation')){rejected=true;break;}
              await sleep(100);
            }
            const after=await api(control,'/diagnostics');
            if(!rejected||after.video.configured_bitrate_kbps!==before.video.configured_bitrate_kbps)
              throw Error('Session exhaustion did not retain the original configuration');
            result.sessionPressure.motion=await motionProbe(page);
            if(!result.sessionPressure.motion.moving)throw Error('Session pressure stopped moving video');
            result.stages.push({name:'during-session-pressure',metrics:await measure(page,8000)});
          } finally {await pressure.close();}
          const recoveryBitrate=before.video.configured_bitrate_kbps===8000?4000:8000;
          await page.evaluate(({remote,bitrate})=>window.reviewChannels.find(c=>c.readyState==='open').send(
            JSON.stringify({action:'bitrate',remote,value:bitrate})),{remote:stream,bitrate:recoveryBitrate});
          const deadline=Date.now()+15000;let recovered=false;
          while(Date.now()<deadline) {
            if((await api(control,'/diagnostics')).video.configured_bitrate_kbps===recoveryBitrate){recovered=true;break;}
            await sleep(200);
          }
          if(!recovered)throw Error('Runtime control did not recover after releasing encoder sessions');
          result.sessionPressure.recovered=true;
          result.stages.push({name:'after-session-pressure',metrics:await measure(page,8000)});
        }
        if(opts['replacement-failure']==='1') {
          const before=await api(control,'/diagnostics');
          if(!Number.isInteger(proc.pid)||proc.exitCode!==null)throw Error('Publisher is not running');
          // Kill only newly created children of this publisher. Preserve its
          // current encoder to verify failed preparation leaves live output intact.
          const command=`$ErrorActionPreference='Stop'; $activeEncoder=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${proc.pid} AND Name = 'ffmpeg.exe'"); if($activeEncoder.Count -ne 1){throw 'Expected one active encoder'}; $activeId=$activeEncoder[0].ProcessId; Write-Output "READY:$activeId"; $deadline=(Get-Date).AddSeconds(6); while((Get-Date) -lt $deadline){Get-CimInstance Win32_Process -Filter "ParentProcessId = ${proc.pid} AND Name = 'ffmpeg.exe'" | Where-Object ProcessId -ne $activeId | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output "KILLED:$($_.ProcessId)"}; Start-Sleep -Milliseconds 40}`;
          const fault=launch('powershell.exe',['-NoProfile','-Command',command],name+'-replacement-fault');
          let output='';
          const finished=new Promise(resolve=>fault.once('exit',code=>resolve(code)));
          try {
            const activePid=await new Promise((resolve,reject)=>{
              const timeout=setTimeout(()=>reject(Error('Replacement fault helper was not ready')),10000);
              fault.stdout.on('data',data=>{
                output+=data.toString();const match=output.match(/READY:(\d+)/);
                if(match){clearTimeout(timeout);resolve(Number(match[1]));}
              });
            });
            await page.evaluate(({remote,bitrate})=>{
              window.reviewChannels.find(c=>c.readyState==='open').send(JSON.stringify({action:'bitrate',remote,value:bitrate}));
            },{remote:stream,bitrate:before.video.configured_bitrate_kbps===1000?8000:1000});
            if(await finished!==0)throw Error('Replacement fault helper failed');
            const killed=[...output.matchAll(/KILLED:(\d+)/g)].map(m=>Number(m[1]));
            if(!killed.length)throw Error('No preparing encoder was faulted');
            await sleep(2000);
            const after=await api(control,'/diagnostics'),motion=await motionProbe(page);
            const current=await execFileAsync('powershell.exe',['-NoProfile','-Command',
              `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${proc.pid} AND Name = 'ffmpeg.exe'" | ForEach-Object {$_.ProcessId}`],{windowsHide:true});
            if(current.stdout.trim()!==String(activePid)||after.video.configured_bitrate_kbps!==before.video.configured_bitrate_kbps||!motion.moving)
              throw Error('Failed preparation replaced or stopped the original encoder');
            result.replacementFailure={activePid,killed,motion,bitrateKbps:after.video.configured_bitrate_kbps};
            result.stages.push({name:'after-failed-replacement',metrics:await measure(page,8000)});
          } finally {if(fault.exitCode===null)fault.kill();}
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
          if(obsAlpha)await obsAlpha.sample('signaling-outage-recovery');
          if(sender) {
            sender.kill();result.sourceOutage={metrics:await measure(page,6000)};
            sender=launch(senderExe,senderArgs,'source-restarted');
            await sleep(5000);await waitVideo(page);
            result.stages.push({name:'after-source-restart',metrics:await measure(page,8000)});
            result.restartedMotion=await motionProbe(page);
            await saveFrame(page,name+'-source-restarted');
            if(obsAlpha)await obsAlpha.sample('source-restart-recovery');
            if(obsAlpha&&opts['obs-cadence']==='1')
              await obsAlpha.recordCadence(path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe'));
          }
        }
        if(opts.observe==='1') {
          result.stages.push({name:'extended-recovery',metrics:await measure(page,30000)});
          result.extendedMotion=await motionProbe(page);
          if(!result.extendedMotion.moving)throw Error('Extended recovery returned a frozen image');
        }
        if(opts.sustained==='1') {
          result.sustained=await require('./sustained-review').run({page,context,sourcePage,control,proc,name,
            output:run,publisher,fps,duration:Number(opts['soak-ms']),measure,stats,motionProbe,audioProbe,api,
            waitVideo,refreshTransport,sleep,lossCdp,interruptSignaling:async()=>{
              const before=proxyConnections,startedMs=Date.now();blockedUntil=Date.now()+5000;
              for(const upstream of upstreams)upstream.terminate();
              while(proxyConnections<=before&&Date.now()-startedMs<45000)await sleep(300);
              if(proxyConnections<=before)throw Error('Signaling failed to reconnect during sustained review');
              return {before,after:proxyConnections,recoveredMs:Date.now()-startedMs};
            }});
        } else if(Number(opts['soak-ms']||0)>0) {
          result.soak=[];
          for(let elapsed=0;elapsed<Number(opts['soak-ms']);elapsed+=30000) {
            let reconnect;
            if(opts['soak-reconnect']==='1') {
              const started=Date.now();
              if(result.soak.length%2===0) {
                await page.reload({waitUntil:'domcontentloaded'});
                reconnect={kind:'viewer-reload'};
              } else {
                reconnect={kind:'transport-refresh',transport:await refreshTransport(control,page)};
              }
              await waitVideo(page);reconnect.recoveredMs=Date.now()-started;
              await sleep(2000);
            }
            const sample={elapsed,metrics:await measure(page,Math.min(30000,Number(opts['soak-ms'])-elapsed)),motion:await motionProbe(page)};
            if(reconnect)sample.reconnect=reconnect;
            if(opts['frame-identity']==='1')sample.identity=await identityProbe(page,sourcePage,10000);
            result.soak.push(sample);console.log(name,'soak',elapsed,'video FPS',sample.metrics.filter(m=>m.kind==='video').map(m=>m.fps));
            if(!sample.motion.moving||!sample.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.95))throw Error('Soak lost moving full-rate video');
            if(!sample.metrics.some(m=>m.kind==='audio'&&m.audioRms>.001))throw Error('Soak lost audio');
            if(sample.identity)requireReadableIdentity(sample.identity);
            if(obsAlpha)sample.obsAlpha=await obsAlpha.sample('soak-'+result.soak.length);
          }
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
        if(opts['require-codec']==='1'&&!result.codecPreserved)
          throw Error('Requested codec was not preserved: '+result.receivedCodecs.join(', '));
        result.fullRate=result.stages.every(s=>s.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.95));
        if(bitrateCeilingRatio>0) {
          const windows=[{name:'steady',targetKbps:4000,metrics:result.stages[0].metrics},
            ...(result.browserPause?[{name:'paused',targetKbps:4000,metrics:result.browserPause.metrics}]:[]),
            ...(result.videoControls||[]).map((c,i)=>({name:'control-'+(i+1),targetKbps:c.target.bitrate,metrics:c.metrics}))];
          result.bitrateCeiling={ratio:bitrateCeilingRatio,windows:windows.map(w=>({
            name:w.name,targetKbps:w.targetKbps,kbps:w.metrics.find(m=>m.kind==='video')?.kbps}))};
          if(result.bitrateCeiling.windows.some(w=>!Number.isFinite(w.kbps)||w.kbps>w.targetKbps*bitrateCeilingRatio))
            throw Error('Measured receiver bitrate exceeded the requested ceiling: '+JSON.stringify(result.bitrateCeiling));
        }
        if(opts.resize==='1'&&(result.final.source.width!==1280||result.final.source.height!==960||result.final.source.resize_count<1)) {
          throw Error('Publisher did not observe the live source resize');
        }
        result.ok=(opts['color-check']!=='1'||result.colorAccurate)&&result.motion.moving&&(!proxy||!sender||result.restartedMotion.moving)&&
          Math.abs(result.audio.dominantHz-440)<10&&result.audio.clippedSamples===0&&
          result.stages.every(s=>s.metrics.some(m=>m.kind==='video'&&m.fps>=fps*.8&&m.width===width&&m.height===height)&&s.metrics.some(m=>m.kind==='audio'&&m.audioRms>.001));
        console.log(name,'delivery',result.ok,'full rate',result.fullRate,'encoder',result.final.video.active_encoder,'received codecs',result.receivedCodecs,
          'FPS',result.stages.map(s=>[s.name,s.metrics.find(m=>m.kind==='video')?.fps]));
      } catch(e) {result.error=String(e);result.ok=false;console.log(name,result.error);
        if(control)try{result.final=await api(control,'/diagnostics');}catch{}
        if(page)try{
          result.failureDom=await page.evaluate(()=>({visibility:document.visibilityState,
              html:document.body.innerHTML.slice(0,6000),videos:[...document.querySelectorAll('video')].map(v=>({
                element:v.outerHTML,tracks:v.srcObject?.getTracks().map(t=>({kind:t.kind,id:t.id,enabled:t.enabled,muted:t.muted,state:t.readyState})),
                width:v.videoWidth,height:v.videoHeight,paused:v.paused,readyState:v.readyState,error:v.error?.message}))}));
          await page.screenshot({path:path.join(run,name+'-failure.png')});
        }catch{}
      } finally {
        if(obsAlpha)try{await obsAlpha.close();}catch(e){result.obsCloseError=String(e);result.ok=false;}
        if(sourcePage&&opts['shutdown-window-paused']==='1') {
          try {
            await sourcePage.evaluate(()=>document.querySelector('video').pause());
            await sleep(1500);
            result.shutdownWindowPaused=await sourcePage.evaluate(()=>document.querySelector('video').paused);
          } catch(e) {result.shutdownWindowPauseError=String(e);result.ok=false;}
        }
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
        if(opts['shutdown-preparation']==='1'&&proc.exitCode===null&&page&&control) {
          try {
            const logPath=path.join(run,name+'.log'),offset=fs.statSync(logPath).size;
            const d=await api(control,'/diagnostics');
            await page.evaluate(({remote,bitrate})=>{
              window.reviewChannels.find(c=>c.readyState==='open').send(JSON.stringify({action:'bitrate',remote,value:bitrate}));
            },{remote:stream,bitrate:d.video.configured_bitrate_kbps===1000?8000:1000});
            const deadline=Date.now()+10000;let observed=false;
            while(Date.now()<deadline) {
              const text=fs.readFileSync(logPath).subarray(offset).toString();
              if(text.includes('Preparing runtime encoder replacement')) {
                observed=!text.includes('Runtime encoder replacement committed');break;
              }
              await sleep(10);
            }
            result.shutdownDuringPreparation=observed;
            if(!observed)throw Error('Could not observe an uncommitted encoder preparation before shutdown');
          } catch(e){result.shutdownPreparationError=String(e);result.ok=false;}
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
        result.finishedAt=new Date().toISOString();
        const exitPath=path.join(run,name+'-exit.json');
        if(fs.existsSync(exitPath))try{result.exitDiagnostics=JSON.parse(fs.readFileSync(exitPath));}catch{}
        fs.writeFileSync(path.join(run,'results.json'),JSON.stringify({publisher,sha256:crypto.createHash('sha256').update(fs.readFileSync(publisher)).digest('hex'),browser:browser.version(),results},null,2));
      }
    }
  } finally {if(udpRelay)udpRelay.close();await browser.close();if(sourceBrowser)await sourceBrowser.close();for(const child of children)child.kill();
    for(const server of fixtureServers)server.close();
    for(const socket of handshakeSockets)socket.destroy();if(handshakeProxy)handshakeProxy.close();
    if(proxy){for(const client of proxy.clients)client.terminate();for(const upstream of upstreams)upstream.terminate();proxy.close();}}
  if(results.some(r=>!r.ok))process.exitCode=1;
}
main().catch(async e=>{console.error(e);for(const child of children)child.kill();
  for(const server of fixtureServers)server.close();
  await Promise.allSettled([...browsers].map(browser=>browser.close()));process.exitCode=1;});
