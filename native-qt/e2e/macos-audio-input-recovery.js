#!/usr/bin/env node
'use strict';
// Real packaged publishing across removal/recreation of one owned virtual input.
// Tone output remains on existing BlackHole; no physical/default device changes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');assert(i>2);return [arg.slice(2,i),arg.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','fixture','tone-helper','input-helper','reports'])assert(opts[key],'Required --'+key);
const encoders=(opts.encoders||'videotoolbox,x264').split(',');
assert(encoders.length>0&&encoders.every(e=>['videotoolbox','x264'].includes(e)));
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture');
assert(fs.existsSync(path.join(app,'Contents/Frameworks')),'Use a deployed app');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={scope:'Owned virtual-input loss during packaged CLI publishing, absent explicit UID on relaunch, recreation and explicit relaunch recovery. No physical hotplug or same-process GUI recovery claim.',
  executableSha256:hash(exe),harnessSha256:hash(__filename),helpers:{},cases:[],cleanup:[],passed:false};
for(const key of ['fixture','tone-helper','input-helper'])result.helpers[key]=hash(path.resolve(opts[key]));
for(const name of ['macos-audio-input-recovery.js','macos-audio-input-fixture.mm','macos-media-receiver.js','macos-syphon-fixture.mm','macos-audio-tone.mm'])
  fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let browser,input,source,tone,uid,inputName,control,publisher;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
  const child=spawn(path.resolve(program),args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.label=name;
  child.output='';child.stdout.on('data',data=>child.output+=data);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>{child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({name,code,signal});});});
  child.once('error',error=>child.launchError=String(error));return child;
}
function alive(child){assert(!child.launchError&&child.exitCode===null&&!child.signalCode,child.label+' exited');}
async function api(route,body){
  const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Control HTTP '+r.status);return r.json();
}
const events=()=>input.output.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
async function command(value,event){
  const count=events().length;input.stdin.write(value+'\n');
  await waitFor(()=>{alive(input);return events().length>count;},10000,'Input fixture did not acknowledge '+value);
  const record=events().at(-1);assert.equal(record.event,event);assert.equal(record.uid,uid);assert(record.defaultsUnchanged);return record;
}
async function listed(present){
  await waitFor(async()=>{const matches=(await api('/sources/audio-inputs')).sources.filter(s=>s.id===uid);
    if(present&&matches.length===1)assert.equal(matches[0].name,inputName);return present?matches.length===1:matches.length===0;
  },10000,'Owned input discovery did not update');
}
async function video(page){
  const observation=await observeDecoded(page,4000,null,'syphon'),distinct=requireMoving(observation,'Input recovery video');
  const fps=distinct/((observation.ended-observation.started)/1000);
  assert.equal(observation.width,640);assert.equal(observation.height,360);assert(fps>=28.5,'Video below 95% of requested cadence');
  return {observation,distinct,fps};
}
async function sound(page){
  const observation=await observeAudio(page);
  assert(observation.tracks.some(t=>t.packetsReceived>20),'No received audio packets');
  assert(observation.spectra.filter(s=>s.rms>.001&&s.tone440>-65&&s.tone880>-65&&
    s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length>=25,
    'Expected separated stereo tones missing');return observation;
}
async function silence(page){
  const observation=await observeAudio(page);
  assert(observation.spectra.every(s=>s.rms<.0005),'Audio remained audible after owned input loss');return observation;
}
async function stop(entry,discovery){
  await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher quit timed out');
  entry.exit=await publisher.closed;assert.equal(entry.exit.code,0);assert(!fs.existsSync(discovery),'Discovery remained after quit');
  publisher=null;control=null;
}
(async()=>{console.log('Reports: '+report);try{
  input=launch(opts['input-helper'],[],'input-fixture');
  await waitFor(()=>{alive(input);return input.output.includes('\n');},10000,'Input fixture not ready');
  const created=events()[0];assert.equal(created.event,'created');assert(created.defaultsUnchanged);
  uid=created.uid;inputName=created.name;assert(uid.startsWith('ninja.vdo.game-capture.qa-input.'));result.input={uid,name:inputName};
  source=launch(opts.fixture,['Input recovery '+crypto.randomUUID(),'premultiplied','flipped'],'source');
  tone=launch(opts['tone-helper'],['BlackHole2ch_UID','440','880'],'tone');
  await waitFor(()=>{alive(source);return source.output.includes('"uuid"');},10000,'Source not ready');
  const sourceId=JSON.parse(source.output.trim().split('\n')[0]).uuid;
  await waitFor(()=>{alive(tone);return tone.output.includes('READY BlackHole2ch_UID');},10000,'Tone not ready');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();
  for(const encoder of encoders){
    const entry={encoder,phases:[],passed:false};result.cases.push(entry);
    for(const phase of ['initial-loss','missing-start','restored-start']){
      if(phase==='restored-start')await command('restore','created');
      const item={phase,passed:false};entry.phases.push(item);
      const stream='macinput'+crypto.randomBytes(12).toString('hex'),discovery=path.join(report,encoder+'-'+phase+'-control.json');
      publisher=launch(exe,['--headless','--source=syphon','--syphon-server='+sourceId,'--syphon-alpha=premultiplied','--alpha-background=opaque',
        '--stream='+stream,'--password=false','--audio-source=none','--include-microphone','--microphone-device='+uid,
        '--audio-codec=opus','--audio-channels=2','--audio-bitrate-kbps=192','--no-audio-red','--video-codec=h264','--video-encoder='+encoder,
        '--width=640','--height=360','--fps=30','--bitrate-kbps=1200','--duration-ms=120000',
        '--local-control','--local-control-port=0','--local-control-discovery='+discovery],encoder+'-'+phase);
      await waitFor(async()=>{[publisher,source,tone,input].forEach(alive);if(!fs.existsSync(discovery))return false;
        control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);return (await api('/diagnostics')).app.live;
      },20000,'Publisher not live');
      await listed(phase!=='missing-start');
      const page=await receiver(browser,stream,publisher);
      item.video=await video(page);item.diagnostics=await api('/diagnostics');
      assert.equal(item.diagnostics.audio.source_mode,'none');assert(item.diagnostics.audio.include_microphone);
      assert.equal(item.diagnostics.video.hardware_encoder,encoder==='videotoolbox');
      if(phase==='missing-start'){
        assert.equal(item.diagnostics.audio.active_microphone_source,'none');assert.equal(item.diagnostics.metrics.audio_packets_sent,0);
        await sleep(3000);item.after=await api('/diagnostics');assert.equal(item.after.metrics.audio_packets_sent,0);
        item.receiverAudioCounters=await page.evaluate(async()=>{
          const tracks=[];for(const pc of window.reviewPCs)for(const s of (await pc.getStats()).values())
            if(s.type==='inbound-rtp'&&s.kind==='audio')tracks.push({...s});return tracks;
        });assert(item.receiverAudioCounters.every(t=>(t.packetsReceived||0)===0),'Missing input sent audio');
        const log=fs.readFileSync(path.join(report,encoder+'-'+phase+'.log'),'utf8');
        assert(log.includes('selected input remains off'),'Missing input warning absent');
      }else{
        assert.equal(item.diagnostics.audio.active_microphone_source,inputName);item.audio=await sound(page);
        if(phase==='initial-loss'){
          item.removal=await command('retire','retired');await listed(false);await sleep(2000);
          const before=await api('/diagnostics');
          [item.afterLossVideo,item.afterLossAudio]=await Promise.all([video(page),silence(page)]);
          item.after=await api('/diagnostics');assert(item.after.app.live);
          assert.equal(item.after.metrics.audio_packets_sent,before.metrics.audio_packets_sent,'Audio continued after explicit input loss');
          assert(item.after.video.frames_sent>before.video.frames_sent,'Video stopped with audio input');
          const log=fs.readFileSync(path.join(report,encoder+'-'+phase+'.log'),'utf8');
          assert(log.includes('No replacement device will be opened.'),'Runtime input loss not reported');
        }
      }
      await page.close();await stop(item,discovery);item.passed=true;save();console.log(encoder+' '+phase+': passed');
    }
    entry.passed=true;
  }
  await command('retire','retired');
  result.passed=true;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;console.error(result.error);}
finally{
  if(publisher&&control)await api('/commands',{command:'quit'}).catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  for(const child of [...children]){
    if(child!==publisher)child.stdin.write('quit\n');
    await Promise.race([child.closed,sleep(5000)]);
    if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');result.passed=false;}
    await Promise.race([child.closed,sleep(5000)]);
    if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');result.passed=false;}
    const exit=await child.closed;result.cleanup.push(exit);if(exit.code!==0)result.passed=false;
  }
  if(input){result.inputEvents=events();result.ownedInputRemoved=result.inputEvents.at(-1)?.event==='retired'&&input.exitCode===0;
    if(!result.ownedInputRemoved||!result.inputEvents.every(e=>e.defaultsUnchanged))result.passed=false;}
  save();if(!result.passed)process.exitCode=1;console.log(JSON.stringify({report,passed:result.passed}));
}})();
