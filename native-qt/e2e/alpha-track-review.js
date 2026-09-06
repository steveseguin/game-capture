'use strict';
// Packaged publisher -> ordinary browser plus an exact native OBS plugin artifact.
// Never attach a receiver track to a diagnostic video: validate the page's own output.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn}=require('child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function parseOptions(args) {
  const opts={};
  const allowed=new Set(['publisher','sender','reports','obs-plugin-repo','expected-publisher-sha256',
    'expected-plugin-sha256','codec','encoder']);
  for(const arg of args) {
    const match=/^--([^=]+)=(.*)$/.exec(arg);
    if(!match||!allowed.has(match[1]))throw Error(`Unknown or malformed option: ${arg}; use --name=value`);
    if(Object.hasOwn(opts,match[1]))throw Error(`Duplicate option: --${match[1]}`);
    opts[match[1]]=match[2];
  }
  return opts;
}

async function main() {
  const opts=parseOptions(process.argv.slice(2));
  for(const name of ['publisher','sender','reports','obs-plugin-repo']) {
    if(!opts[name]?.trim())throw Error(`Explicit --${name}=PATH is required`);
  }
  for(const name of ['expected-publisher-sha256','expected-plugin-sha256']) {
    if(!/^[a-f0-9]{64}$/i.test(opts[name]||''))throw Error(`--${name} must be an explicit SHA-256 (64 hexadecimal characters)`);
  }
  const publisher=path.resolve(opts.publisher),sender=path.resolve(opts.sender);
  const publisherSha256=hash(publisher),expectedPublisherSha256=opts['expected-publisher-sha256'].toLowerCase();
  if(publisherSha256!==expectedPublisherSha256) {
    throw Error(`Publisher SHA-256 mismatch for ${publisher}: expected ${expectedPublisherSha256}, actual ${publisherSha256}`);
  }
  const {chromium}=require('playwright');
  const output=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
  const stream='alphatrack'+crypto.randomBytes(6).toString('hex');
  const controlFile=path.join(output,'control.json'),children=[],logs=[];
  const result={publisher,publisherSha256,expectedPublisherSha256,senderSha256:hash(sender),stream,
    codec:opts.codec||'vp9',audioSource:'none',phases:[],startedAt:new Date().toISOString()};
  const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
  let control,browser,obs,page;
  function launch(exe,args,label,env={}) {
    const log=fs.createWriteStream(path.join(output,label+'.log'));logs.push(log);
    const proc=spawn(exe,args,{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
    children.push(proc);proc.stdout.pipe(log,{end:false});proc.stderr.pipe(log,{end:false});
    proc.on('error',e=>{result.processError=String(e);save();});return proc;
  }
  async function api(route,body) {
    const response=await fetch(control.base_url+route,{method:body?'POST':'GET',
      headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;
  }
  async function snapshot() {
    return page.evaluate(async()=>{
      const pcs=await Promise.all(window.reviewPCs.filter(p=>p.connectionState!=='closed').map(async p=>({
        state:p.connectionState,local:p.localDescription?.sdp,remote:p.remoteDescription?.sdp,
        transceivers:p.getTransceivers().map(t=>({mid:t.mid,direction:t.currentDirection,
          id:t.receiver.track.id,kind:t.receiver.track.kind,muted:t.receiver.track.muted})),
        inbound:[...(await p.getStats()).values()].filter(s=>s.type==='inbound-rtp')})));
      return {at:Date.now(),pcs,videos:[...document.querySelectorAll('video')].map(v=>({
        id:v.id,ready:v.readyState,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,paused:v.paused,
        tracks:(v.srcObject?.getTracks()||[]).map(t=>({id:t.id,kind:t.kind,muted:t.muted,
          mid:pcs.flatMap(p=>p.transceivers).find(r=>r.id===t.id)?.mid}))}))};
    });
  }
  async function phase(label) {
    const before=await snapshot();await sleep(1800);const after=await snapshot();
    const playing=after.videos.filter(v=>v.ready>=2&&v.width===1280&&v.height===720&&!v.paused&&
      v.time>(before.videos.find(b=>b.id===v.id)?.time??Infinity)+.5);
    const pixelMotion=await page.evaluate(async videoId=>{
      const v=[...document.querySelectorAll('video')].find(v=>v.id===videoId);if(!v)return [];
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
      const ctx=canvas.getContext('2d'),centers=[];
      for(let n=0;n<5;n++) {
        ctx.drawImage(v,0,0,160,90);const pixels=ctx.getImageData(0,0,160,90).data;let sum=0,count=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i]<100&&pixels[i+1]<150&&pixels[i+2]>180){sum+=(i/4)%160;count++;}
        if(count>10)centers.push(sum/count);await new Promise(r=>setTimeout(r,300));
      }
      return centers;
    },playing[0]?.id??null);
    const ok=playing.length>0&&playing.every(v=>v.tracks.some(t=>t.kind==='video'&&t.mid==='video'&&!t.muted))&&
      after.videos.every(v=>v.tracks.every(t=>t.mid!=='video-alpha'))&&
      after.pcs.every(p=>p.transceivers.filter(t=>t.mid==='video-alpha').every(t=>t.direction==='inactive'))&&
      pixelMotion.length>=3&&Math.max(...pixelMotion)-Math.min(...pixelMotion)>1;
    result.phases.push({label,ok,before,after,pixelMotion});save();
    await page.screenshot({path:path.join(output,label+'.png')});
    console.log(label,ok?'PASS':'FAIL','selected MIDs',playing.flatMap(v=>v.tracks.map(t=>t.mid)));
    if(!ok)throw Error(label+': ordinary browser did not present moving color video with inactive alpha');
  }
  console.log('Artifacts:',output);
  let capture;
  try {
    launch(sender,[`--name=${stream}`,'--pattern=alpha-moving-edge','--width=640','--height=360','--fps=30','--duration-ms=240000'],'sender');
    await sleep(2000);
    capture=launch(publisher,['--headless',`--stream=${stream}`,'--password=false','--source=spout',`--spout-sender=${stream}`,
      `--video-codec=${result.codec}`,`--video-encoder=${opts.encoder||'auto'}`,'--alpha-workflow','--resolution=1280x720',
      '--fps=30','--bitrate-kbps=6000','--audio-source=none','--duration-ms=230000',
      '--local-control','--local-control-port=0',`--local-control-discovery=${controlFile}`],'publisher',
      {LOCALAPPDATA:output,QT_PLUGIN_PATH:path.dirname(publisher),QT_QPA_PLATFORM_PLUGIN_PATH:path.join(path.dirname(publisher),'platforms')});
    const deadline=Date.now()+30000;let publisherReady=false;
    while(Date.now()<deadline) {
      if(capture.exitCode!==null||capture.signalCode!==null)throw Error('Publisher exited during startup');
      if(fs.existsSync(controlFile)) {
        control=JSON.parse(fs.readFileSync(controlFile,'utf8'));
        const d=await api('/diagnostics');if(d.app.live&&d.source.has_frame){publisherReady=true;break;}
      }
      await sleep(300);
    }
    if(!publisherReady)throw Error('Publisher did not become live with a captured frame within 30 seconds');
    browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
    const context=await browser.newContext();
    await context.addInitScript(()=>{
      window.reviewPCs=[];const Original=window.RTCPeerConnection;
      window.RTCPeerConnection=new Proxy(Original,{construct(target,args){const p=new target(...args);window.reviewPCs.push(p);return p;}});
    });
    page=await context.newPage();
    await page.goto(`https://vdo.ninja/?view=${stream}&password=false&cleanoutput=1&noaudio=1`,{waitUntil:'domcontentloaded'});
    await sleep(20000);await phase('browser-only');
    obs=await require('./obs-alpha-runtime').start({repo:opts['obs-plugin-repo'],stream,output:path.join(output,'obs'),
      expectedPluginHash:opts['expected-plugin-sha256'],width:1280,height:720,alpha:true});
    result.obs=obs.evidence;await obs.sample('initial');await phase('native-alpha-attached');
    await page.reload({waitUntil:'domcontentloaded'});await sleep(12000);await phase('browser-reload-with-native-alpha');
    result.refresh=await api('/commands',{command:'refresh_peer_transports'});
    await sleep(12000);await obs.sample('transport-refresh');await phase('transport-refresh');
    await obs.close();obs=null;await sleep(3000);await phase('native-viewer-closed');
    result.ok=true;
  } catch(e) {result.ok=false;result.error=String(e);console.error(result.error);process.exitCode=1;}
  finally {
    if(obs)try{await obs.close();}catch(e){result.obsCloseError=String(e);result.ok=false;process.exitCode=1;}
    if(browser)try{await browser.close();}catch(e){result.browserCloseError=String(e);result.ok=false;process.exitCode=1;}
    if(capture&&capture.exitCode===null&&capture.signalCode===null&&control)try{await api('/commands',{command:'quit'});}catch{}
    const deadline=Date.now()+10000;
    while(capture&&capture.exitCode===null&&capture.signalCode===null&&Date.now()<deadline)await sleep(100);
    result.publisherExitCode=capture?.exitCode;
    result.publisherSignalCode=capture?.signalCode;
    if(capture&&capture.exitCode!==0){result.ok=false;process.exitCode=1;}
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
    for(const log of logs)log.end();result.completedAt=new Date().toISOString();save();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
