#!/usr/bin/env node
'use strict';
// Actual paired-alpha frames and OBS scenes across owned source aspect changes.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const {analyzeGeometry}=require('./macos-alpha-geometry-analyzer');
const {compressRecording,compressRecordings}=require('./macos-report-recordings');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');for(const k of ['app','fixture','receiver','plugin','plugin-data','reports'])assert(opts[k],'Missing --'+k);
const codec=opts.codec||'h264',encoder=opts.encoder||'videotoolbox',scene=opts.scene!=='false',syphon=opts.source==='syphon';
const observationSeconds=Number(opts['observation-seconds']||4);
assert(Number.isInteger(observationSeconds)&&observationSeconds>=4&&observationSeconds<=12,'--observation-seconds must be 4..12');
assert(!opts.source||['window','syphon'].includes(opts.source));assert(['h264','vp9'].includes(codec));assert(codec==='vp9'?encoder==='software':['videotoolbox','x264'].includes(encoder));
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture),receiver=path.resolve(opts.receiver);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});const output=path.join(report,'receiver');fs.mkdirSync(output);
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result={scope:'One packaged publisher and native OBS source through 16:9, portrait 3:4 and wide 2:1 source resizing; fixed 640x360 output; owned sources only',
 codec,encoder,scene,observationSeconds,source:syphon?'syphon':'window',executableSha256:hash(exe),fixtureSha256:hash(fixture),receiverSha256:hash(receiver),pluginSha256:hash(path.resolve(opts.plugin)),harnessSha256:hash(__filename),phases:[],transitions:[],passed:false};
