#!/usr/bin/env node
'use strict';
// Real packaged publishing across removal/recreation of one owned virtual input.
// Tone output remains on existing BlackHole; no physical/default device changes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');assert(i>2);return [arg.slice(2,i),arg.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','fixture','tone-helper','input-helper','ui-helper','reports'])assert(opts[key],'Required --'+key);
const encoders=(opts.encoders||'videotoolbox,x264').split(',');
assert(encoders.length>0&&encoders.every(e=>['videotoolbox','x264'].includes(e)));
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture');
assert(fs.existsSync(path.join(app,'Contents/Frameworks')),'Use a deployed app');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={scope:'Packaged same-process GUI owned-input removal, status/meters, Stop, explicit reselection and Go Live recovery. Physical devices excluded.', expectedLossStatus:opts['expect-loss-status']||'reported',
  executableSha256:hash(exe),harnessSha256:hash(__filename),helpers:{},cases:[],cleanup:[],passed:false};
for(const key of ['fixture','tone-helper','input-helper','ui-helper'])result.helpers[key]=hash(path.resolve(opts[key]));
for(const name of ['macos-audio-input-gui.js','macos-audio-input-fixture.mm','macos-media-receiver.js','macos-syphon-fixture.mm','macos-audio-tone.mm'])
  fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
