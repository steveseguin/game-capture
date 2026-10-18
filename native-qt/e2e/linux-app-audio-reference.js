'use strict';
// Independent Pulse client, restricted to the owned fixture's exact playback
// stream. It never records an unfiltered desktop mix.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const assert=require('assert/strict'),{spawn,execFileSync}=require('child_process');
const {waitFor}=require('./macos-media-receiver');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const list=kind=>JSON.parse(execFileSync('pactl',['--format=json','list',kind],{encoding:'utf8',timeout:5000}));
async function start(report,pid) {
  const streams=list('sink-inputs').filter(s=>Number(s.properties['application.process.id'])===pid);
  assert.equal(streams.length,1,'Independent reference requires one owned playback stream');
  const selected=streams[0],sink=list('sinks').find(s=>s.index===selected.sink);
  const monitor=sink?.monitor_source;
  assert(typeof monitor==='string'&&monitor.length,'Selected playback output has no monitor');
  return capture(report,'resume-source',monitor,['--monitor-stream='+selected.index],10,{
    scope:'Independent parec capture filtered to the owned fixture playback ID. Arrival times are not calibrated sample timestamps.',pid,playbackIndex:selected.index});
}
async function startPlayout(report,{name,moduleId}) {
  assert(/^gc_qa_[a-f0-9]{12}_receiver$/.test(name),'Playout reference requires an owned receiver sink');
  const sink=list('sinks').find(s=>s.name===name);
  assert(sink && String(sink.owner_module)===String(moduleId),'Receiver sink ownership changed');
  assert(typeof sink.monitor_source==='string');
  const streams=list('sink-inputs').filter(s=>s.sink===sink.index);
  assert(streams.length,'Receiver has no playback stream on its owned sink');
  return capture(report,'receiver-playout',sink.monitor_source,[],20,{
    scope:'Independent parec recording of the uniquely owned receiver null sink. Browser playback output, not physical speakers; arrival times are not calibrated sample timestamps.',
    sink:name,moduleId,sinkIndex:sink.index,playbackStreams:streams});
}
async function capture(report,basename,monitor,filter,seconds,details) {
  const raw=path.join(report,basename+'.f32le'),fd=fs.openSync(raw,'wx',0o600);
  const metadata={...details,monitor,sampleRate:48000,channels:2,format:'float32le',
    path:path.basename(raw),startedAtMs:Date.now(),arrivals:[],bytes:0};
  const child=spawn('/usr/bin/parec',['--raw','--format=float32le','--rate=48000','--channels=2',
    '--channel-map=front-left,front-right','--latency-msec=10','--process-time-msec=10',
    '--client-name=GameCaptureOwnedQAReference',...filter,'--device='+monitor],
    {stdio:['ignore','pipe','pipe']});
  let error=null,stderr='',stopping=false,stopPromise;
  child.on('error',e=>{error=String(e);});
  child.stdout.on('data',data=>{
    if(error)return;
    if(metadata.bytes+data.length>48000*8*seconds || metadata.arrivals.length>=seconds*200){error='Independent reference exceeded its bound';child.kill('SIGINT');return;}
    try{fs.writeSync(fd,data);metadata.bytes+=data.length;metadata.arrivals.push({wallMs:Date.now(),endByte:metadata.bytes});}
    catch(e){error=String(e);child.kill('SIGINT');}
  });
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-65536);});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{metadata.exitCode=code;metadata.signal=signal;metadata.closedAtMs=Date.now();fs.closeSync(fd);resolve();}));
  const bound=setTimeout(()=>{error='Independent reference exceeded '+seconds+' seconds';child.kill('SIGINT');},seconds*1000);
  const stop=()=>stopPromise||=(async()=>{
    stopping=true;clearTimeout(bound);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');
    let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Independent reference did not stop')),3000);})]);}
    catch(e){error=String(e);child.kill('SIGKILL');await closed;}
    finally{clearTimeout(timer);}
    metadata.stderr=stderr;metadata.sha256=sha(raw);metadata.error=error;
    fs.writeFileSync(path.join(report,basename+'.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});
    assert(!error,error);assert.equal(metadata.exitCode,0,stderr);assert(metadata.bytes>=48000*8&&metadata.bytes%8===0);
    return metadata;
  })();
  try{await waitFor(()=>{assert(!error,error);assert(!stopping&&child.exitCode===null,'Reference exited before recording');return metadata.bytes>0;},3000,'Independent reference supplied no samples');}
  catch(e){try{await stop();}catch{}throw e;}
  return {stop};
}
module.exports={start,startPlayout};
