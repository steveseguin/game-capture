#!/usr/bin/env node
'use strict';
// Keep the real native OBS source alive across packaged publisher relaunches.
// This exercises CLI process recovery, not same-process GUI source selection.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const {analyze,analyzeBlackScene}=require('./macos-alpha-analyzer');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','fixture','receiver','plugin','plugin-data','reports'])assert(opts[key],'Missing --'+key);
const codec=opts.codec||'h264',encoder=opts.encoder||'videotoolbox',scene=opts.scene!=='false';
assert(['h264','vp9'].includes(codec));assert(codec==='vp9'?encoder==='software':['videotoolbox','x264'].includes(encoder));
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture),receiver=path.resolve(opts.receiver);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result={scope:'Existing native OBS subscription across three packaged CLI publisher generations with distinct owned replacement windows; no same-process GUI or Windows claim',
 codec,encoder,scene,executableSha256:hash(exe),fixtureSha256:hash(fixture),receiverSha256:hash(receiver),pluginSha256:hash(path.resolve(opts.plugin)),
 harnessSha256:hash(__filename),analyzerSha256:hash(path.join(__dirname,'macos-alpha-analyzer.js')),generations:[],passed:false};
for(const name of ['macos-alpha-reconnect.js','macos-alpha-fixture.mm','macos-alpha-analyzer.js','macos-media-receiver.js','macos-obs-alpha-receiver.cpp'])
 fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let native,control;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
