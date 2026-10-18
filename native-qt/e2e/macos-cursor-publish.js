#!/usr/bin/env node
'use strict';
// Actual packaged publisher and received pixels; fixture commands are local
// stdin controls, not VDO.Ninja APIs. The app uses its existing local API.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {chromium}=require('playwright');
const {receiver,waitFor,sleep}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const name of ['app','fixture','reports','expected-cursor'])assert(opts[name],'Missing --'+name);
assert(['included','excluded'].includes(opts['expected-cursor']));
const encoder=opts.encoder||'videotoolbox';assert(['videotoolbox','x264'].includes(encoder));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={scope:'Packaged capture of an owned window with a controlled native cursor, received H.264 pixels in headless Chromium; no physical-device or full production qualification',
  started:new Date().toISOString(),finished:false,
  encoder,expectedCursor:opts['expected-cursor'],baselinePositiveControl:opts['expected-cursor']==='included',windowsParityPassed:false,
  executableSha256:hash(exe),fixtureSha256:hash(fixture),
  fixtureSourceSha256:hash(path.join(__dirname,'macos-cursor-fixture.mm')),harnessSha256:hash(__filename),phases:[],passed:false};
for(const file of ['macos-cursor-fixture.mm','macos-cursor-publish.js','macos-media-receiver.js'])
  fs.copyFileSync(path.join(__dirname,file),path.join(report,file));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
