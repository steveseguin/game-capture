#!/usr/bin/env node
'use strict';
// Packaged GUI room quality, role routing, and settings across clean relaunches.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{chromium}=require('playwright');
const adapter=require('./linux-room-fixture'),director=require('./director-room-e2e');
const {waitFor,sleep,installReceiverProbe,observe,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
assert.equal(opts.gui,'true');const artifact=adapter.verify(opts);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={passed:false,backend:opts.backend||'x11',artifact,phases:[],harnesses:{},
  scope:'Extracted DEB; GUI room configuration, HQ-only and dual-tier roles, clean relaunch with same settings, explicit source reselection and Go live; owned window and virtual stereo input. No physical device or endurance qualification.'};
for(const name of ['linux-room-settings.js','linux-room-fixture.js','linux-ui-control.py','linux-portal-select.py','macos-media-receiver.js','director-room-e2e.js']){
  fs.copyFileSync(path.join(__dirname,name),path.join(report,name));result.harnesses[name]=sha(path.join(report,name));
}
const config={stream:'linuxroom'+crypto.randomBytes(10).toString('hex'),room:'linux'+crypto.randomBytes(10).toString('hex'),
  password:crypto.randomBytes(16).toString('hex'),remoteToken:crypto.randomBytes(24).toString('hex'),remoteEnabled:true,roomQualityLq:false};
const directorConfig={baseUrl:'https://vdo.ninja/',streamId:config.stream,room:config.room,password:config.password,timeoutMs:30000};
let fixture,browser,publisher,control,gui,discovery;const logs=[];
const checkpoint=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
async function api(c,route,body){const r=await fetch(c.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}
const check=(v,label)=>{assert(v.ok,label+': '+JSON.stringify(v));return v;};
async function pageAt(url){const p=await browser.newPage({viewport:{width:1600,height:1000}});await installReceiverProbe(p);await p.goto(url,{waitUntil:'domcontentloaded',timeout:45000});return p;}
async function start(index,restored){
  discovery=path.join(report,'control-'+index+'.json');const logPath=path.join(report,'publisher-'+index+'.log'),log=fs.createWriteStream(logPath);logs.push(logPath);
  const env={...fixture.environment,XDG_STATE_HOME:path.join(report,'private-state')};
  for(const key of Object.keys(env))if(/^(DYLD_|GAME_CAPTURE_|VERSUS_)/.test(key))delete env[key];
  publisher=spawn(artifact.exe,['--settings-dir='+path.join(report,'private-settings'),'--local-control','--local-control-port=0','--local-control-discovery='+discovery],{env,cwd:report,stdio:['ignore','pipe','pipe']});
  publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
  publisher.closed=new Promise(resolve=>publisher.once('close',code=>log.end(()=>resolve(code))));
  await waitFor(()=>{assert.equal(publisher.exitCode,null);return fs.existsSync(discovery);},15000,'No discovery');control=JSON.parse(fs.readFileSync(discovery));
  gui=await fixture.startGui(publisher,control,api,config,restored);
}
async function quit(){
  await gui.stop();await api(control,'/commands',{command:'quit'});
  await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));publisher=null;
}
async function receiver(p,role,tier,width,height){
  const uuid=await waitFor(()=>p.evaluate(stream=>Object.keys(window.session?.rpcs||{}).find(id=>window.session.rpcs[id].streamID===stream),config.stream),30000,'No publisher peer for '+role);
  await waitFor(async()=>(await director.installMessageProbe(p,uuid)).ok,15000,'Data channel absent');
  const routing=check(await director.waitForStatsInfo(p,uuid,`info => info.room_init_received === true && info.assigned_role === '${role}' && info.assigned_tier === '${tier}'`,15000),role+' routing').state.info;
  await waitFor(()=>p.evaluate(({uuid,width,height})=>[...document.querySelectorAll('video')].some(v=>(v.dataset.sid===window.session.rpcs[uuid].streamID||v.id===`videosource_${uuid}`)&&v.videoWidth===width&&v.videoHeight===height&&!v.paused&&v.currentTime>0),{uuid,width,height}),25000,'Decoded dimensions absent for '+role);
  const media=await observe(p,4000,uuid);const distinct=requireMoving(media,role);assert.equal(media.width,width);assert.equal(media.height,height);
  const audio=await observeAudio(p,uuid);assert(audio.spectra.filter(s=>s.rms>.001&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length>=25,'Stereo missing/crossed: '+role);
  return {routing,media,distinct,audio};
}
async function phase(name){
  console.log('Phase: '+name);const entry={name,roomQualityLq:config.roomQualityLq,passed:false};result.phases.push(entry);checkpoint();
  const tier=config.roomQualityLq?'lq':'hq',w=config.roomQualityLq?640:1280,h=config.roomQualityLq?360:720;
  const dir=await pageAt(director.buildDirectorUrl(directorConfig)+'&stereo=1');
  check(await director.waitForDirectorPeer(dir,directorConfig),'Director peer');
  const scene=await pageAt(`https://vdo.ninja/?scene=0&room=${config.room}&password=${config.password}&autostart&stereo=1&cleanoutput`);
  entry.director=await receiver(dir,'director',tier,w,h);entry.scene=await receiver(scene,'scene','hq',1280,720);
  const guest=await pageAt(`https://vdo.ninja/?room=${config.room}&password=${config.password}&stereo=1&label=ControlledGuest&easyexit`);
  await guest.getByText('Join Room with Camera',{exact:true}).click();await guest.locator('#gowebcam').waitFor({state:'visible'});
  const devices=await guest.locator('#videoSourceSelect option').allTextContents();assert(devices.some(n=>n.startsWith('fake_device_')));assert(devices.every(n=>n.startsWith('fake_device_')||n==='Disable Video'));
  await waitFor(()=>guest.locator('#gowebcam').isEnabled(),15000,'Guest devices not ready');await guest.locator('#gowebcam').focus();await guest.locator('#gowebcam').press('Enter');
  entry.guest=await receiver(guest,'guest',tier,w,h);
  const guestStream=await guest.evaluate(()=>window.session.streamID);assert(guestStream&&guestStream!==config.stream);
  entry.guestPublished=await waitFor(()=>dir.evaluate(async id=>{const pc=Object.values(window.session.rpcs).find(pc=>pc.streamID===id);if(!pc)return null;
    const stats=[...await pc.getStats()].map(([,s])=>s).filter(s=>s.type==='inbound-rtp');const video=stats.find(s=>s.kind==='video'&&s.framesDecoded>15),audio=stats.find(s=>s.kind==='audio'&&s.packetsReceived>15);return video&&audio?{video,audio}:null;
  },guestStream),15000,'Director did not receive guest publication');
  entry.diagnostics=await api(control,'/diagnostics');const d=entry.diagnostics;
  assert.equal(d.signaling.password_disabled,false);assert.equal(d.room_quality.requested,config.roomQualityLq);assert.equal(d.room_quality.effective,config.roomQualityLq);
  assert.equal(d.room_quality.reason,config.roomQualityLq?'enabled':'not-requested');assert.equal(d.video.lq_encoder_initialized,config.roomQualityLq);
  for(const [role,assigned] of [['director',tier],['scene','hq'],['guest',tier]])assert(d.peers.some(p=>p.room.role===role&&p.room.assigned_tier===assigned));
  if(config.roomQualityLq){assert(d.peer_counts.hq>=1&&d.peer_counts.lq>=2);assert(d.video.lq_encoder.includes('x264'));}else{assert(d.peer_counts.hq>=3);assert.equal(d.peer_counts.lq,0);}
  await guest.screenshot({path:path.join(report,name+'-guest.png')});
  for(const p of [guest,scene,dir])await p.close();
  await waitFor(async()=>(await api(control,'/diagnostics')).peers.length===0,15000,'Room peers not retired');
  entry.passed=true;checkpoint();
}
(async()=>{console.log('Reports: '+report);try{
  fixture=await adapter.create(opts,report);
  browser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});result.browserVersion=browser.version();
  await start(1,false);await phase('hq-configured');await quit();
  await start(2,true);await phase('hq-restored');await gui.stop();config.roomQualityLq=true;await gui.setRoomQuality(true);await gui.goLive();await phase('lq-enabled');await quit();
  await start(3,true);await phase('lq-restored');await quit();
  logs.push(path.join(report,'private-state/GameCapture/logs/game-capture-debug.log'));
  result.credentialLogsChecked=logs.map(file=>{const text=fs.readFileSync(file,'utf8');assert(!text.includes(config.password)&&!text.includes(config.remoteToken),'Credential exposed in app log');return {file:path.relative(report,file),sha256:sha(file)};});
  result.passed=true;
}catch(e){result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;
}finally{
  try{
    if(publisher&&publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGTERM');await Promise.race([publisher.closed,sleep(5000)]);if(publisher.exitCode===null&&!publisher.signalCode){publisher.kill('SIGKILL');await publisher.closed;}result.forcedPublisherCleanup=true;}
    if(browser)await browser.close();if(fixture){await fixture.close();result.desktop=fixture.evidence;}
  }catch(e){result.cleanupError=String(e.stack||e);result.passed=false;process.exitCode=1;}
  checkpoint();console.log(JSON.stringify({report,passed:result.passed}));
}})();
