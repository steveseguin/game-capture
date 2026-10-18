#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const adapter=require('./linux-room-fixture'),gate=require('./linux-signaling-tcp-fault'),director=require('./director-room-e2e');
const {waitFor,sleep,installReceiverProbe,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));assert.equal(opts.gui,'true');const artifact=adapter.verify(opts);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={passed:false,backend:opts.backend||'x11',artifact,cases:[],harnesses:{},scope:'Packaged Qt GUI, owned window/virtual stereo input, protected director/scene; Stop and GUI Quit while publisher-only signaling TCP is refused or TLS handshake is stalled; explicit capture restart after Stop. No WAN/media-path fault or endurance qualification.'};
const names=['linux-room-outage-stop.js','linux-signaling-tcp-fault.js','linux-signaling-route.py','linux-room-fixture.js','linux-ui-control.py','linux-portal-select.py','linux-tray-control.py','macos-media-receiver.js','director-room-e2e.js'];
for(const n of names){fs.copyFileSync(path.join(__dirname,n),path.join(report,n));result.harnesses[n]=sha(path.join(report,n));}
let fixture,browser,publisher,proxy,control,gui,discovery;const checkpoint=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
async function api(c,route){const r=await fetch(c.base_url+route,{headers:{Authorization:'Bearer '+c.token},signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}
function ui(...args){return execFileSync('python3',[path.join(report,'linux-ui-control.py'),String(publisher.pid),...args],{env:fixture.environment,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});}
async function receivers(config){
  const pages=[];
  for(const role of ['director','scene']){
    const url=role==='director'?director.buildDirectorUrl({baseUrl:'https://vdo.ninja/',streamId:config.stream,...config})+'&stereo=1':`https://vdo.ninja/?scene=0&room=${config.room}&password=${config.password}&autostart&stereo=1&cleanoutput`;
    const page=await browser.newPage({viewport:{width:1600,height:1000}});await installReceiverProbe(page);await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    const uuid=await waitFor(()=>page.evaluate(stream=>Object.keys(window.session?.rpcs||{}).find(id=>window.session.rpcs[id].streamID===stream),config.stream),30000,'Room peer missing');
    await waitFor(()=>page.evaluate(id=>window.session.rpcs[id]?.connectionState==='connected'&&[...document.querySelectorAll('video')].some(v=>v.videoWidth&&!v.paused&&v.currentTime>0),uuid),30000,'Room media missing');
    pages.push({role,page,uuid,width:role==='director'?640:1280,height:role==='director'?360:720});
  }
  return pages;
}
async function sample(pages,ms=4000){return Object.fromEntries(await Promise.all(pages.map(async p=>{
  const [video,audio]=await Promise.all([observeDecoded(p.page,ms,p.uuid),observeAudio(p.page,p.uuid)]);const distinct=requireMoving(video,p.role);assert.equal(video.width,p.width);assert.equal(video.height,p.height);
  const stereo=audio.spectra.filter(s=>s.rms>.001&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length;assert(stereo>=25);
  const fps=distinct/((video.ended-video.started)/1000);assert(fps>=28.5,p.role+' missed 30fps target');return [p.role,{video,audio,distinct,fps,stereo}];
})));}
async function counters(page){return page.evaluate(async()=>{let frames=0,audioPackets=0,connected=0;for(const pc of window.reviewPCs){connected+=Number(pc.connectionState==='connected');for(const s of (await pc.getStats()).values())if(s.type==='inbound-rtp'){if(s.kind==='video')frames+=s.framesDecoded||0;if(s.kind==='audio')audioPackets+=s.packetsReceived||0;}}return {frames,audioPackets,connected};});}
async function stoppedMedia(pages){await sleep(1500);const before=await Promise.all(pages.map(p=>counters(p.page)));await sleep(1200);const after=await Promise.all(pages.map(p=>counters(p.page)));assert.deepEqual(after,before,'Media still advanced after shutdown');for(const p of pages)await p.page.close();return {before,after,stableMs:1200};}
async function fault(mode,pages){
  const e={mode,before:proxy.snapshot(),started:Date.now()};proxy.fault(mode);await waitFor(async()=>(await api(control,'/diagnostics')).app.reconnecting,8000,'No recovery state');e.gui=await gui.recoveryState(true);
  e.media=await sample(pages,10000);await sleep(Math.max(0,(mode==='reject'?30000:15000)-(Date.now()-e.started)));
  await waitFor(()=>mode==='reject'?proxy.snapshot().rejectedConnections>e.before.rejectedConnections:proxy.snapshot().stalledHandshakes>e.before.stalledHandshakes&&proxy.snapshot().activeStalledConnections>0,10000,'Fault did not intercept a reconnect');
  e.durationMs=Date.now()-e.started;e.proxy=proxy.snapshot();e.diagnostics=await api(control,'/diagnostics');assert(e.diagnostics.app.live&&e.diagnostics.app.capturing&&e.diagnostics.app.reconnecting);assert.equal(e.proxy.activeUpstreams,0);return e;
}
(async()=>{console.log('Reports: '+report);try{
 fixture=await adapter.create(opts,report);browser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
 for(const mode of ['reject','stall']){
  console.log('Mode: '+mode);const entry={mode,passed:false};result.cases.push(entry);checkpoint();const dir=path.join(report,mode);fs.mkdirSync(dir,{mode:0o700});fs.copyFileSync(path.join(report,'linux-signaling-route.py'),path.join(dir,'linux-signaling-route.py'));
  const config={stream:'linuxstop'+crypto.randomBytes(10).toString('hex'),room:'linux'+crypto.randomBytes(10).toString('hex'),password:crypto.randomBytes(16).toString('hex'),remoteToken:crypto.randomBytes(24).toString('hex'),remoteEnabled:true};
  proxy=await gate.create(dir);discovery=path.join(dir,'control.json');const env={...fixture.environment,XDG_STATE_HOME:path.join(dir,'private-state')};for(const key of Object.keys(env))if(/^(DYLD_|GAME_CAPTURE_|VERSUS_)/.test(key))delete env[key];
  const log=fs.createWriteStream(path.join(dir,'publisher.log'));publisher=spawn(artifact.exe,['--settings-dir='+path.join(dir,'private-settings'),'--local-control','--local-control-port=0','--local-control-discovery='+discovery],{env,cwd:dir,stdio:['ignore','pipe','pipe']});publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});publisher.closed=new Promise(resolve=>publisher.once('close',code=>log.end(()=>resolve(code))));
  await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'No discovery');control=JSON.parse(fs.readFileSync(discovery));await proxy.attach(publisher,artifact.exe);gui=await fixture.startGui(publisher,control,api,config);
  let pages=await receivers(config);entry.initial=await sample(pages);entry.stopFault=await fault(mode,pages);checkpoint();
  let started=Date.now();await gui.stop();entry.stopMs=Date.now()-started;assert(entry.stopMs<5000,'GUI Stop too slow');entry.stopped=await api(control,'/diagnostics');assert(!entry.stopped.app.live&&!entry.stopped.app.capturing&&!entry.stopped.app.reconnecting);assert.equal(entry.stopped.peer_counts.total,0);entry.stoppedMedia=await stoppedMedia(pages);
  const before=proxy.snapshot();await sleep(1500);entry.afterStopProxy=proxy.snapshot();assert.equal(entry.afterStopProxy.rejectedConnections,before.rejectedConnections);assert.equal(entry.afterStopProxy.stalledHandshakes,before.stalledHandshakes);assert.equal(entry.afterStopProxy.activeTcpSockets,0,'Signaling sockets survived Stop');
  proxy.restore();ui('activate');await gui.goLive();pages=await receivers(config);entry.restarted=await sample(pages);entry.quitFault=await fault(mode,pages);checkpoint();
  started=Date.now();if(opts.backend==='wayland'){
    const trace=fs.openSync(path.join(dir,'quit-ui.log'),'w');
    try{entry.quitAction=JSON.parse(execFileSync('python3',[path.join(report,'linux-tray-control.py'),String(publisher.pid),'action','Quit'],{env:{...fixture.environment,GC_QA_TRACE_TRAY:'1'},encoding:'utf8',timeout:60000,stdio:['ignore','pipe',trace]}));}
    finally{fs.closeSync(trace);}
    entry.quitMenuObservationMs=Date.now()-started;started=entry.quitAction.actionStartedAtMs;assert(Number.isFinite(started));
  }else{ui('activate');ui('menu','File');ui('menu','Quit');entry.quitAction={action:'File menu Quit'};}
  await waitFor(()=>publisher.exitCode!==null,10000,'GUI Quit did not exit');entry.quitMs=Date.now()-started;assert(entry.quitMs<10000);assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));publisher=null;entry.quitMedia=await stoppedMedia(pages);
  await proxy.close();entry.proxyClosed=proxy.snapshot();assert.equal(entry.proxyClosed.activeTcpSockets,0);assert.equal(entry.proxyClosed.unexpectedErrors,0);proxy=null;
  entry.credentialLogsChecked=['publisher.log','private-state/GameCapture/logs/game-capture-debug.log'].map(name=>{const f=path.join(dir,name),s=fs.readFileSync(f,'utf8');assert(!s.includes(config.password)&&!s.includes(config.remoteToken));return {file:path.relative(report,f),sha256:sha(f)};});entry.passed=true;checkpoint();
 }
 result.passed=true;
}catch(e){result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;
}finally{try{
 if(publisher&&publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGTERM');await Promise.race([publisher.closed,sleep(5000)]);if(publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGKILL');await publisher.closed;}result.forcedPublisherCleanup=true;}
 if(proxy)await proxy.close();if(browser)await browser.close();if(fixture){await fixture.close();result.desktop=fixture.evidence;}
}catch(e){result.cleanupError=String(e.stack||e);result.passed=false;process.exitCode=1;}checkpoint();console.log(JSON.stringify({report,passed:result.passed}));}})();
