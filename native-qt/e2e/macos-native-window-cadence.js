#!/usr/bin/env node
'use strict';
// Independent AppKit source -> packaged ScreenCaptureKit publisher -> browser.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,observeDecoded,requireMoving}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');for(const k of ['app','fixture','reports'])assert(opts[k],'Missing --'+k);
const seconds=Number(opts.seconds||30);assert(Number.isInteger(seconds)&&seconds>=10&&seconds<=120);
const encoder=opts.encoder||'x264';assert(['x264','videotoolbox'].includes(encoder));
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Owned native AppKit window, video-only 720p60, packaged publisher and local browser; bounded cadence diagnosis, not endurance or release qualification',
  executableSha256:hash(exe),fixtureSha256:hash(fixture),harnessSha256:hash(__filename),encoder,seconds,chunks:[],passed:false};
for(const name of ['macos-native-window-cadence.js','macos-media-receiver.js','macos-alpha-fixture.mm'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let browser,source,publisher,control,sourceRows=[];
function launch(file,args,name){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
  const child=spawn(file,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);
  const log=fs.createWriteStream(path.join(report,name+'.log'));log.on('error',()=>child.kill('SIGTERM'));
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
  child.on('error',e=>{result.launchError=String(e);});return child;
}
async function state(){const start=sourceRows.length;source.stdin.write('state\n');
  await waitFor(()=>sourceRows.slice(start).some(r=>r.state),5000,'Native fixture state missing');return sourceRows.slice(start).find(r=>r.state);}
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Local control HTTP '+r.status);return r.json();}
(async()=>{console.log('Reports: '+report);try{
  const title='Mac Native Cadence '+crypto.randomBytes(8).toString('hex');
  source=launch(fixture,[title,'0','60'],'fixture');let pending='';
  source.stdout.on('data',b=>{pending+=b;let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(line.startsWith('{'))sourceRows.push(JSON.parse(line));}});
  await waitFor(()=>sourceRows.some(r=>r.windowId),10000,'Native fixture not ready');
  result.source=sourceRows.find(r=>r.windowId);source.stdin.write('resize 1280 720\n');await sleep(500);
  const discovery=path.join(report,'control.json'),stream='gcnative'+crypto.randomBytes(12).toString('hex');
  publisher=launch(exe,['--headless','--window='+title,'--stream='+stream,'--password=false','--audio-source=none',
    '--video-encoder='+encoder,'--video-codec=h264','--width=1280','--height=720','--fps=60','--bitrate-kbps=4000',
    '--duration-ms='+((seconds+90)*1000),'--local-control','--local-control-port=0','--local-control-discovery='+discovery],'publisher');
  await waitFor(()=>fs.existsSync(discovery),15000,'Publisher control missing');control=JSON.parse(fs.readFileSync(discovery));
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();const page=await receiver(browser,stream,publisher);
  for(let elapsed=0;elapsed<seconds;elapsed+=10){
    const beforeSource=await state(),before=await api('/diagnostics'),began=Date.now();
    const observation=await observeDecoded(page,Math.min(10,seconds-elapsed)*1000,null,'syphon');
    const after=await api('/diagnostics'),ended=Date.now(),afterSource=await state();
    const distinct=requireMoving(observation,encoder),duration=(observation.ended-observation.started)/1000;
    const sourceSeconds=afterSource.monotonicSeconds-beforeSource.monotonicSeconds;
    assert(Number.isFinite(sourceSeconds)&&sourceSeconds>0,'Fixture must report monotonic sample times');
    const sourceFps=(afterSource.paintCount-beforeSource.paintCount)/sourceSeconds;
    const receivedFps=distinct/duration,captureFps=(after.video.frames_captured-before.video.frames_captured)/((ended-began)/1000);
    const meetsTarget=sourceFps>=57&&receivedFps>=57&&observation.width===1280&&observation.height===720&&
      after.video.encode_failures===before.video.encode_failures&&after.video.encode_timeouts===before.video.encode_timeouts;
    result.chunks.push({elapsed,sourceFps,receivedFps,captureFps,meetsTarget,beforeSource,afterSource,before,after,observation});
    fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
    console.log(encoder+': '+(elapsed+10)+'s native='+sourceFps.toFixed(1)+' capture='+captureFps.toFixed(1)+' decoded='+receivedFps.toFixed(1)+' target='+meetsTarget);
  }
  const d=await api('/diagnostics');assert.equal(d.source.source_id,String(result.source.windowId));
  assert.equal(d.video.hardware_encoder,encoder==='videotoolbox');
  source.stdin.write('pause\n');await sleep(800);result.static=await observeDecoded(page,2000,null,'syphon');
  assert.equal(new Set(result.static.observations.map(f=>f.id)).size,1);assert(result.static.observations.length>50);
  source.stdin.write('resume\n');await sleep(500);result.resumed=await observeDecoded(page,2000,null,'syphon');requireMoving(result.resumed,'resumed');
  await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher quit failed');
  result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));
  source.stdin.write('quit\n');await waitFor(()=>source.exitCode!==null,5000,'Fixture quit failed');result.fixtureExit=await source.closed;assert.equal(result.fixtureExit.code,0);
  result.functionalPassed=true;result.passed=result.chunks.every(c=>c.meetsTarget);
}catch(e){result.error=String(e.stack||e);console.error(result.error);}finally{
  for(const child of children)child.kill('SIGTERM');if(browser)await browser.close().catch(()=>{});
  await Promise.all([...children].map(c=>Promise.race([c.closed,sleep(5000)])));
  for(const child of children)child.kill('SIGKILL');
  fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({report,passed:result.passed}));if(!result.passed)process.exitCode=1;
}})();
