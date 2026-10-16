#!/usr/bin/env node
'use strict';
// Packaged GUI recovery after closing/killing only our captured fixture process.
// Keep one real browser viewer open across every publisher generation.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,installReceiverProbe}=require('./macos-media-receiver');
const {analyze,analyzeComposition}=require('./macos-alpha-analyzer');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');for(const k of ['app','fixture','ui-helper','reports'])assert(opts[k],'Missing --'+k);
const codec=opts.codec||'h264',encoder=opts.encoder||'videotoolbox',alpha=opts.alpha==='true';
const losses=Number(opts.losses||2),background=opts.background||'none';
const transitions=opts['window-transitions']==='true';
const occlusion=opts.occlusion==='true';
const startCovered=opts['start-covered']==='true';
assert(!startCovered||occlusion,'--start-covered requires --occlusion=true');
const nativeContinuity=opts['native-continuity']==='true';
assert(Number.isInteger(losses)&&losses>=0&&losses<=5);assert(['none','chroma','opaque'].includes(background));
assert(['h264','h265','vp9','av1'].includes(codec));assert(!alpha||!['h265','av1'].includes(codec));assert(!alpha||background==='none');
assert(['vp9','av1'].includes(codec)?encoder==='software':codec==='h265'?encoder==='videotoolbox':['videotoolbox','x264'].includes(encoder));
if(alpha)for(const k of ['receiver','plugin','plugin-data'])assert(opts[k],'Alpha recovery requires --'+k);
assert(!nativeContinuity||alpha,'Native continuity requires --alpha=true');
assert(!nativeContinuity||losses<=2,'The bounded native observer supports at most two replacement losses');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture),helper=path.resolve(opts['ui-helper']);
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Same-process packaged GUI live-window loss/reselection; existing browser reconnection, static source, worker cleanup; optional native paired-alpha viewer coexists after recovery',
  codec,encoder,alpha,background,losses,transitions,nativeContinuity,executableSha256:hash(exe),fixtureSha256:hash(fixture),helperSha256:hash(helper),harnessSha256:hash(__filename),phases:[],passed:false};
