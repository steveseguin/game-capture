#!/usr/bin/env node
'use strict';
// One packaged publisher and one native OBS subscription across capture changes.
// All inputs are owned fixtures; OBS frontend and physical devices are excluded.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{chromium}=require('playwright'),{sleep,waitFor,receiver}=require('./macos-media-receiver');
const {analyze,analyzeComposition,analyzeBlackScene}=require('./macos-alpha-analyzer');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
for(const k of ['app','fixture','receiver','plugin','plugin-data','reports'])assert(opts[k],'Missing --'+k);
assert.equal(process.platform,'darwin');
for(const k of ['app','fixture','receiver','plugin','plugin-data'])assert(fs.existsSync(path.resolve(opts[k])),'Missing path --'+k);
const lateNative=opts['late-native']==='true';
const sceneContinuity=opts['scene-continuity']==='true',lossWhileSuspended=opts['loss-while-suspended']||'none';
assert(['none','destroy','owner'].includes(lossWhileSuspended));
const sourceMode=opts.source||'window',codec=opts.codec||'h264',encoder=opts.encoder||'videotoolbox';
assert(['window','syphon'].includes(sourceMode));assert(lossWhileSuspended==='none'||sourceMode==='window');assert(!lateNative||sourceMode==='window');assert(['h264','vp9'].includes(codec));
assert(codec==='vp9'?encoder==='software':['videotoolbox','x264'].includes(encoder));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture),nativeExe=path.resolve(opts.receiver);
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result={scope:'Packaged native alpha viewer continuity through owned source resize and window suspension (or Syphon static texture); final actual OBS composition. GUI/physical devices/Windows excluded',
 sceneContinuity,lateNative,lossWhileSuspended,sourceMode,codec,encoder,executableSha256:hash(exe),fixtureSha256:hash(fixture),receiverSha256:hash(nativeExe),pluginSha256:hash(path.resolve(opts.plugin)),
 harnessSha256:hash(__filename),analyzerSha256:hash(path.join(__dirname,'macos-alpha-analyzer.js')),phases:[],passed:false};
