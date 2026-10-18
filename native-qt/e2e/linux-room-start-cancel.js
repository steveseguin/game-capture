#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const adapter=require('./linux-room-fixture'),gate=require('./linux-signaling-tcp-fault'),director=require('./director-room-e2e');
const {waitFor,sleep,installReceiverProbe,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));assert.equal(opts.gui,'true');const artifact=adapter.verify(opts);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={passed:false,backend:opts.backend||'x11',artifact,cases:[],harnesses:{},scope:'Packaged Qt GUI startup with a stalled initial TLS handshake: authenticated local-control Stop through the GUI startup path and actual File-menu Quit; Stop permits explicit decoded room retry. No pending portal cancellation or WAN qualification.'};
const names=['linux-room-start-cancel.js','linux-signaling-tcp-fault.js','linux-signaling-route.py','linux-room-fixture.js','linux-ui-control.py','linux-portal-select.py','linux-tray-control.py','macos-media-receiver.js','director-room-e2e.js'];
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
(async()=>{console.log('Reports: '+report);try{
 fixture=await adapter.create(opts,report);browser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
 for(const mode of ['stop','quit']){
  console.log('Mode: '+mode);const entry={mode,passed:false};result.cases.push(entry);checkpoint();const dir=path.join(report,mode);fs.mkdirSync(dir,{mode:0o700});fs.copyFileSync(path.join(report,'linux-signaling-route.py'),path.join(dir,'linux-signaling-route.py'));
  const config={stream:'linuxstop'+crypto.randomBytes(10).toString('hex'),room:'linux'+crypto.randomBytes(10).toString('hex'),password:crypto.randomBytes(16).toString('hex'),remoteToken:crypto.randomBytes(24).toString('hex'),remoteEnabled:true};
  proxy=await gate.create(dir);discovery=path.join(dir,'control.json');const env={...fixture.environment,XDG_STATE_HOME:path.join(dir,'private-state')};for(const key of Object.keys(env))if(/^(DYLD_|GAME_CAPTURE_|VERSUS_)/.test(key))delete env[key];
  const log=fs.createWriteStream(path.join(dir,'publisher.log'));publisher=spawn(artifact.exe,['--settings-dir='+path.join(dir,'private-settings'),'--local-control','--local-control-port=0','--local-control-discovery='+discovery],{env,cwd:dir,stdio:['ignore','pipe','pipe']});publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});publisher.closed=new Promise(resolve=>publisher.once('close',code=>log.end(()=>resolve(code))));
  await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'No discovery');control=JSON.parse(fs.readFileSync(discovery));await proxy.attach(publisher,artifact.exe);proxy.fault('stall');
  config.observeInitialStart=async()=>{
    await waitFor(()=>proxy.snapshot().stalledHandshakes>0&&proxy.snapshot().activeStalledConnections>0,10000,'No pending TLS handshake');
    entry.intercepted=proxy.snapshot();entry.pending=await api(control,'/diagnostics');assert(entry.pending.app.capturing&&!entry.pending.app.live);checkpoint();
    let started=Date.now();
    if(mode==='stop'){
      const response=await fetch(control.base_url+'/commands',{method:'POST',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:JSON.stringify({command:'stop'}),signal:AbortSignal.timeout(3000)});assert(response.ok);entry.stopResponse=await response.json();
      await waitFor(async()=>!(await api(control,'/diagnostics')).app.capturing,16000,'Pending Stop did not finish');
      entry.cancelMs=Date.now()-started;entry.idle=await api(control,'/diagnostics');
      assert(!entry.idle.app.live&&!entry.idle.app.reconnecting);assert.equal(entry.idle.peer_counts.total,0);
      entry.cancelUi=JSON.parse(ui('dump')).filter(r=>r.role==='label'&&/cancel|Failed to connect/i.test(r.name)).map(r=>r.name);checkpoint();assert(entry.cancelMs<3000,'Pending Stop waited for connection timeout');
      assert(entry.cancelUi.includes('Capture startup cancelled'),'Cancellation has misleading failure status');
      const before=proxy.snapshot();await sleep(1500);entry.idleStable=await api(control,'/diagnostics');entry.afterCancelProxy=proxy.snapshot();assert.equal(entry.idleStable.video.frames_captured,entry.idle.video.frames_captured);assert.equal(entry.afterCancelProxy.activeTcpSockets,0);assert.equal(entry.afterCancelProxy.stalledHandshakes,before.stalledHandshakes);
    }else{
      ui('activate');entry.quitAction=JSON.parse(ui('quit-menu'));started=entry.quitAction.actionStartedAtMs;
      await waitFor(()=>publisher.exitCode!==null,16000,'Pending Quit did not finish');entry.cancelMs=Date.now()-started;assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));publisher=null;checkpoint();assert(entry.cancelMs<3000,'Pending Quit waited for connection timeout');
    }
  };
  gui=await fixture.startGui(publisher,control,api,config);
  if(mode==='stop'){
    proxy.restore();ui('activate');await gui.goLive();const pages=await receivers(config);entry.retried=await sample(pages,10000);
    await gui.stop();entry.stopped=await api(control,'/diagnostics');assert(!entry.stopped.app.live&&!entry.stopped.app.capturing);entry.stoppedMedia=await stoppedMedia(pages);
    ui('activate');entry.quitAction=JSON.parse(ui('quit-menu'));await waitFor(()=>publisher.exitCode!==null,10000,'Final GUI Quit did not exit');assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));publisher=null;
  }
  await proxy.close();entry.proxyClosed=proxy.snapshot();assert.equal(entry.proxyClosed.activeTcpSockets,0);assert.equal(entry.proxyClosed.unexpectedErrors,0);proxy=null;
  entry.credentialLogsChecked=['publisher.log','private-state/GameCapture/logs/game-capture-debug.log'].map(name=>{const f=path.join(dir,name),s=fs.readFileSync(f,'utf8');assert(!s.includes(config.password)&&!s.includes(config.remoteToken));assert(!s.includes('[Signaling] Connection timeout'),'Cancellation arrived after timeout');return {file:path.relative(report,f),sha256:sha(f)};});entry.passed=true;checkpoint();
 }
 result.passed=true;
}catch(e){result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;
}finally{try{
 if(publisher&&publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGTERM');await Promise.race([publisher.closed,sleep(5000)]);if(publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGKILL');await publisher.closed;}result.forcedPublisherCleanup=true;}
 if(proxy)await proxy.close();if(browser)await browser.close();if(fixture){await fixture.close();result.desktop=fixture.evidence;}
}catch(e){result.cleanupError=String(e.stack||e);result.passed=false;process.exitCode=1;}checkpoint();console.log(JSON.stringify({report,passed:result.passed}));}})();
