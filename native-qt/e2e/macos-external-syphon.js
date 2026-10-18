#!/usr/bin/env node
'use strict';
// Unmodified upstream Syphon Simple Server (OpenGL) -> packaged Metal client -> browser.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');assert(i>2);return [a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','sender-app','ui-helper','reports'])assert(opts[key],'Required --'+key);
const app=path.resolve(opts.app),senderApp=path.resolve(opts['sender-app']);
const exe=path.join(app,'Contents/MacOS/game-capture'),senderExe=path.join(senderApp,'Contents/MacOS/Simple Server');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const result={scope:'Upstream Simple Server OpenGL grayscale animation received by the packaged Mac Metal Syphon client and decoded in a browser. Exact source discovery, two H264 encoders, late viewers and orderly external sender loss. No alpha/color/orientation, physical audio or calibrated latency claim.',
  executableSha256:hash(exe),senderSha256:hash(senderExe),harnessSha256:hash(__filename),uiHelperSha256:hash(path.resolve(opts['ui-helper'])),cases:[],passed:false};
for(const name of ['macos-external-syphon.js','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let browser,scanner,scannerControl;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
function launch(program,args,name){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
  const child=spawn(program,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);
  const log=fs.createWriteStream(path.join(report,name+'.log'));let output='';child.output=()=>output;
  child.stdout.on('data',b=>output+=b);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
  child.once('error',e=>child.launchError=String(e));return child;
}
function alive(child){assert(!child.launchError&&child.exitCode===null&&!child.signalCode,'Owned process exited');}
async function api(c,route,body){
  const r=await fetch(c.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Control HTTP '+r.status);return r.json();
}
async function controlFor(child,file){
  await waitFor(()=>{alive(child);return fs.existsSync(file);},15000,'Control unavailable');
  const c=JSON.parse(fs.readFileSync(file));assert.equal(c.pid,child.pid);return c;
}
function ui(child,action,name){return execFileSync(path.resolve(opts['ui-helper']),[String(child.pid),action,...(name?[name]:[])],{timeout:10000,stdio:'pipe',encoding:'utf8'});}
function activateSender(child){execFileSync('/usr/bin/open',['-a',senderApp,'--args','-ApplePersistenceIgnoreState','YES'],{timeout:10000,stdio:'pipe'});ui(child,'activate');}
async function quitSender(child){
  activateSender(child);
  try{ui(child,'key','command-q');}catch(e){if(child.exitCode===null)await sleep(300);if(child.exitCode===null)throw e;}
  await waitFor(()=>child.exitCode!==null,5000,'External sender did not quit');assert.deepEqual(await child.closed,{code:0,signal:null});
}
async function observe(page,milliseconds){return page.evaluate(async milliseconds=>{
  const pc=window.reviewPCs.find(pc=>pc.connectionState==='connected');if(!pc)throw Error('No connected receiver');
  const received=pc.getReceivers().map(r=>r.track).find(t=>t?.kind==='video'&&t.readyState==='live');
  if(!received||typeof MediaStreamTrackProcessor!=='function')throw Error('No decoded frame API/track');
  const track=received.clone(),reader=new MediaStreamTrackProcessor({track,maxBufferSize:4}).readable.getReader();
  const canvas=new OffscreenCanvas(9,9),ctx=canvas.getContext('2d',{willReadFrequently:true}),samples=[];
  const started=performance.now();let width,height;
  const timer=setTimeout(()=>reader.cancel().catch(()=>{}),milliseconds);
  try{while(true){const {done,value:f}=await reader.read();if(done)break;
    try{width=f.displayWidth;height=f.displayHeight;
      // A central square excludes aspect-fit bars from the upstream window.
      ctx.drawImage(f,width*.4,height*.4,width*.2,height*.2,0,0,9,9);
      const p=ctx.getImageData(0,0,9,9).data;let sum=0,low=255,high=0,chroma=0;
      for(let i=0;i<p.length;i+=4){const mean=(p[i]+p[i+1]+p[i+2])/3;sum+=mean;low=Math.min(low,mean);high=Math.max(high,mean);chroma=Math.max(chroma,Math.max(p[i],p[i+1],p[i+2])-Math.min(p[i],p[i+1],p[i+2]));}
      samples.push({time:performance.now(),mediaTime:f.timestamp/1e6,grey:sum/81,spread:high-low,chroma});
    }finally{f.close();}}
  }finally{clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();track.stop();}
  const ended=performance.now(),tracks=[];for(const s of (await pc.getStats()).values())if(s.type==='inbound-rtp')tracks.push(s);
  return {samples,started,ended,width,height,tracks};
},milliseconds);}
function analyze(o){
  assert.equal(o.width,640);assert.equal(o.height,360);assert(o.samples.length>100);
  const fps=o.samples.length/((o.ended-o.started)/1000);assert(fps>=28.5,'Decoded cadence below 95% of 30 fps: '+fps);
  // Least-squares fit with free phase: source has a four-second sine period.
  // This establishes animation identity, not end-to-end calibrated latency.
  const m=Array.from({length:3},()=>[0,0,0,0]);
  for(const s of o.samples){const x=[1,Math.sin((s.time-o.started)*Math.PI/2000),Math.cos((s.time-o.started)*Math.PI/2000)];
    for(let i=0;i<3;i++){for(let j=0;j<3;j++)m[i][j]+=x[i]*x[j];m[i][3]+=x[i]*s.grey;}}
  for(let i=0;i<3;i++){const d=m[i][i];assert(Math.abs(d)>1e-6);for(let k=i;k<4;k++)m[i][k]/=d;
    for(let j=0;j<3;j++)if(j!==i){const f=m[j][i];for(let k=i;k<4;k++)m[j][k]-=f*m[i][k];}}
  const [mean,sin,cos]=m.map(row=>row[3]),amplitude=Math.hypot(sin,cos),average=o.samples.reduce((v,s)=>v+s.grey,0)/o.samples.length;
  let residual=0,total=0;for(const s of o.samples){const t=(s.time-o.started)*Math.PI/2000;residual+=(s.grey-mean-sin*Math.sin(t)-cos*Math.cos(t))**2;total+=(s.grey-average)**2;}
  const rSquared=1-residual/total,maxChroma=Math.max(...o.samples.map(s=>s.chroma)),maxSpread=Math.max(...o.samples.map(s=>s.spread));
  const gaps=o.samples.slice(1).map((s,i)=>s.mediaTime-o.samples[i].mediaTime);assert(gaps.every(g=>g>0),'Decoded media timestamps did not advance');
  const summary={decodedFps:fps,frames:o.samples.length,mean,amplitude,rSquared,maxChroma,maxSpread,maxMediaGapMs:Math.max(...gaps)*1000};
  assert(Math.abs(mean-122.4)<15&&Math.abs(amplitude-102)<15&&rSquared>.97,'Upstream grayscale sine mismatch: '+JSON.stringify(summary));
  assert(maxChroma<=5&&maxSpread<=5,'Decoded upstream field is not uniform grayscale');return summary;
}
(async()=>{console.log('Reports: '+report);try{
  const settings=path.join(report,'scanner-settings'),org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
  fs.writeFileSync(path.join(org,'Game Capture.ini'),'[video]\nsourceMode=syphon\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\n');
  const scannerFile=path.join(report,'scanner-control.json');
  scanner=launch(exe,['--settings-dir='+settings,'--local-control','--local-control-port=0','--local-control-discovery='+scannerFile],'scanner');scannerControl=await controlFor(scanner,scannerFile);
  const existing=(await api(scannerControl,'/sources/syphon')).sources;
  assert(!existing.some(s=>JSON.stringify(s).includes('Simple Server')),'An existing external sender would make ownership ambiguous');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});result.browserVersion=browser.version();
  for(const encoder of ['videotoolbox','x264']){
    const entry={encoder,passed:false};result.cases.push(entry);const dir=path.join(report,encoder);fs.mkdirSync(dir);let source,publisher,control,page,late;
    const discovery=path.join(dir,'control.json');
    try{
      source=launch(senderExe,['-ApplePersistenceIgnoreState','YES'],encoder+'-sender');await sleep(1000);alive(source);activateSender(source);
      let selected;await waitFor(async()=>{alive(source);const sources=(await api(scannerControl,'/sources/syphon')).sources.filter(s=>JSON.stringify(s).includes('Simple Server'));assert(sources.length<=1);selected=sources[0];return !!selected;},15000,'External sender not discovered');entry.source=selected;
      const stream='macexternal'+crypto.randomBytes(12).toString('hex');
      publisher=launch(exe,['--headless','--source=syphon','--syphon-server='+selected.id,'--syphon-alpha=premultiplied','--alpha-background=opaque',
        '--stream='+stream,'--password=false','--audio-source=none','--video-codec=h264','--video-encoder='+encoder,'--width=640','--height=360','--fps=30','--bitrate-kbps=1200',
        '--duration-ms=180000','--local-control','--local-control-port=0','--local-control-discovery='+discovery],encoder+'-publisher');
      control=await controlFor(publisher,discovery);await waitFor(async()=>{alive(publisher);return (await api(control,'/diagnostics')).app.live;},15000,'Publisher not live');
      page=await receiver(browser,stream,publisher);entry.initial=await observe(page,16000);entry.initialSummary=analyze(entry.initial);save();
      late=await receiver(browser,stream,publisher);
      [entry.existingWithLate,entry.late]=await Promise.all([observe(page,8000),observe(late,8000)]);
      entry.existingWithLateSummary=analyze(entry.existingWithLate);entry.lateSummary=analyze(entry.late);
      entry.diagnostics=await api(control,'/diagnostics');assert.equal(entry.diagnostics.video.hardware_encoder,encoder==='videotoolbox');
      for(const k of ['encode_failures','encode_timeouts','send_failures'])assert.equal(entry.diagnostics.video[k],0);
      const lossStarted=Date.now();await quitSender(source);entry.senderExit=await source.closed;
      await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not stop after external sender quit');entry.sourceLossMs=Date.now()-lossStarted;
      entry.publisherExit=await publisher.closed;assert.deepEqual(entry.publisherExit,{code:3,signal:null});assert(!fs.existsSync(discovery));
      assert(fs.readFileSync(path.join(report,encoder+'-publisher.log'),'utf8').includes('Syphon server disconnected'),'Actionable source-loss message absent');
      await waitFor(async()=>!(await api(scannerControl,'/sources/syphon')).sources.some(s=>s.id===selected.id),5000,'Retired external UUID still listed');
      entry.passed=true;
    }catch(e){entry.error=String(e.stack||e);}
    finally{
      await late?.close().catch(()=>{});await page?.close().catch(()=>{});
      if(publisher&&publisher.exitCode===null&&control)await api(control,'/commands',{command:'quit'}).catch(()=>{});
      if(source&&source.exitCode===null)await quitSender(source).catch(()=>{});
      for(const child of [publisher,source].filter(Boolean)){await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');entry.passed=false;entry.forcedCleanup=true;}await child.closed;}
      if(publisher)entry.publisherExit=await publisher.closed;if(source)entry.senderExit=await source.closed;
      save();console.log(encoder+': '+(entry.passed?'passed':'failed'));
    }
  }
  await api(scannerControl,'/commands',{command:'quit'});await waitFor(()=>scanner.exitCode!==null,5000,'Scanner did not quit');result.scannerExit=await scanner.closed;
  assert.deepEqual(result.scannerExit,{code:0,signal:null});assert(!fs.existsSync(scannerFile));
  result.passed=result.cases.every(c=>c.passed);assert(result.passed,'External Syphon workflow failed');
}catch(e){result.error=String(e.stack||e);process.exitCode=1;}
finally{
  await browser?.close().catch(()=>{});
  if(scanner&&scanner.exitCode===null&&scannerControl)await api(scannerControl,'/commands',{command:'quit'}).catch(()=>{});
  for(const child of children){await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');await child.closed;}
  save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