for(const f of ['macos-alpha-continuity.js','macos-alpha-analyzer.js','macos-obs-alpha-receiver.cpp','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,f),path.join(report,f));
const children=new Set();let control,browser;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
function launch(command,args,label){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
 const child=spawn(command,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
 const log=fs.createWriteStream(path.join(report,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 child.stdout.on('data',b=>child.output=(child.output+b.toString()).slice(-65536));
 child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
 child.on('error',error=>{result.launchError=String(error);});return child;
}
async function api(route,body){const response=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(response.ok,'HTTP '+response.status);return response.json();}
const peerIdentity=d=>d.peers.map(p=>({uuid:p.uuid,created:p.created_steady_ms,wire:p.active_wire_session})).sort((a,b)=>a.uuid.localeCompare(b.uuid));
(async()=>{console.log('Reports: '+report);try{
 const remoteToken=crypto.randomBytes(24).toString('hex');
 const title='Owned Alpha Continuity '+crypto.randomBytes(12).toString('hex'),stream='alphacontinuity'+crypto.randomBytes(12).toString('hex');
 const source=launch(fixture,[title],'fixture');
 await waitFor(()=>{assert(source.exitCode===null&&!source.signalCode);return source.output.includes(sourceMode==='syphon'?'uuid':'windowId');},10000,'Fixture unavailable');
 const identity=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{'))),id=String(identity.uuid||identity.windowId);result.fixture=identity;
 const discovery=path.join(report,'control.json');
 const publisher=launch(exe,['--headless',...(sourceMode==='syphon'?['--source=syphon',`--syphon-server=${id}`]:[`--window=${title}`]),
  `--stream=${stream}`,'--password=false',`--video-codec=${codec}`,`--video-encoder=${encoder}`,'--alpha-workflow','--audio-source=none','--remote-control',`--remote-token=${remoteToken}`,
  '--width=640','--height=360','--fps=30','--bitrate-kbps=4000','--duration-ms=180000','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher');
 await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode);return fs.existsSync(discovery);},15000,'Publisher unavailable');
 control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
 await waitFor(async()=>{const d=await api('/diagnostics');return d.app.live&&d.source.has_frame&&d.source.alpha_detected;},15000,'Alpha source unavailable');
 const received=path.join(report,'receiver');fs.mkdirSync(received);
 const native=launch(nativeExe,[path.resolve(opts['obs-app']||'/Applications/OBS.app'),path.resolve(opts.plugin),path.resolve(opts['plugin-data']),stream,received,'--controlled'],'receiver');
 await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode);return native.output.includes('RECEIVER_READY');},15000,'Receiver unavailable');
 async function commandFor(target,value){target.output='';target.stdin.write(value+'\n');await waitFor(()=>{assert(target.exitCode===null&&!target.signalCode);return target.output.includes('ACK '+value);},5000,'Receiver command incomplete: '+value);}
 const command=value=>commandFor(native,value);
 const frames=data=>sceneContinuity?data.blackComposition:data.samples;
 const validFrame=(sample,widths)=>{
  if(sceneContinuity){try{analyzeBlackScene([sample],{nativeWidths:widths,minSamples:1,minIdentities:1});return true;}catch{return false;}}
  return widths.some(width=>{try{analyze({samples:[sample]},{nativeWidth:width,minSamples:1,minIdentities:1});return true;}catch{return false;}});
 };
 async function snapshot(label){
  await command('snapshot '+label);const data=JSON.parse(fs.readFileSync(path.join(received,label+'.json')));
  const observed=frames(data);
  for(let i=1;i<observed.length;i++)assert(BigInt(observed[i].timestamp)>BigInt(observed[i-1].timestamp),'Native timestamps moved backwards across a transition');
  return data;
 }
 if(sceneContinuity)await command('compose black');
 browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
 const page=await receiver(browser,stream,publisher);
 await sleep(2000);result.initialDiagnostics=await api('/diagnostics');const peers=peerIdentity(result.initialDiagnostics);assert(peers.length>0,'No connected receiver');
 async function check(label,widths=[640],duration=4000,minIdentities=30,alreadyMarked=false){
  if(!alreadyMarked)await command('mark '+label);await sleep(duration);const data=await snapshot(label),samples=frames(data).filter(s=>s.segment===label),d=await api('/diagnostics');
  const summary={label,samples:samples.length,distinctIdentities:new Set(samples.map(s=>s.identity)).size,source:[d.source.width,d.source.height],decodedSizes:[...new Set(samples.map(s=>s.width+'x'+s.height))],diagnostics:d,failedFrames:[]};result.phases.push(summary);
  assert(samples.length>=60,'Too few native frames in '+label);assert(summary.distinctIdentities>=minIdentities,'Frozen native frames in '+label);
  for(const sample of samples){
   if(!validFrame(sample,widths))summary.failedFrames.push(sample.identity);
  }
  assert.equal(summary.failedFrames.length,0,'Color/alpha/identity mismatch in '+label+': '+JSON.stringify(summary.failedFrames.slice(0,10)));
  assert.equal(data.sourceCreations,1);assert.deepEqual(peerIdentity(d),peers,'Native peer recreated in '+label);
  assert.equal(d.source.source_id,id);assert.equal(d.video.alpha_enabled,true);
  for(const key of ['encode_failures','encode_timeouts','alpha_encode_failures','alpha_encode_timeouts','alpha_contract_rejected_pairs'])assert.equal(d.video[key],0,key);
  for(let i=1;i<samples.length;i++)assert(BigInt(samples[i].timestamp)>BigInt(samples[i-1].timestamp),'Native timestamps did not advance');
  save();return summary;
 }
 async function sourceSize(width,height){
  if(sourceMode==='syphon'){const d=await api('/diagnostics');return d.source.width===width&&d.source.height===height;}
  return (await api('/sources/windows')).sources.some(s=>s.id===id&&s.width===width&&s.height===height);
 }
 async function outputSize(width,height){
  // A resolution preset is one authorized update. Separate width/height
  // commands intentionally create an intermediate aspect ratio and letterbox.
  const sent=await page.evaluate(({width,height,remoteToken})=>{
   const peer=Object.keys(window.session?.rpcs||{})[0];
   return !!peer&&window.session.sendRequest({requestResolution:width+'x'+height,remote:remoteToken},peer)!==false;
  },{width,height,remoteToken});assert(sent,'Remote output resize unavailable');
  await waitFor(async()=>{const d=await api('/diagnostics');return d.video.configured_width===width&&d.video.configured_height===height;},10000,'Output size change not committed');
  await waitFor(()=>fs.readFileSync(path.join(report,'receiver.log'),'utf8').includes('Native receiver video resolution changed to '+width+'x'+height),10000,'Native decoder did not accept output size');
 }
 await check('baseline');
 if(sourceMode==='window'){
  source.stdin.write('minimize\n');await waitFor(async()=>(await api('/diagnostics')).source.suspended,10000,'Window did not suspend');await sleep(1000);
  const before=await api('/diagnostics');await command('mark paused');await sleep(6000);const held=await snapshot('paused'),after=await api('/diagnostics');
  const heldFrames=frames(held).filter(s=>s.segment==='paused');
  result.suspended={frames:heldFrames.length,before,after};
  if(sceneContinuity)result.suspended.scene=analyzeBlackScene(heldFrames,{minIdentities:1});
  else result.suspended.raw=analyze({samples:heldFrames},{minIdentities:1});
  assert.equal(new Set(heldFrames.map(s=>s.identity)).size,1,'Held image changed while source suspended');
  assert.equal(after.video.frames_captured,before.video.frames_captured,'Suspended capture counter advanced');
  assert(after.video.frames_sent>before.video.frames_sent,'Held image was not sent');
  assert(after.video.alpha_packets_sent>before.video.alpha_packets_sent,'Held alpha mask was not sent');
  assert.deepEqual(peerIdentity(after),peers,'Peer changed while suspended');assert(after.app.live&&after.source.suspended);
  if(lateNative){
   const lateDir=path.join(report,'late-receiver');fs.mkdirSync(lateDir);
   const late=launch(nativeExe,[path.resolve(opts['obs-app']||'/Applications/OBS.app'),path.resolve(opts.plugin),path.resolve(opts['plugin-data']),stream,lateDir,'--controlled'],'late-receiver');
   await waitFor(()=>{assert(late.exitCode===null&&!late.signalCode);return late.output.includes('RECEIVER_READY');},15000,'Late native receiver did not initialize');
   await waitFor(async()=>{await commandFor(late,'snapshot warmup');return JSON.parse(fs.readFileSync(path.join(lateDir,'warmup.json'))).samples.length>=15;},20000,'Late native viewer did not decode held alpha');
   await commandFor(late,'mark held');await sleep(3000);await commandFor(late,'snapshot held');
   const data=JSON.parse(fs.readFileSync(path.join(lateDir,'held.json'))),samples=data.samples.filter(s=>s.segment==='held');
   result.lateNative={raw:analyze({samples},{minIdentities:1})};assert.equal(result.lateNative.raw.distinctIdentities,1);
   assert.equal(samples[0].identity,heldFrames[0].identity,'Late native viewer got a different held image');
   const during=await api('/diagnostics');assert(during.source.suspended);assert.equal(during.video.frames_captured,before.video.frames_captured);
   for(const peer of peers)assert(peerIdentity(during).some(p=>JSON.stringify(p)===JSON.stringify(peer)),'Existing peer replaced by late native join');
   late.stdin.write('quit\n');await waitFor(()=>late.exitCode!==null,10000,'Late receiver did not quit');result.lateNative.exit=await late.closed;assert.equal(result.lateNative.exit.code,0);
   await waitFor(async()=>JSON.stringify(peerIdentity(await api('/diagnostics')))===JSON.stringify(peers),15000,'Late native peer was not removed');
  }
  if(lossWhileSuspended!=='none'){
   const started=Date.now();source.stdin.write(lossWhileSuspended==='destroy'?'destroy-window\n':'quit\n');
   await waitFor(()=>publisher.exitCode!==null,10000,'Publisher retained a held image after permanent source loss');
   result.sourceLossMs=Date.now()-started;assert(result.sourceLossMs<5000);result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,3);
   assert(!fs.existsSync(discovery));assert(fs.readFileSync(path.join(report,'publisher.log'),'utf8').includes('Window capture stopped'));
   if(lossWhileSuspended==='destroy'){assert(source.exitCode===null&&!source.signalCode,'Fixture owner should still be alive');source.stdin.write('quit\n');}
   await waitFor(()=>source.exitCode!==null,5000,'Fixture did not quit');assert.equal((await source.closed).code,0);
   native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null,10000,'Receiver did not quit');result.receiverExit=await native.closed;assert.equal(result.receiverExit.code,0);
   result.passed=true;return;
  }
  source.stdin.write('restore\n');await waitFor(async()=>!(await api('/diagnostics')).source.suspended,10000,'Window did not resume');
  await check('restored');
 }else{
  source.stdin.write('pause\n');await sleep(800);const held=await check('static',[640],4000,1);assert.equal(held.distinctIdentities,1);
  source.stdin.write('resume\n');await check('resumed');
 }
 // Record every frame during the transition; each must match either complete
 // old geometry or complete new geometry, including its paired alpha edge.
 await command('mark resize-transition');source.stdin.write('resize 1280 720\n');
 await waitFor(()=>sourceSize(1280,720),10000,'Source did not grow');
 await sleep(3000);const transition=await snapshot('resize-transition');
 for(const sample of frames(transition).filter(s=>s.segment==='resize-transition')){
  assert(validFrame(sample,[640,1280]),'Mismatched frame during resize transition: '+sample.identity);
 }
 result.resizeTransitionFrames=frames(transition).filter(s=>s.segment==='resize-transition').length;assert(result.resizeTransitionFrames>=60);
 await check('resized',[1280]);
 await command('mark output-enlarged');await outputSize(960,540);await check('output-enlarged',[1280],4000,30,true);
 await command('mark output-reduced');await outputSize(640,360);await check('output-reduced',[1280],4000,30,true);
 await command('mark shrink-transition');source.stdin.write('resize 640 360\n');
 await waitFor(()=>sourceSize(640,360),10000,'Source did not restore');
 await sleep(3000);const shrinking=await snapshot('shrink-transition');
 for(const sample of frames(shrinking).filter(s=>s.segment==='shrink-transition')){
  assert(validFrame(sample,[640,1280]),'Mismatched frame during shrink transition: '+sample.identity);
 }
 result.shrinkTransitionFrames=frames(shrinking).filter(s=>s.segment==='shrink-transition').length;assert(result.shrinkTransitionFrames>=60);
 await check('size-restored');
 await command('compose black');await sleep(4500);await command('compose white');await sleep(4500);
 result.nativeDecodedResolutions=[...fs.readFileSync(path.join(report,'receiver.log'),'utf8').matchAll(/Native receiver video resolution changed to (\d+x\d+)/g)].map(m=>m[1]);
 assert.deepEqual(result.nativeDecodedResolutions,['640x360','960x540','640x360']);
 const composed=await snapshot('composition');
 if(sceneContinuity)composed.blackComposition=composed.blackComposition.filter(s=>s.segment!=='warmup');
 result.composition=analyzeComposition(composed);assert.deepEqual(peerIdentity(await api('/diagnostics')),peers);
 native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null,10000,'Native receiver did not quit');result.receiverExit=await native.closed;assert.equal(result.receiverExit.code,0);
 await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));
 source.stdin.write('quit\n');await waitFor(()=>source.exitCode!==null,5000,'Fixture did not quit');assert.equal((await source.closed).code,0);result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
 if(control){try{result.failureDiagnostics=await api('/diagnostics');}catch{}}
}finally{
 if(browser)await browser.close();
 for(const child of children)child.kill('SIGTERM');
 await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
 save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