for(const f of ['macos-alpha-aspect.js','macos-alpha-geometry-analyzer.js','macos-alpha-analyzer.js','macos-obs-alpha-receiver.cpp','macos-media-receiver.js','macos-report-recordings.js'])fs.copyFileSync(path.join(__dirname,f),path.join(report,f));
const children=new Set();let control,native;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
function launch(command,args,label){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
 const child=spawn(command,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
 const log=fs.createWriteStream(path.join(report,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.stdout.on('data',b=>child.output=(child.output+b.toString()).slice(-65536));
 child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));child.once('error',e=>{result.launchError=String(e);});return child;
}
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'HTTP '+r.status);return r.json();}
async function command(value){native.output='';native.stdin.write(value+'\n');await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode);return native.output.includes('ACK '+value);},5000,'Receiver command incomplete: '+value);}
const peerIdentity=d=>d.peers.map(p=>({uuid:p.uuid,created:p.created_steady_ms,wire:p.active_wire_session})).sort((a,b)=>a.uuid.localeCompare(b.uuid));
async function samples(label,composition){await command('snapshot '+label);const file=path.join(output,label+'.json');const d=JSON.parse(fs.readFileSync(file));
 compressRecording(report,path.relative(report,file));assert.equal(d.sourceCreations,1);
 const frames=(composition==='raw'?d.samples:d[composition+'Composition']).filter(f=>f.segment===label);
 assert(frames.length>=60,'Too few frames in '+label);for(let i=1;i<frames.length;i++)assert(BigInt(frames[i].timestamp)>BigInt(frames[i-1].timestamp),'Non-advancing output timestamp');return frames;
}
(async()=>{console.log('Reports: '+report);try{
 const title='Owned Alpha Aspect '+crypto.randomBytes(12).toString('hex'),stream='macalphaaspect'+crypto.randomBytes(12).toString('hex');
 const source=launch(fixture,[title],'fixture');await waitFor(()=>source.output.includes(syphon?'uuid':'windowId'),10000,'Fixture unavailable');
 result.fixture=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));const id=String(result.fixture.uuid||result.fixture.windowId);
 const discovery=path.join(report,'control.json');
 const publisher=launch(exe,['--headless',...(syphon?['--source=syphon',`--syphon-server=${id}`]:[`--window=${title}`]),`--stream=${stream}`,'--password=false',`--video-codec=${codec}`,`--video-encoder=${encoder}`,
  '--alpha-workflow','--audio-source=none','--width=640','--height=360','--fps=30','--bitrate-kbps=4000','--duration-ms=180000','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher');
 await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode);return fs.existsSync(discovery);},15000,'Publisher unavailable');control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
 await waitFor(async()=>{const d=await api('/diagnostics');return d.app.live&&d.source.has_frame&&d.source.alpha_detected;},15000,'Alpha source unavailable');
 native=launch(receiver,[path.resolve(opts['obs-app']||'/Applications/OBS.app'),path.resolve(opts.plugin),path.resolve(opts['plugin-data']),stream,output,'--geometry'],'receiver');
 await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode);return native.output.includes('RECEIVER_READY');},15000,'Receiver unavailable');
 if(scene)await command('compose black');await sleep(3500);
 const peers=peerIdentity(await api('/diagnostics'));assert(peers.length>0);
 const geometries=[[640,360],[720,960],[960,480],[640,360]];
 for(let index=0;index<geometries.length;index++){
  const size=geometries[index],composition=scene?'black':'raw';
  if(index){
   const label='transition-'+index;await command('mark '+label);source.stdin.write(`resize ${size[0]} ${size[1]}\n`);
   await waitFor(async()=>{
    if(syphon){const d=await api('/diagnostics');return d.source.width===size[0]&&d.source.height===size[1];}
    return (await api('/sources/windows')).sources.some(s=>s.id===id&&s.width===size[0]&&s.height===size[1]);
   },10000,'Source did not change physical size');
   await sleep(3000);const frames=await samples(label,composition),summary={label,from:geometries[index-1],to:size,frames:frames.length,invalid:[]};result.transitions.push(summary);
   for(const [i,frame] of frames.entries()){
    let valid=false;for(const candidate of [geometries[index-1],size]){try{analyzeGeometry(frame,candidate,composition);valid=true;break;}catch{}}
    if(!valid)summary.invalid.push(i);
   }
   save();assert.equal(summary.invalid.length,0,'Invalid color/alpha/aspect-fit frame during '+label);
  }
  for(const background of (scene?['black','white']:['raw'])){
   if(scene){await command('compose '+background);await sleep(800);}
   const label='stable-'+index+'-'+background;await command('mark '+label);await sleep(observationSeconds*1000);const frames=await samples(label,background);
   const summary={label,size,frames:frames.length,invalid:[]},identities=new Set();result.phases.push(summary);
   for(const [i,frame] of frames.entries()){
    try{const checked=analyzeGeometry(frame,size,background);identities.add(checked.identity);}catch(e){summary.invalid.push({index:i,error:String(e.message)});}
   }
   summary.distinctIdentities=identities.size;summary.diagnostics=await api('/diagnostics');save();assert.equal(summary.invalid.length,0,'Invalid stable color/alpha/aspect-fit frames in '+label);assert(identities.size>=30,'Source stopped moving');
   const d=summary.diagnostics;assert.equal(d.source.source_id,id);assert.equal(d.video.alpha_enabled,true);assert.equal(d.video.configured_width,640);assert.equal(d.video.configured_height,360);assert.deepEqual(peerIdentity(d),peers);
   for(const key of ['encode_failures','encode_timeouts','alpha_encode_failures','alpha_encode_timeouts','alpha_contract_rejected_pairs'])assert.equal(d.video[key],0,key);
  }
  if(scene){await command('compose black');await sleep(800);}
 }
 native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null,10000,'Receiver did not quit');result.receiverExit=await native.closed;assert.equal(result.receiverExit.code,0);
 await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));
 source.stdin.write('quit\n');await waitFor(()=>source.exitCode!==null,5000,'Fixture did not quit');assert.equal((await source.closed).code,0);result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;if(control){try{result.failureDiagnostics=await api('/diagnostics');}catch{}}
}finally{
 for(const child of children)child.kill('SIGTERM');await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
 try{result.recordingStorage=compressRecordings(report);}
 catch(error){result.recordingStorageError=String(error.stack||error);result.passed=false;process.exitCode=1;console.error(error);}
 save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