let source,publisher,browser,control;
const children=new Set();
function launch(executable,args,label){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
  const child=spawn(executable,args,{env,stdio:['pipe','pipe','pipe']});children.add(child);child.lines=[];
  const log=fs.createWriteStream(path.join(report,label+'.log'));let pending='';
  child.stdout.on('data',buffer=>{log.write(buffer);pending+=buffer.toString();let i;
    while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(line.startsWith('{')){try{child.lines.push(JSON.parse(line));}catch{}}}});
  child.stderr.pipe(log,{end:false});
  child.stdin.on('error',error=>{(result.pipeErrors??=[]).push({label,error:String(error)});});
  child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
  child.once('error',error=>{result.launchError=String(error);});return child;
}
async function api(route,body){
  const response=await fetch(control.base_url+route,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(response.ok,'Local control HTTP '+response.status);return response.json();
}
async function fixtureCommand(command,predicate){
  const start=source.lines.length;source.stdin.write(command+'\n');
  await waitFor(()=>{assert(source.exitCode===null&&!source.signalCode,'Fixture exited');
    const lines=source.lines.slice(start);assert(!lines.some(x=>x.error),'Fixture refused operation');return lines.some(predicate);},5000,'Fixture response missing');
  return source.lines.slice(start).find(predicate);
}
function assertCursorState(state,mode){
  assert(state.inside&&state.atControlledPoint&&state.mode===mode,'Cursor control not established');
  const x=mode==='transparent'?80:480;
  assert(Math.abs(state.localX-x)<=2&&Math.abs(state.localY-90)<=2,'Pointer outside intended pixel probe');
}
async function observe(page){return page.evaluate(async()=>{
  const received=window.reviewPCs.filter(p=>p.connectionState==='connected').flatMap(p=>p.getReceivers())
    .map(r=>r.track).find(t=>t?.kind==='video'&&t.readyState==='live');
  if(!received)throw Error('No received video track');
  const track=received.clone(),reader=new MediaStreamTrackProcessor({track,maxBufferSize:4}).readable.getReader();
  const canvas=new OffscreenCanvas(640,360),ctx=canvas.getContext('2d',{willReadFrequently:true}),samples=[];
  let snapshot=null;const timer=setTimeout(()=>reader.cancel().catch(()=>{}),6000);
  try{while(true){const {done,value:frame}=await reader.read();if(done)break;
    try{
      if(frame.displayWidth!==640||frame.displayHeight!==360)throw Error('Unexpected received dimensions');
      ctx.drawImage(frame,0,0,640,360);const bar=ctx.getImageData(0,20,640,1).data;let id=0;
      for(let bit=0;bit<16;bit++)if(bar[(bit*40+20)*4]>127)id|=1<<bit;
      const regions=[80,480].map((x,index)=>{
        const pixels=ctx.getImageData(x-20,70,40,40).data,expected=index?[240,60,30]:[0,255,0];
        let expectedPixels=0;
        for(let i=0;i<pixels.length;i+=4){
          if(expected.every((v,c)=>Math.abs(pixels[i+c]-v)<=20))expectedPixels++;
        }
        return {unexpectedPixels:1600-expectedPixels,expectedPixels,pixels:1600};
      });
      samples.push({id,mediaTime:frame.timestamp/1e6,regions});
      if(!snapshot){const png=await canvas.convertToBlob({type:'image/png'});snapshot=Array.from(new Uint8Array(await png.arrayBuffer()));}
    }finally{frame.close();}
  }}finally{clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();track.stop();}
  const codecs=[];
  for(const pc of window.reviewPCs.filter(p=>p.connectionState==='connected'))for(const item of (await pc.getStats()).values())
    if(item.type==='codec'&&item.mimeType)codecs.push(item.mimeType);
  return {samples,snapshot,codecs};
});}
(async()=>{
  try{
    const title='Mac Cursor Fixture '+crypto.randomBytes(6).toString('hex'),stream='maccursor'+crypto.randomBytes(12).toString('hex');
    source=launch(fixture,[title],'fixture');
    await waitFor(()=>source.lines.some(x=>x.ready),10000,'Owned fixture not ready');result.fixture=source.lines.find(x=>x.ready);save();
    const discovery=path.join(report,'control.json');
    publisher=launch(exe,['--headless','--window='+title,'--stream='+stream,'--password=false','--video-codec=h264',
      '--video-encoder='+encoder,'--audio-source=none','--alpha-background=chroma','--alpha-background-color=#00FF00',
      '--width=640','--height=360','--fps=30','--bitrate-kbps=4000','--duration-ms=90000',
      '--local-control','--local-control-port=0','--local-control-discovery='+discovery],'publisher');
    await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited');return fs.existsSync(discovery);},15000,'Control unavailable');
    control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
    browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
    result.browserVersion=browser.version();const page=await receiver(browser,stream,publisher);
    for(const mode of ['park','transparent','opaque']){
      const phase={mode};result.phases.push(phase);save();
      phase.command=await fixtureCommand(mode,x=>x.command===mode);assert.equal(phase.command.warpError,0);
      await sleep(1000);phase.before=await fixtureCommand('state',x=>x.state);
      assertCursorState(phase.before,mode);
      const data=await observe(page);phase.after=await fixtureCommand('state',x=>x.state);
      fs.writeFileSync(path.join(report,mode+'.png'),Buffer.from(data.snapshot));delete data.snapshot;
      phase.observation=data;save();
      assertCursorState(phase.after,mode);
      assert(data.codecs.some(c=>c.toLowerCase()==='video/h264'));assert(new Set(data.samples.map(x=>x.id)).size>=60,'Insufficient moving content');
      for(let i=1;i<data.samples.length;i++)assert((data.samples[i].id-data.samples[i-1].id+65536)%65536<=90,'Corrupt/reversed fixture identity');
      const target=mode==='opaque'?1:0,wantCursor=mode!=='park'&&opts['expected-cursor']==='included';
      phase.invalidFrames=data.samples.filter(s=>{
        if(opts['expected-cursor']==='excluded')return s.regions.some(r=>r.unexpectedPixels!==0);
        if(!wantCursor)return s.regions[target].unexpectedPixels!==0;
        return s.regions[target].unexpectedPixels<100||s.regions[1-target].unexpectedPixels!==0;
      }).length;
      phase.passed=phase.invalidFrames===0;save();
    }
    assert(result.phases.every(p=>p.passed),'Received cursor/background differs from expectation; all pixel phases retained');
    result.diagnostics=await api('/diagnostics');
    assert.equal(result.diagnostics.video.hardware_encoder,encoder==='videotoolbox');
    assert.equal(result.diagnostics.video.encode_failures,0);assert.equal(result.diagnostics.video.encode_timeouts,0);
    await api('/commands',{command:'quit'});result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);
    assert(!fs.existsSync(path.join(report,'control.json')),'Control discovery remains after quit');result.passed=true;
  }catch(error){result.error=String(error.stack||error);process.exitCode=1;}
  finally{
    if(source&&source.exitCode===null&&!source.signalCode){source.stdin.write('quit\n');await Promise.race([source.closed,sleep(3000)]);}
    result.fixtureCleanup=source?.lines.find(x=>x.cleanup)||null;
    if(!result.fixtureCleanup?.pointerRestored){result.passed=false;result.cleanupError='Pointer restoration unverified';process.exitCode=1;}
    await browser?.close().catch(()=>{});
    for(const child of children)child.kill('SIGTERM');
    await Promise.all([...children].map(c=>Promise.race([c.closed,sleep(3000)])));
    result.windowsParityPassed=result.passed&&opts['expected-cursor']==='excluded';
    result.finished=true;result.ended=new Date().toISOString();
    save();console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
  }
})();