result.occlusion=occlusion;
result.startCovered=startCovered;
result.qtWidgetsSha256=hash(path.resolve(opts.app,'Contents/Frameworks/QtWidgets.framework/Versions/A/QtWidgets'));
if(nativeContinuity)result.scope='Same-process packaged GUI source replacement with one retained native OBS source and browser; actual black scene pixels across distinct owned window generations';
if(nativeContinuity){
  const buildFile=path.join(path.dirname(path.resolve(opts.receiver)),'build.json');
  const build=JSON.parse(fs.readFileSync(buildFile));
  assert.equal(build.executableSha256,hash(path.resolve(opts.receiver)),'Native receiver differs from its build record');
  assert.equal(build.sourceSha256,hash(path.join(__dirname,'macos-obs-alpha-receiver.cpp')),'Rebuild the native receiver with current controlled-observer support');
  fs.copyFileSync(buildFile,path.join(report,'native-receiver-build.json'));
}
for(const name of ['macos-source-recovery.js','macos-media-receiver.js','macos-alpha-analyzer.js','macos-alpha-fixture.mm','macos-ui-control.mm'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
const children=new Set();let browser,publisher,native;
const nativeOutput=path.join(report,'native-continuity');
function launch(command,args,label){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
  const child=spawn(command,args,{env,cwd:report,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
  const log=fs.createWriteStream(path.join(report,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.stdout.on('data',b=>{child.output=(child.output+b.toString()).slice(-32768);});
  child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
  child.once('error',e=>{result.launchError=String(e);});return child;
}
async function api(control,route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Local control HTTP '+r.status);return r.json();}
const helpers=pid=>execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
  const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&Number(m[2])===pid&&path.basename(m[3])==='ffmpeg'?[Number(m[1])]:[];
});
async function counters(page){return page.evaluate(async()=>{
  const counters={};for(let i=0;i<window.reviewPCs.length;i++){
    const pc=window.reviewPCs[i];if(pc.connectionState!=='connected')continue;
    for(const t of (await pc.getStats()).values())if(t.type==='inbound-rtp'&&t.kind==='video')counters[i+':'+t.id]=t.framesDecoded||0;
  }return counters;
});}
async function observe(page,milliseconds){return page.evaluate(async milliseconds=>{
  const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth&&!v.paused);
  const samples=[];if(!video)return {samples,tracks:[]};
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=1;
  const context=canvas.getContext('2d',{willReadFrequently:true});let callback,stopped=false;
  function frame(){if(stopped)return;
    context.drawImage(video,0,Math.floor(video.videoHeight/16),video.videoWidth,1,0,0,640,1);
    const row=context.getImageData(0,0,640,1).data;let identity=0;
    for(let bit=0;bit<16;bit++)if(row[(bit*40+20)*4]>127)identity|=1<<bit;
    samples.push({identity,time:performance.now()});callback=video.requestVideoFrameCallback(frame);
  }
  callback=video.requestVideoFrameCallback(frame);await new Promise(r=>setTimeout(r,milliseconds));stopped=true;video.cancelVideoFrameCallback(callback);
  const tracks=[];for(const pc of window.reviewPCs)if(pc.connectionState==='connected'){
    const stats=await pc.getStats();for(const t of stats.values())if(t.type==='inbound-rtp')tracks.push({...t,codec:stats.get(t.codecId)?.mimeType});
  }return {samples,tracks,width:video.videoWidth,height:video.videoHeight};
},milliseconds);}
function moving(data,initial){
  assert(data.samples.every(s=>s.identity>initial&&s.identity<initial+8000),'Retired, blank or corrupt source generation reached the browser');
  const ids=new Set(data.samples.map(s=>s.identity));assert(data.samples.length>=30&&ids.size>=30,'Received source did not move');
  for(let i=1;i<data.samples.length;i++)assert((data.samples[i].identity-data.samples[i-1].identity+65536)%65536<=90,'Corrupt/reversed decoded identity');
  assert.equal(data.width,960);assert.equal(data.height,540);assert(data.tracks.some(t=>t.codec?.toLowerCase()==='video/'+codec));return ids.size;
}
async function nativeCommand(value){
  native.output='';native.stdin.write(value+'\n');
  await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode,'Retained native receiver exited');return native.output.includes('ACK '+value);},5000,'Native receiver did not acknowledge '+value);
}
async function nativeSnapshot(label){
  await nativeCommand('snapshot '+label);
  const data=JSON.parse(fs.readFileSync(path.join(nativeOutput,label+'.json')));
  assert.equal(data.sourceCreations,1,'Native OBS source was recreated');return data.blackComposition;
}
async function nativeObserve(label,initial,{held=false}={}){
  await nativeCommand('mark '+label);await sleep(3500);
  const samples=(await nativeSnapshot(label)).filter(s=>s.segment===label);
  assert(samples.every(s=>s.identity>initial&&s.identity<initial+8000),'Retired or corrupt source generation reached the native viewer');
  for(let i=1;i<samples.length;i++)assert(BigInt(samples[i].timestamp)>BigInt(samples[i-1].timestamp),'Native scene timestamps did not advance');
  const analyzed=require('./macos-alpha-analyzer').analyzeBlackScene(samples,{minIdentities:held?1:30});
  if(held)assert.equal(analyzed.distinctIdentities,1,'Native held image changed');
  return analyzed;
}
(async()=>{console.log('Reports: '+report);try{
  result.sessionState=JSON.parse(execFileSync(helper,[String(process.pid),'session-state'],{encoding:'utf8',timeout:10000}));
  assert.equal(result.sessionState.screenLocked,false,'Unlock the Mac before running native GUI workflows');
  const settings=path.join(report,'settings'),org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
  fs.writeFileSync(path.join(org,'Game Capture.ini'),`[video]\nsourceMode=window\ncodec=${codec}\nencoderMode=${encoder==='x264'?'software':encoder}\nresolution=960x540\nfps=30\nbitratePresetKbps=4000\nalphaWorkflow=${alpha}\nalphaBackgroundMode=${background}\nalphaBackgroundColor=#00FF00\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\n`);
  const discovery=path.join(report,'control.json'),stream='macrecovery'+crypto.randomBytes(12).toString('hex');
  publisher=launch(exe,[`--settings-dir=${settings}`,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher');
  await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited');return fs.existsSync(discovery);},15000,'Control unavailable');
  const control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);result.publisherPid=publisher.pid;
  const ui=(action,name,value)=>execFileSync(helper,[String(publisher.pid),action,...(name?[name]:[]),...(value===undefined?[]:[value])],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
  const rows=()=>JSON.parse(ui('dump')),find=name=>rows().find(r=>String(r.AXIdentifier||'').endsWith('.'+name));
  const ready=()=>{const b=find('goLiveButton');return b?.AXEnabled&&b.AXTitle==='Go live';};
  await waitFor(()=>!!find('streamIdInput'),15000,'Publisher GUI not ready');
  ui('set','streamIdInput',stream);ui('set','passwordInput','false');
  browser=await chromium.launch({headless:true,...(opts['receiver-executable']?{executablePath:path.resolve(opts['receiver-executable'])}:{}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();let page;
  for(let index=0;index<=losses;index++){
    const phase={index,passed:false};result.phases.push(phase);
    const initial=(index+1)*8000;phase.initialIdentity=initial;
    const title='Mac Recovery '+crypto.randomBytes(8).toString('hex'),source=launch(fixture,[title,String(initial)],'fixture-'+index);
    await waitFor(()=>source.output.includes('windowId'),10000,'Fixture not ready');phase.fixture=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));
    const sourceState=async()=>{
      const previous=source.output;source.stdin.write('state\n');
      await waitFor(()=>source.output!==previous,2000,'Fixture state unavailable');
      return JSON.parse(source.output.trim().split('\n').at(-1));
    };
    if(startCovered&&index===0){
      source.stdin.write('cover\n');
      await waitFor(async()=>{
        const s=await sourceState();phase.initialOcclusion=s;
        return s.visible&&!s.miniaturized&&s.coverVisible&&s.coverOpaque&&s.coverContainsSource&&s.coverAboveSource;
      },5000,'Owned source was not covered before selection/start');
    }
    await waitFor(async()=>(await api(control,'/sources/windows')).sources.some(w=>w.name.includes(title)),15000,'Replacement source missing');
    ui('press','refreshSourcesButton');ui('set','sourceFilterInput',title);
    assert(!ready(),'Newly visible source must require explicit selection');
    await waitFor(()=>{try{ui('source-ready',title);return true;}catch{return false;}},10000,'Source row not actionable');
    ui('select-source',title);ui('verify-selected',title);assert(ready());
    const before=page?await counters(page):{};ui('press','goLiveButton');
    if(!startCovered||index!==0)source.stdin.write('raise\n');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.app.live&&d.app.capturing&&d.source.has_frame;},15000,'Publisher did not start');
    if(!page)page=await receiver(browser,stream,publisher);
    else{
      const start=Date.now();await waitFor(async()=>Object.entries(await counters(page)).some(([key,n])=>n>(before[key]||0)+15),35000,'Existing viewer did not reconnect');
      phase.existingViewerReconnectMs=Date.now()-start;
    }
    phase.moving=await observe(page,3000);moving(phase.moving,initial);
    if(nativeContinuity){
      if(!native){
        fs.mkdirSync(nativeOutput);result.receiverSha256=hash(path.resolve(opts.receiver));result.pluginSha256=hash(path.resolve(opts.plugin));
        fs.copyFileSync(path.join(__dirname,'macos-obs-alpha-receiver.cpp'),path.join(report,'macos-obs-alpha-receiver.cpp'));
        native=launch(path.resolve(opts.receiver),[path.resolve(opts['obs-app']||'/Applications/OBS.app'),path.resolve(opts.plugin),path.resolve(opts['plugin-data']),stream,nativeOutput,'--controlled'],'native-continuity');
        result.nativeReceiverPid=native.pid;
        await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode);return native.output.includes('RECEIVER_READY');},15000,'Native receiver not ready');
        await nativeCommand('compose black');
      }
      const start=Date.now(),label='joining-'+index;await nativeCommand('mark '+label);
      await waitFor(async()=>{
        const samples=(await nativeSnapshot('joining')).filter(s=>s.segment===label).slice(-20);
        return samples.length===20&&samples.every(s=>s.identity>initial&&s.identity<initial+8000);
      },35000,'Existing native viewer did not receive the replacement window');
      phase.nativeRecoveryMs=Date.now()-start;phase.initialIdentity=initial;
      phase.nativeMoving=await nativeObserve('moving-'+index,initial);
      phase.browserWithNative=await observe(page,2000);moving(phase.browserWithNative,initial);
    }
    phase.liveDiagnostics=await api(control,'/diagnostics');const d=phase.liveDiagnostics;
    assert.equal(d.source.source_id,String(phase.fixture.windowId));assert.equal(d.video.hardware_encoder,encoder==='videotoolbox');
    assert.equal(d.video.alpha_enabled,alpha);assert.equal(d.video.alpha_background_mode,background);
    for(const key of ['encode_failures','encode_timeouts','alpha_encode_failures','alpha_encode_timeouts','alpha_contract_rejected_pairs'])assert.equal(d.video[key],0,key);
    assert.equal(d.metrics.audio_packets_sent,0);phase.helpers=helpers(publisher.pid);assert.equal(phase.helpers.length,(['vp9','av1'].includes(codec)?1:0)+(alpha?1:0));
    if(index===0){
      if(occlusion){
        const observation={passed:false};phase.occlusion=observation;
        observation.before=await sourceState();source.stdin.write('cover\n');
        await waitFor(async()=>{
          const s=await sourceState();observation.covered=s;
          return s.visible&&!s.miniaturized&&s.coverVisible&&s.coverOpaque&&s.coverContainsSource&&s.coverAboveSource;
        },5000,'Owned opaque cover did not completely cover the selected source');
        await sleep(1000);
        observation.browser=await observe(page,3000);moving(observation.browser,initial);
        if(nativeContinuity)observation.native=await nativeObserve('covered',initial);
        observation.after=await sourceState();
        assert(observation.after.paintCount>observation.covered.paintCount+30,'Owned source stopped drawing while covered');
        assert(observation.after.coverVisible&&observation.after.coverContainsSource&&observation.after.coverAboveSource,'Cover moved away during observation');
        observation.diagnostics=await api(control,'/diagnostics');
        assert(observation.diagnostics.app.live&&observation.diagnostics.app.capturing);
        assert.equal(observation.diagnostics.source.source_id,String(phase.fixture.windowId),'Capture switched to the covering window');
        assert.equal(observation.diagnostics.source.suspended,false,'Occlusion suspended a source that is still drawing');
        source.stdin.write('uncover\n');await waitFor(async()=>!(await sourceState()).coverVisible,5000,'Owned cover did not hide');
        observation.uncovered=await observe(page,3000);moving(observation.uncovered,initial);
        if(nativeContinuity)observation.nativeUncovered=await nativeObserve('uncovered',initial);
        observation.passed=true;save();
      }
      source.stdin.write('pause\n');await sleep(500);phase.static=await observe(page,2000);
      assert(phase.static.samples.length>=30,'Static window stopped producing paced video');assert.equal(new Set(phase.static.samples.map(s=>s.identity)).size,1);
      const paused=await api(control,'/diagnostics');assert(paused.app.live&&paused.app.capturing,'Static source incorrectly treated as lost');
      source.stdin.write('resume\n');phase.resumed=await observe(page,2000);moving(phase.resumed,initial);
      if(transitions){
        phase.windowTransitions=[];
        for(const action of ['minimize','hide']){
          const transition={action};phase.windowTransitions.push(transition);
          source.stdin.write(action+'\n');await sleep(1500);transition.source=await sourceState();
          if(action==='minimize')assert(transition.source.miniaturized,'Fixture did not minimize');
          else assert.equal(transition.source.visible,false,'Fixture did not hide');
          transition.diagnostics=await api(control,'/diagnostics');
          assert(transition.diagnostics.app.live&&transition.diagnostics.app.capturing,'Temporary '+action+' stopped the capture session');
          assert.equal(transition.diagnostics.source.suspended,true,'Temporary '+action+' was not reported as suspended');
          transition.status=find('statusLabel');assert(JSON.stringify(transition.status).includes('Window capture paused'));
          await sleep(1000);transition.settledDiagnostics=await api(control,'/diagnostics');
          assert.equal(transition.diagnostics.video.frames_captured,transition.settledDiagnostics.video.frames_captured,'Suspended capture advanced');
          assert(transition.settledDiagnostics.video.frames_sent>transition.diagnostics.video.frames_sent,'Held output stopped');
          transition.heldVideo=await observe(page,2000);
          assert(transition.heldVideo.samples.every(s=>s.identity>initial&&s.identity<initial+8000),'Suspended browser received a blank or retired source image');
          assert(transition.heldVideo.samples.length>=30&&new Set(transition.heldVideo.samples.map(s=>s.identity)).size===1,'Suspended source did not retain a paced image');
          if(nativeContinuity)transition.nativeHeld=await nativeObserve(action+'-held',initial,{held:true});
          let latePage;
          if(action==='minimize'){
            latePage=await browser.newPage();await installReceiverProbe(latePage);
            await latePage.goto(`https://vdo.ninja/?view=${stream}&password=false&autostart&cleanoutput`,{waitUntil:'domcontentloaded',timeout:45000});
            await waitFor(()=>latePage.evaluate(()=>window.reviewPCs.some(pc=>pc.connectionState==='connected'&&pc.getReceivers().some(r=>r.track?.kind==='video'&&r.track.readyState==='live'))),25000,'Late viewer did not connect while suspended');
            transition.lateViewerConnectionStates=await latePage.evaluate(()=>window.reviewPCs.map(pc=>({state:pc.connectionState,tracks:pc.getReceivers().map(r=>({kind:r.track?.kind,state:r.track?.readyState}))})));
            await sleep(3000);transition.lateViewerWhileSuspended=await counters(latePage);
            assert(Object.values(transition.lateViewerWhileSuspended).some(n=>n>15),'Late viewer did not receive a held frame');
            transition.lateHeldVideo=await observe(latePage,2000);
            assert(transition.lateHeldVideo.samples.length>=30&&new Set(transition.lateHeldVideo.samples.map(s=>s.identity)).size===1,'Late viewer did not retain one image');
            assert.equal(transition.lateHeldVideo.samples[0].identity,transition.heldVideo.samples[0].identity);
          }
          source.stdin.write('restore\n');await sleep(1000);transition.restored=await sourceState();
          assert(transition.restored.visible&&!transition.restored.miniaturized);assert.equal(transition.restored.windowId,phase.fixture.windowId);
          transition.received=await observe(page,3000);moving(transition.received,initial);transition.passed=true;
          if(nativeContinuity)transition.nativeRestored=await nativeObserve(action+'-restored',initial);
          assert.equal((await api(control,'/diagnostics')).source.suspended,false,'Restored source remains suspended');
          if(latePage){
            await waitFor(async()=>Object.values(await counters(latePage)).some(n=>n>15),20000,'Late viewer did not start after restore');
            transition.lateViewerAfterRestore=await observe(latePage,2000);moving(transition.lateViewerAfterRestore,initial);await latePage.close();
          }
        }
      }
    }
    if(index===losses&&alpha&&!nativeContinuity){
      result.receiverSha256=hash(path.resolve(opts.receiver));result.pluginSha256=hash(path.resolve(opts.plugin));
      const output=path.join(report,'native-receiver');fs.mkdirSync(output);
      const native=launch(path.resolve(opts.receiver),[path.resolve(opts['obs-app']||'/Applications/OBS.app'),path.resolve(opts.plugin),path.resolve(opts['plugin-data']),stream,output],'native-receiver');
      await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode);return native.output.includes('RECEIVER_READY');},15000,'Native receiver not ready');
      await sleep(25000);phase.browserDuringNative=await observe(page,3000);moving(phase.browserDuringNative,initial);
      native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null,15000,'Native receiver did not quit');assert.equal((await native.closed).code,0);
      const data=JSON.parse(fs.readFileSync(path.join(output,'received.json')));phase.native={raw:analyze(data),composition:analyzeComposition(data)};
    }
    if(transitions&&index<losses&&index%2){
      source.stdin.write('minimize\n');
      await waitFor(async()=>(await api(control,'/diagnostics')).source.suspended===true,5000,'Source did not suspend before closure');
      phase.closedWhileSuspended=true;
    }
    if(transitions&&index===losses){
      source.stdin.write('minimize\n');
      await waitFor(async()=>(await api(control,'/diagnostics')).source.suspended===true,5000,'Source did not suspend before Stop');
      phase.stoppedWhileSuspended=true;
    }
    const stoppedAt=Date.now();
    if(index<losses){
      phase.lossKind=index%2?'process-killed':'window-destroyed-process-alive';
      if(index%2){
        source.kill('SIGKILL');await waitFor(()=>source.exitCode!==null||source.signalCode,5000,'Owned fixture did not exit');phase.fixtureExit=await source.closed;
      }else{
        source.stdin.write('destroy-window\nstate\n');
        await waitFor(()=>source.output.includes('"destroyed":true'),5000,'Owned window was not destroyed');
        assert.equal(source.exitCode,null,'Fixture process exited with its window');
      }
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'Source loss did not stop publishing');
      phase.lossStopMs=Date.now()-stoppedAt;phase.failureStatus=find('statusLabel');
      assert(JSON.stringify(phase.failureStatus).includes('Window capture stopped'),'GUI did not explain the capture failure');
      await waitFor(()=>find('goLiveButton')?.AXEnabled===false,10000,'Lost source selection was not cleared automatically');
      phase.sourceClearedMs=Date.now()-stoppedAt;
    }else{
      ui('press','goLiveButton');await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing&&find('sourceFilterInput')?.AXEnabled;},10000,'Final Stop failed');
      phase.normalStopMs=Date.now()-stoppedAt;source.stdin.write('quit\n');assert.equal((await source.closed).code,0);
    }
    phase.stoppedDiagnostics=await api(control,'/diagnostics');await sleep(1000);
    const settled=await api(control,'/diagnostics');phase.stoppedViewer=await observe(page,2000);
    const later=await api(control,'/diagnostics');
    for(const key of ['frames_captured','frames_sent','alpha_packets_sent'])assert.equal(settled.video[key],later.video[key],'Media advanced after shutdown');
    assert(new Set(phase.stoppedViewer.samples.map(s=>s.identity)).size<=1,'Viewer still received moving media after source loss');
    for(const pid of phase.helpers)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH','Encoder worker survived source loss');
    assert.equal(helpers(publisher.pid).length,0);assert.equal(publisher.exitCode,null);assert(fs.existsSync(discovery));
    if(phase.lossKind==='window-destroyed-process-alive'){
      assert.equal(source.exitCode,null,'Window-only closure did not preserve its owner process');phase.sourceProcessSurvivedWindowLoss=true;
      source.stdin.write('quit\n');phase.fixtureExit=await source.closed;assert.equal(phase.fixtureExit.code,0);
    }
    phase.passed=true;save();console.log('Recovery phase '+index+' passed');
  }
  if(native){
    native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null,10000,'Native receiver did not quit');
    result.nativeReceiverExit=await native.closed;assert.equal(result.nativeReceiverExit.code,0);
  }
  await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');
  result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
  if(publisher?.exitCode===null)try{fs.writeFileSync(path.join(report,'failed-ui.json'),execFileSync(helper,[String(publisher.pid),'dump'],{encoding:'utf8',timeout:10000}));}catch{}
}finally{
  if(browser)await browser.close();for(const child of children)child.kill('SIGTERM');
  await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
  save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