assert(['stale','reported'].includes(result.expectedLossStatus));
const systemAudio=opts['system-audio']==='true';result.systemAudio=systemAudio;
const expectedPermission=opts['expect-microphone-permission'];
result.expectInputWarning=opts['expect-input-warning']==='true';
if(expectedPermission){
  assert(['not_determined','denied','restricted','granted'].includes(expectedPermission));assert(!systemAudio);
  result.scope='Packaged GUI with an explicitly expected existing microphone permission: input/warning behavior, received media, Stop, and restart with No microphone. Granted permission also checks live mute/unmute. No privacy setting is changed.';
  result.expectedMicrophonePermission=expectedPermission;
}
assert(!systemAudio||result.expectedLossStatus==='reported','System-audio preservation requires the fixed candidate');
const children=new Set();let browser,input,source,tone,uid,inputName,control,publisher,publisherOwnership;
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
function ownedPublisherPids(){
  if(!publisherOwnership)return [];
  const {settings,discovery}=publisherOwnership;
  return execFileSync('/bin/ps',['-axww','-o','pid=,command='],{encoding:'utf8'}).split('\n')
    .filter(line=>line.includes('/Game Capture.app/Contents/MacOS/game-capture')&&
      line.includes('--settings-dir='+settings+' ')&&line.trimEnd().endsWith('--local-control-discovery='+discovery))
    .map(line=>Number(line.trim().split(/\s+/,1)[0]));
}
function verifyOwnedPublisher(pid){
  assert(ownedPublisherPids().includes(pid),'PID does not use this workflow\'s private settings and discovery');
  const actual=execFileSync('/bin/ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim();
  assert(fs.realpathSync(actual)===fs.realpathSync(exe)||
    (actual.includes('/AppTranslocation/')&&actual.endsWith('/Game Capture.app/Contents/MacOS/game-capture')),
    'Unexpected Launch Services executable');
  assert.equal(hash(actual),result.executableSha256,'Launch Services executable differs from the candidate');
  return actual;
}
async function cleanupOwnedPublisher(){
  if(!publisherOwnership)return;
  if(control)await api('/commands',{command:'quit'}).catch(()=>{});
  for(let attempt=0;attempt<50&&ownedPublisherPids().length;attempt++)await sleep(100);
  for(const signal of ['SIGTERM','SIGKILL']){
    const pids=ownedPublisherPids();if(!pids.length)break;
    for(const pid of pids){verifyOwnedPublisher(pid);process.kill(pid,signal);
      result.cleanup.push({scope:'Forced cleanup of verified owned application',pid,signal});result.passed=false;}
    for(let attempt=0;attempt<50&&ownedPublisherPids().length;attempt++)await sleep(100);
  }
  assert.equal(ownedPublisherPids().length,0,'Owned GUI application remained after cleanup');
}
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
  assert.equal(observation.width,960);assert.equal(observation.height,540);assert(fps>=28.5,'Video below 95% of requested cadence');
  return {observation,distinct,fps};
}
async function sound(page,record,key='audio'){
  const observation=await observeAudio(page);
  if(record){record[key]=observation;save();}
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
  await api('/commands',{command:'quit'});
  await waitFor(()=>ownedPublisherPids().length===0&&publisher.exitCode!==null,10000,'Publisher quit timed out');
  // open -W observes application lifetime but does not expose its exit status.
  entry.launchServicesExit=await publisher.closed;assert.equal(entry.launchServicesExit.code,0);
  entry.applicationExitObserved=true;assert(!fs.existsSync(discovery),'Discovery remained after quit');
  publisher=null;control=null;publisherOwnership=null;
}
(async()=>{console.log('Reports: '+report);try{
  input=launch(opts['input-helper'],[],'input-fixture');
  await waitFor(()=>{alive(input);return input.output.includes('\n');},10000,'Input fixture not ready');
  const created=events()[0];assert.equal(created.event,'created');assert(created.defaultsUnchanged);
  uid=created.uid;inputName=created.name;assert(uid.startsWith('ninja.vdo.game-capture.qa-input.'));result.input={uid,name:inputName};
  const title='GUI input recovery '+crypto.randomUUID();
  source=launch(opts.fixture,[title,'premultiplied','flipped'],'source');
  tone=launch(opts['tone-helper'],['BlackHole2ch_UID','440','880'],'tone');
  await waitFor(()=>{alive(source);return source.output.includes('"uuid"');},10000,'Source not ready');
  const sourceId=JSON.parse(source.output.trim().split('\n')[0]).uuid;
  await waitFor(()=>{alive(tone);return tone.output.includes('READY BlackHole2ch_UID');},10000,'Tone not ready');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();
  for(const encoder of encoders){
    const entry={encoder,phases:[],passed:false};result.cases.push(entry);
    const settings=path.join(report,encoder+'-settings'),org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
    const ini=path.join(org,'Game Capture.ini');
    fs.writeFileSync(ini,`[video]\nsourceMode=syphon\ncodec=h264\nencoderMode=${encoder==='x264'?'software':encoder}\nresolution=960x540\nfps=30\nbitratePresetKbps=1200\nalphaWorkflow=false\nalphaBackgroundMode=opaque\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\ncodec=opus\nchannels=2\nbitrateKbps=192\nred=false\n[syphon]\nalpha=premultiplied\n`);
    const stream='macinputgui'+crypto.randomBytes(12).toString('hex'),discovery=path.join(report,encoder+'-control.json');
    const args=['--settings-dir='+settings,'--local-control','--local-control-port=0','--local-control-discovery='+discovery];
    publisherOwnership={settings,discovery};assert.equal(ownedPublisherPids().length,0);
    // Launch once through Launch Services. A quarantined app may be translocated;
    // launching its binary first and then opening the bundle can create two PIDs.
    publisher=launch('/usr/bin/open',['-n','-W','-a',app,'--stdout',path.join(report,encoder+'-publisher.log'),
      '--stderr',path.join(report,encoder+'-publisher-stderr.log'),'--args',...args],encoder+'-launch-services');
    await waitFor(()=>{[publisher,source,tone,input].forEach(alive);return fs.existsSync(discovery);},15000,'Control unavailable');
    control=JSON.parse(fs.readFileSync(discovery));assert(Number.isInteger(control.pid)&&control.pid>1);
    assert.deepEqual(ownedPublisherPids(),[control.pid]);const actualExecutable=verifyOwnedPublisher(control.pid);
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.dirname(path.dirname(path.dirname(actualExecutable)))],{timeout:15000,stdio:'pipe'});
    entry.publisherPid=control.pid;entry.launch={method:'Launch Services open -n -W',waitProcessPid:publisher.pid,
      actualExecutable,translocated:actualExecutable.includes('/AppTranslocation/'),executableSha256:hash(actualExecutable),signatureVerified:true};
    const ui=(action,name,value)=>execFileSync(path.resolve(opts['ui-helper']),[String(control.pid),action,...(name?[name]:[]),...(value===undefined?[]:[value])],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
    const rows=()=>JSON.parse(ui('dump')),find=name=>rows().find(r=>String(r.AXIdentifier||'').endsWith('.'+name));
    const audioRows=()=>rows().filter(r=>/\.(statusLabel|audioMeter|audioLevelLabel|primaryAudioMeter|primaryAudioLevelLabel|microphoneAudioMeter|microphoneAudioLevelLabel|microphoneAudioSourceLabel|microphoneDeviceSelect|goLiveButton)$/.test(r.AXIdentifier||''));
    await waitFor(()=>!!find('advancedToggle'),15000,'GUI not ready');
    // Reopen the exact running bundle, including its translocated location.
    // The original download path can resolve to a different instance. Reopen
    // through Launch Services restores foreground activation after Qt startup.
    execFileSync('/usr/bin/open',['-a',path.dirname(path.dirname(path.dirname(actualExecutable))),
      '--args',...args],{timeout:10000,stdio:'pipe'});
    await sleep(500);
    assert.equal(JSON.parse(fs.readFileSync(discovery)).pid,control.pid,'Reopen changed the owned application PID');
    assert.deepEqual(ownedPublisherPids(),[control.pid],'Reopen created an additional owned application');
    entry.launch.reopenPreservedOwnedPid=true;
    ui('activate');entry.launch.readyActivationVerified=true;
    await waitFor(async()=>(await api('/sources/syphon')).sources.some(s=>s.id===sourceId),15000,'Owned Syphon source missing');
    const select=async()=>{
      ui('press','refreshSourcesButton');ui('set','sourceFilterInput',title);
      await waitFor(()=>{try{ui('source-ready',title);return true;}catch{return false;}},10000,'Owned source not actionable');
      ui('select-source',title);ui('verify-selected',title);
      if(!Number(find('advancedToggle')?.AXValue))ui('press','advancedToggle');
      if(systemAudio&&find('audioSourceSelect')?.AXTitle!=='System audio (all apps)'){
        ui('press','audioSourceSelect');await waitFor(()=>rows().some(r=>r.AXTitle==='System audio (all apps)'),5000,'System audio choice absent');
        ui('press','System audio (all apps)');
        await waitFor(()=>find('audioSourceSelect')?.AXTitle==='System audio (all apps)',5000,'System audio choice did not commit');
      }
      ui('press','microphoneDeviceSelect');
      const option=await waitFor(()=>rows().find(r=>r.AXRole==='AXStaticText'&&(r.AXTitle||'').startsWith(inputName)),5000,'Owned input choice absent');
      ui('press',option.AXTitle);await waitFor(()=>find('microphoneDeviceSelect')?.AXTitle===option.AXTitle,5000,'Input selection did not commit');
      assert(fs.readFileSync(ini,'utf8').includes('microphoneDeviceId='+uid),'GUI did not save the explicit owned UID');
    };
    ui('set','streamIdInput',stream);ui('set','passwordInput','false');
    if(expectedPermission){
      await listed(true);await select();
      const warning=()=>{const row=find('microphoneWarningLabel');return row?.AXValue||row?.AXTitle||'';};
      for(const phase of [expectedPermission==='granted'?'permission-granted':'permission-unavailable','microphone-disabled']){
        if(phase==='microphone-disabled'){
          ui('press','microphoneDeviceSelect');
          await waitFor(()=>rows().some(r=>r.AXTitle==='No microphone'),5000,'No microphone choice absent');
          ui('press','No microphone');
          await waitFor(()=>find('microphoneDeviceSelect')?.AXTitle==='No microphone',5000,'No microphone did not commit');
          assert(fs.readFileSync(ini,'utf8').includes('microphoneDeviceId=none'));
        }
        assert.equal(warning(),'','Permission warning remained while idle');
        const idle=await api('/diagnostics');assert(!idle.app.live&&!idle.app.capturing);
        assert.equal(idle.platform_permissions.microphone,expectedPermission,'Existing privacy state differs from this workflow');
        const item={phase,passed:false};entry.phases.push(item);save();
        ui('press','goLiveButton');
        await waitFor(async()=>{alive(publisher);return (await api('/diagnostics')).app.live;},20000,'Go Live did not start');
        const page=await receiver(browser,stream,publisher);
        item.video=await video(page);item.audio=await observeAudio(page);item.before=await api('/diagnostics');item.beforeUi=audioRows();
        item.warning=warning();save();
        if(phase==='permission-granted'){
          item.audio=await sound(page,item);assert.equal(item.before.audio.active_microphone_source,inputName);
          assert(item.before.metrics.audio_packets_sent>0);assert.equal(item.warning,'','Active microphone produced a warning');
          ui('press','microphoneMuteButton');await sleep(1200);item.mutedAudio=await silence(page);
          assert.equal(warning(),'','Intentional mute produced an unavailable warning');
          ui('press','microphoneMuteButton');item.unmutedAudio=await sound(page,item,'unmutedAudio');
          assert.equal(warning(),'','Unmuted active microphone produced a warning');
        }else{
          assert(item.audio.spectra.length>=25&&item.audio.spectra.every(s=>s.rms<.0005),'Unexpected received audio');
          assert(item.audio.tracks.every(t=>(t.packetsReceived||0)===0),'Unexpected received audio packets');
          assert.equal(item.before.audio.active_microphone_source,'none');assert.equal(item.before.metrics.audio_packets_sent,0);
        }
        assert.equal(item.before.audio.include_microphone,phase!=='microphone-disabled');
        assert.equal(item.before.platform_permissions.microphone,expectedPermission);
        assert.equal(item.before.video.hardware_encoder,encoder==='videotoolbox');
        if(phase==='permission-unavailable'){
          assert(item.warning.startsWith('Microphone audio is off.'));
          assert(item.warning.includes(expectedPermission==='not_determined'?'macOS microphone prompt':'Privacy & Security > Microphone'));
          assert(item.warning.includes('stop and start streaming again'));
          ui('press','advancedToggle');await sleep(1200);
          assert.equal(warning(),item.warning,'Warning disappeared after changing advanced visibility');
        }else assert.equal(item.warning,'','Disabled microphone produced a permission warning');
        const windowId=ui('window').trim();execFileSync('/usr/sbin/screencapture',['-x','-l',windowId,path.join(report,encoder+'-'+phase+'.png')],{timeout:10000,stdio:'pipe'});
        ui('press','goLiveButton');
        await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.live&&!d.app.capturing;},15000,'GUI Stop did not finish');
        await waitFor(()=>find('goLiveButton')?.AXTitle==='Go live'&&find('goLiveButton')?.AXEnabled,10000,'GUI did not return to ready');
        assert.equal(warning(),'','Warning remained after Stop');
        item.stopped=await api('/diagnostics');assert.equal(item.stopped.peers.length,0);assert.equal(item.stopped.audio.level_rms,0);
        await page.close();item.passed=true;save();console.log(encoder+' '+phase+': passed');
      }
      await stop(entry,discovery);entry.passed=true;save();continue;
    }
    for(const phase of ['initial-loss','restored-start']){
      if(phase==='restored-start')await command('restore','created');
      await listed(true);await select();
      const idle=await api('/diagnostics');assert(!idle.app.live&&!idle.app.capturing);
      const item={phase,passed:false};entry.phases.push(item);
      ui('press','goLiveButton');
      await waitFor(async()=>{alive(publisher);return (await api('/diagnostics')).app.live;},20000,'Go Live did not start');
      const page=await receiver(browser,stream,publisher);
      item.before=await api('/diagnostics');item.beforeUi=audioRows();save();
      item.video=await video(page);item.audio=await sound(page,item);
      assert.equal(item.before.audio.active_microphone_source,inputName);assert.equal(item.before.audio.source_mode,systemAudio?'default-output':'none');
      assert(item.before.audio.include_microphone);assert.equal(item.before.video.hardware_encoder,encoder==='videotoolbox');
      if(result.expectInputWarning)assert(!find('microphoneWarningLabel')?.AXValue,'Active input produced an unavailable warning');
      if(phase==='initial-loss'){
        await command('retire','retired');await listed(false);await sleep(2000);
        const before=await api('/diagnostics');
        [item.lossVideo,item.lossAudio]=await Promise.all([video(page),systemAudio?sound(page):silence(page)]);
        item.after=await api('/diagnostics');item.afterUi=audioRows();
        const windowId=ui('window').trim();execFileSync('/usr/sbin/screencapture',['-x','-l',windowId,path.join(report,encoder+'-after-loss.png')],{timeout:10000,stdio:'pipe'});
        assert(item.after.app.live&&item.after.video.frames_sent>before.video.frames_sent);
        if(systemAudio)assert(item.after.metrics.audio_packets_sent>before.metrics.audio_packets_sent,'Independent system audio stopped');
        else assert.equal(item.after.metrics.audio_packets_sent,before.metrics.audio_packets_sent);
        const status=find('statusLabel');item.status=status?.AXValue||status?.AXTitle||'';
        if(result.expectInputWarning){
          item.inputWarning=find('microphoneWarningLabel')?.AXValue||'';
          assert(item.inputWarning.startsWith('Microphone audio is off.')&&item.inputWarning.includes('stop and start streaming again'));
          assert.equal(item.after.platform_permissions.microphone,'granted','Input-loss workflow requires preexisting microphone permission');
        }
        if(result.expectedLossStatus==='reported'){
          assert.equal(item.after.audio.active_microphone_source,'none','Disconnected input still reported active');
          if(systemAudio){
            assert(item.after.audio.level_rms>.001&&item.after.audio.primary_level_rms>.001,'Independent system audio meters stopped');
            assert.equal(item.after.audio.additional_level_rms,0,'Disconnected additional input meter remained active');
            assert.equal(item.after.audio.additional_audio_buffer_samples,0,'Disconnected input left buffered samples');
          }else assert.equal(item.after.audio.level_rms,0,'Disconnected input left a stale output meter');
          assert(item.status.includes('Microphone/input stopped'),'GUI did not report input loss');
          if(systemAudio){
            assert(Number(find('audioMeter')?.AXValue)>0,'GUI independent audio meter stopped');
            assert.equal(Number(find('microphoneAudioMeter')?.AXValue),0,'GUI microphone meter did not clear');
          }else assert.equal(Number(find('audioMeter')?.AXValue),0,'GUI mixed-output meter did not clear');
        }else{
          assert.equal(item.after.audio.active_microphone_source,inputName);
          assert(item.after.audio.level_rms>.001,'Expected baseline stale meter absent');
          assert(!item.status.includes('Microphone/input stopped'),'Baseline already reports input loss');
          item.reproducedStaleStatus=true;
        }
      }
      ui('press','goLiveButton');
      await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.live&&!d.app.capturing;},15000,'GUI Stop did not finish');
      await waitFor(()=>find('goLiveButton')?.AXTitle==='Go live'&&find('goLiveButton')?.AXEnabled,10000,'GUI did not return to ready');
      item.stopped=await api('/diagnostics');assert.equal(item.stopped.peers.length,0);assert.equal(item.stopped.audio.level_rms,0);
      if(result.expectInputWarning)assert(!find('microphoneWarningLabel')?.AXValue,'Input warning remained after Stop');
      await page.close();item.passed=true;save();console.log(encoder+' '+phase+': passed');
    }
    await stop(entry,discovery);entry.passed=true;
  }
  await command('retire','retired');result.passed=true;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;console.error(result.error);
  if(control){
    try{result.failureDiagnostics=await api('/diagnostics');}catch(diagnosticError){result.failureDiagnosticsError=String(diagnosticError);}
    try{fs.writeFileSync(path.join(report,'failure-ui.json'),execFileSync(path.resolve(opts['ui-helper']),[String(control.pid),'dump'],{timeout:10000,stdio:['ignore','pipe','pipe']}));}
    catch(uiError){result.failureUiError=String(uiError);}
  }
}
finally{
  try{await cleanupOwnedPublisher();}catch(error){result.cleanupError=String(error);result.passed=false;}
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