function launch(command,args,label){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
 const child=spawn(command,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
 const log=fs.createWriteStream(path.join(report,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 child.stdout.on('data',b=>child.output=(child.output+b.toString()).slice(-65536));
 child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
 child.once('error',e=>{result.launchError=String(e);});return child;
}
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'Local control HTTP '+r.status);return r.json();}
async function command(value){native.output='';native.stdin.write(value+'\n');await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode,'Native receiver exited');return native.output.includes('ACK '+value);},5000,'Native receiver did not acknowledge '+value);}
const output=path.join(report,'receiver');fs.mkdirSync(output);
async function snapshot(label){await command('snapshot '+label);const d=JSON.parse(fs.readFileSync(path.join(output,label+'.json')));assert.equal(d.sourceCreations,1);return scene?d.blackComposition:d.samples;}
function validate(samples,initial,minIdentities=30){
 assert(samples.every(s=>s.identity>initial&&s.identity<initial+10000),'Received a retired or invalid fixture generation');
 for(let i=1;i<samples.length;i++)assert(BigInt(samples[i].timestamp)>BigInt(samples[i-1].timestamp),'Output timestamps did not advance');
 return scene?analyzeBlackScene(samples,{minIdentities}):analyze({samples},{minIdentities});
}
function helperPids(pid){return execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
 const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&Number(m[2])===pid&&path.basename(m[3])==='ffmpeg'?[Number(m[1])]:[];
});}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
(async()=>{console.log('Reports: '+report);try{
 const stream='macalphareconnect'+crypto.randomBytes(12).toString('hex');
 for(let index=0;index<3;index++){
  const initial=(index+1)*10000,title='Owned Alpha Relaunch '+crypto.randomBytes(12).toString('hex');
  const phase={index,initial,passed:false};result.generations.push(phase);
  const source=launch(fixture,[title,String(initial)],'fixture-'+index);
  await waitFor(()=>{assert(source.exitCode===null&&!source.signalCode);return source.output.includes('windowId');},10000,'Fixture unavailable');
  phase.fixture=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));
  const discovery=path.join(report,'control-'+index+'.json'),started=Date.now();
  const publisher=launch(exe,['--headless',`--window=${title}`,`--stream=${stream}`,'--password=false',`--video-codec=${codec}`,`--video-encoder=${encoder}`,
   '--alpha-workflow','--audio-source=none','--width=640','--height=360','--fps=30','--bitrate-kbps=4000','--duration-ms=90000','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher-'+index);
  phase.publisherPid=publisher.pid;
  await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode);return fs.existsSync(discovery);},15000,'Publisher unavailable');
  control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  await waitFor(async()=>{const d=await api('/diagnostics');return d.app.live&&d.source.has_frame&&d.source.alpha_detected;},15000,'Alpha source unavailable');
  if(!native){
   native=launch(receiver,[path.resolve(opts['obs-app']||'/Applications/OBS.app'),path.resolve(opts.plugin),path.resolve(opts['plugin-data']),stream,output,'--controlled'],'receiver');
   result.receiverPid=native.pid;
   await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode);return native.output.includes('RECEIVER_READY');},15000,'Native receiver unavailable');
   if(scene)await command('compose black');
  }
  const label='generation-'+index;await command('mark '+label);
  await waitFor(async()=>{
   assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited before viewer recovered');
   const samples=(await snapshot('waiting')).filter(s=>s.segment===label).slice(-20);
   return samples.length===20&&samples.every(s=>s.identity>initial&&s.identity<initial+10000);
  },45000,'Existing native OBS subscription did not receive the replacement generation');
  phase.launchToFreshViewerMs=Date.now()-started;
  await command('mark stable-'+index);await sleep(5000);
  const samples=(await snapshot('stable-'+index)).filter(s=>s.segment==='stable-'+index);
  phase.media=validate(samples,initial);phase.diagnostics=await api('/diagnostics');
  const d=phase.diagnostics;assert.equal(d.source.source_id,String(phase.fixture.windowId));assert(d.app.live&&d.video.alpha_enabled);
  assert.equal(d.video.hardware_encoder,encoder==='videotoolbox');
  for(const key of ['encode_failures','encode_timeouts','alpha_encode_failures','alpha_encode_timeouts','alpha_contract_rejected_pairs'])assert.equal(d.video[key],0,key);
  phase.helpers=helperPids(publisher.pid);assert.equal(phase.helpers.length,codec==='vp9'?2:1);
  if(index===1){
   source.stdin.write('minimize\n');await waitFor(async()=>(await api('/diagnostics')).source.suspended,10000,'Source did not suspend');await sleep(1000);
   await command('mark held');await sleep(3000);const held=(await snapshot('held')).filter(s=>s.segment==='held');
   phase.held=validate(held,initial,1);assert.equal(phase.held.distinctIdentities,1);
  }
  await command('mark offline-'+index);const stopped=Date.now();
  phase.stopKind=index===0?'window-destroyed-owner-alive':index===1?'owner-killed-while-minimized':'normal-quit';
  if(index===0)source.stdin.write('destroy-window\n');
  else if(index===1){source.kill('SIGKILL');await waitFor(()=>source.exitCode!==null||source.signalCode,5000,'Owned source process did not exit');await source.closed;}
  else await api('/commands',{command:'quit'});
  await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not exit');phase.publisherExit=await publisher.closed;
  phase.stopMs=Date.now()-stopped;assert(phase.stopMs<5000);assert.equal(phase.publisherExit.code,index<2?3:0);assert(!fs.existsSync(discovery));
  await waitFor(()=>phase.helpers.every(pid=>!alive(pid)),5000,'Retired encoder helper is still running');
  if(index<2)assert(fs.readFileSync(path.join(report,'publisher-'+index+'.log'),'utf8').includes('Window capture stopped'));
  if(index!==1){
   assert(source.exitCode===null&&!source.signalCode,'Fixture owner should still be alive');source.stdin.write('quit\n');
   await waitFor(()=>source.exitCode!==null,5000,'Fixture did not quit');assert.equal((await source.closed).code,0);
  }
  await sleep(3000);assert(native.exitCode===null&&!native.signalCode,'Native receiver exited between publisher generations');
  phase.passed=true;save();
 }
 native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null,10000,'Native receiver did not quit');result.receiverExit=await native.closed;assert.equal(result.receiverExit.code,0);
 result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
 if(control){try{result.failureDiagnostics=await api('/diagnostics');}catch{}}
}finally{
 for(const child of children)child.kill('SIGTERM');
 await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
 save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
