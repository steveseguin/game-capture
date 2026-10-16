#!/usr/bin/env node
'use strict';
// Packaged publisher -> owned transparent window -> installed native OBS plugin.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','fixture','receiver','plugin','reports'])assert(opts[key],'Missing --'+key);
const syphon=opts.source==='syphon',association=opts['syphon-alpha']||'straight';
assert(['straight','premultiplied'].includes(association));
const gui=opts.gui==='true';if(gui)assert(opts['ui-helper'],'GUI requires --ui-helper');
const cycles=Number(opts.cycles||1);assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=5);assert(gui||cycles===1);
const selectionRefreshes=Number(opts['selection-refreshes']||0);
const diagnoseSelection=opts['diagnose-selection']==='true';
const filterSources=opts['filter-sources']!=='false';
const checkIdempotent=opts['check-idempotent-selection']==='true';
const closeSelected=opts['close-selected']==='true';
assert(Number.isInteger(selectionRefreshes)&&selectionRefreshes>=0&&selectionRefreshes<=10);
assert(gui||!selectionRefreshes);
const codec=opts.codec||'vp9',encoder=opts.encoder||'software';
assert(['vp9','h264'].includes(codec));assert(codec==='vp9'?encoder==='software':['videotoolbox','x264'].includes(encoder));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),fixture=path.resolve(opts.fixture),receiver=path.resolve(opts.receiver),plugin=path.resolve(opts.plugin);
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Packaged transparent window or Syphon -> OBS/plugin paired BGRA and black/white scene composition; OBS frontend excluded',
  source:syphon?'syphon':'window',association,codec,encoder,gui,selectionRefreshes,filterSources,checkIdempotent,closeSelected,cycles:[],analyzerSha256:hash(path.join(__dirname,'macos-alpha-analyzer.js')),executableSha256:hash(exe),fixtureSha256:hash(fixture),receiverSha256:hash(receiver),pluginSha256:hash(plugin),harnessSha256:hash(__filename),passed:false};
if(gui)result.uiHelperSha256=hash(path.resolve(opts['ui-helper']));
result.qtCocoaSha256=hash(path.resolve(opts.app,'Contents/PlugIns/platforms/libqcocoa.dylib'));
for(const name of ['macos-alpha-publish.js','macos-alpha-analyzer.js','macos-alpha-fixture.mm','macos-obs-alpha-receiver.cpp','macos-ui-control.mm'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
const children=new Set();
let publisherForFailure=null;
function launch(command,args,label){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_)/.test(k)));
  const child=spawn(command,args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
  const log=fs.createWriteStream(path.join(report,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.stdout.on('data',b=>{child.output=(child.output+b.toString()).slice(-32768);});
  child.closed=new Promise(resolve=>{child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});});});
  return child;
}
async function api(control,route,body){const response=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(response.ok,'Control HTTP '+response.status);return response.json();}
const {analyze,analyzeComposition}=require('./macos-alpha-analyzer');

(async()=>{console.log('Reports: '+report);try{
  if(gui){
    const state=JSON.parse(execFileSync(path.resolve(opts['ui-helper']),[String(process.pid),'session-state'],{encoding:'utf8',timeout:10000}));
    assert(!state.screenLocked,'Native GUI workflow requires an unlocked session');
  }
  const title='Mac Alpha Fixture '+crypto.randomBytes(8).toString('hex'),stream='macalpha'+crypto.randomBytes(12).toString('hex');
  const source=launch(fixture,[title,...(syphon?[association,opts.flipped==='true'?'flipped':'normal']:[])],'fixture');
  await waitFor(()=>{assert(source.exitCode===null&&!source.signalCode,'Fixture exited');return source.output.includes(syphon?'uuid':'windowId');},10000,'Fixture not ready');
  result.fixture=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));
  const sourceId=String(syphon?result.fixture.uuid:result.fixture.windowId);
  if(syphon)fs.copyFileSync(path.join(__dirname,'macos-syphon-fixture.mm'),path.join(report,'macos-syphon-fixture.mm'));
  const discovery=path.join(report,'control.json');
  let publisherArgs;
  if(gui){
    const settings=path.join(report,'settings'),org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
    fs.writeFileSync(path.join(org,'Game Capture.ini'),`[video]\nsourceMode=${syphon?'syphon':'window'}\ncodec=${codec}\nencoderMode=${encoder==='x264'?'software':encoder}\nresolution=960x540\nfps=30\nbitratePresetKbps=4000\nalphaWorkflow=false\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\n[syphon]\nalpha=${association}\n`);
    publisherArgs=[`--settings-dir=${settings}`];
  }else publisherArgs=['--headless',...(syphon?['--source=syphon',`--syphon-server=${sourceId}`,`--syphon-alpha=${association}`]:[`--window=${title}`]),`--stream=${stream}`,'--password=false',`--video-codec=${codec}`,`--video-encoder=${encoder}`,
    '--alpha-workflow','--audio-source=none','--width=640','--height=360','--fps=30','--bitrate-kbps=4000','--duration-ms=120000'];
  const publisher=launch(exe,[...publisherArgs,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher');
  publisherForFailure=publisher;
  await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode,'Publisher exited');return fs.existsSync(discovery);},15000,'Publisher control unavailable');
  const control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  const ui=(action,name,value)=>execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),action,...(name?[name]:[]),...(value===undefined?[]:[value])],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
  const ready=()=>JSON.parse(ui('dump')).some(r=>String(r.AXIdentifier||'').endsWith('.goLiveButton')&&r.AXTitle==='Go live'&&r.AXEnabled);
  result.sourceActions=[];
  const verifySelected=async name=>waitFor(()=>{try{ui('verify-selected',name);return true;}catch{return false;}},10000,'Source selection did not settle');
  const selectSource=async name=>{
    const observation={name,readinessPolls:0};result.sourceActions.push(observation);const start=Date.now();
    await waitFor(()=>{++observation.readinessPolls;try{ui('source-ready',name);return true;}catch{return false;}},10000,'Source row did not become actionable');
    observation.readyMs=Date.now()-start;
    ui('select-source',name); // One mutation; AXPress toggles the Qt selection.
    await verifySelected(name);observation.selected=true;
    if(checkIdempotent){ui('select-source',name);await verifySelected(name);observation.idempotent=true;}
  };
  if(gui){
    source.stdin.write('raise\n');
    await waitFor(async()=>(await api(control,syphon?'/sources/syphon':'/sources/windows')).sources.some(w=>w.name.includes(title)),15000,'Owned window missing');
    ui('press','refreshSourcesButton');
    if(filterSources)ui('set','sourceFilterInput',title);
    await waitFor(()=>JSON.parse(ui('dump')).some(r=>Object.values(r).some(v=>typeof v==='string'&&v.includes(title))),15000,'Owned source missing from UI');
    fs.writeFileSync(path.join(report,'source-selection.json'),JSON.stringify(JSON.parse(ui('dump')).filter(r=>Object.values(r).some(v=>typeof v==='string'&&v.includes(title))),null,2));
    // Text labels/filter values can precede actionable cells after layout.
    await selectSource(title);
    result.selectionRefreshChecks=[];
    for(let index=0;index<selectionRefreshes;index++){
      const spareTitle='Extra Mac Source '+crypto.randomBytes(8).toString('hex'),spare=launch(fixture,[spareTitle,...(syphon?[association]:[])],'spare-'+index);
      await waitFor(()=>spare.output.includes(syphon?'uuid':'windowId'),10000,'Spare fixture not ready');
      await waitFor(async()=>(await api(control,syphon?'/sources/syphon':'/sources/windows')).sources.some(w=>w.name.includes(spareTitle)),10000,'Spare source missing');
      ui('press','refreshSourcesButton');await sleep(3500);
      if(filterSources){ui('set','sourceFilterInput',spareTitle);assert(!ready(),'Filtering out the selection must disable Go Live');}
      await selectSource(spareTitle);
      const selectedSourceClosed=closeSelected&&index%2===1;
      if(!selectedSourceClosed){
        if(filterSources){ui('set','sourceFilterInput',title);assert(!ready(),'Changing the filter must clear the hidden selection');}
        await selectSource(title);
      }
      spare.stdin.write('quit\n');assert.equal((await spare.closed).code,0);
      await waitFor(async()=>!(await api(control,syphon?'/sources/syphon':'/sources/windows')).sources.some(w=>w.name.includes(spareTitle)),10000,'Retired source still listed');
      ui('press','refreshSourcesButton');await sleep(3500);
      const check={index,addedSelected:true,selectedSourceClosed,removed:true,readyAfterRemoval:ready()};
      result.selectionRefreshChecks.push(check);
      if(selectedSourceClosed){
        assert(!check.readyAfterRemoval,'Closing the selected source silently selected another source');
        if(filterSources)ui('set','sourceFilterInput',title);
        await selectSource(title);check.originalReselected=true;
      }else assert(check.readyAfterRemoval,'GUI lost the selection when an unrelated source closed');
      try{await verifySelected(title);check.accessibleSelectionRetained=true;}
      catch(error){check.accessibleSelectionRetained=false;check.error=String(error.stderr||error);if(!diagnoseSelection)throw error;}
    }
    ui('set','streamIdInput',stream);ui('set','passwordInput','false');
    let rows=JSON.parse(ui('dump'));const advanced=rows.find(r=>String(r.AXIdentifier||'').endsWith('.advancedToggle'));
    assert(advanced);if(!Number(advanced.AXValue))ui('press','advancedToggle');
    rows=JSON.parse(ui('dump'));const alpha=rows.find(r=>String(r.AXIdentifier||'').endsWith('.alphaWorkflowCheck'));
    assert(alpha?.AXEnabled,'Alpha UI control is unavailable');assert(!Number(alpha.AXValue));ui('press','alphaWorkflowCheck');
    await waitFor(()=>JSON.parse(ui('dump')).some(r=>String(r.AXIdentifier||'').endsWith('.ffmpegStatusLabel')&&JSON.stringify(r).includes('alpha mask is CPU encoded')),10000,'Alpha helper status missing');

  }
  for(let index=1;index<=cycles;index++){
    const cycle={index,passed:false};result.cycles.push(cycle);
    if(gui){await waitFor(ready,10000,'Go Live not ready');ui('press','goLiveButton');source.stdin.write('raise\n');}
  await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.app.live&&d.app.capturing&&d.source.alpha_detected;},15000,'Transparent source was not detected');
  const received=path.join(report,'receiver-'+index);fs.mkdirSync(received);
  const native=launch(receiver,[path.resolve(opts['obs-app']||'/Applications/OBS.app'),plugin,path.resolve(opts['plugin-data']||path.resolve(plugin,'../../Resources')),stream,received],'receiver-'+index);
  await waitFor(()=>{assert(native.exitCode===null&&!native.signalCode,'Native receiver exited');return native.output.includes('RECEIVER_READY');},15000,'Native receiver not ready');
  await sleep(25000);
  cycle.liveDiagnostics=await api(control,'/diagnostics');
  assert.equal(cycle.liveDiagnostics.source.source_id,sourceId,'Publisher captured a different source');
  if(syphon){assert.equal(cycle.liveDiagnostics.source.mode,'syphon');assert.equal(cycle.liveDiagnostics.syphon_input_alpha,association);}
  if(gui){
    cycle.liveHelperPids=execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{
      const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&Number(m[2])===publisher.pid&&path.basename(m[3])==='ffmpeg'?[Number(m[1])]:[];
    });assert.equal(cycle.liveHelperPids.length,codec==='vp9'?2:1,'Expected primary/mask worker ownership');
  }

  native.stdin.write('quit\n');await waitFor(()=>native.exitCode!==null||native.signalCode,15000,'Native receiver did not quit');
  cycle.receiverExit=await native.closed;assert.equal(cycle.receiverExit.code,0);
  const data=JSON.parse(fs.readFileSync(path.join(received,'received.json')));cycle.received=analyze(data);
  cycle.composition=analyzeComposition(data);
  for(const key of ['encode_failures','encode_timeouts','alpha_encode_failures','alpha_encode_timeouts','alpha_contract_rejected_pairs'])assert.equal(cycle.liveDiagnostics.video[key],0,key);
  assert(cycle.liveDiagnostics.video.alpha_packets_sent>60,'Alpha packets did not advance');
  if(gui){
    const helpers=cycle.liveHelperPids;
    const start=Date.now();ui('press','goLiveButton');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing&&ready();},10000,'GUI alpha Stop failed');
    cycle.stopMs=Date.now()-start;const stopped=await api(control,'/diagnostics');await sleep(500);cycle.stoppedDiagnostics=await api(control,'/diagnostics');
    for(const key of ['frames_captured','frames_sent','alpha_packets_sent'])assert.equal(stopped.video[key],cycle.stoppedDiagnostics.video[key]);
    for(const pid of helpers){let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}assert(!alive,'Alpha helper survived Stop');}
    cycle.helpersReaped=helpers;
  }
    cycle.passed=true;save();
  }
  await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');
  result.publisherExit=await publisher.closed;assert.equal(result.publisherExit.code,0);assert(!fs.existsSync(discovery));
  source.stdin.write('quit\n');assert.equal((await source.closed).code,0);
  if(!syphon){result.fixtureFinal=JSON.parse(source.output.trim().split('\n').at(-1));assert(result.fixtureFinal.paintCount>=60,'Fixture did not repaint');}
  result.passed=!result.selectionRefreshChecks?.some(c=>c.accessibleSelectionRetained===false);
  if(!result.passed)process.exitCode=1;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
  if(gui&&publisherForFailure?.exitCode===null){try{
    const helper=path.resolve(opts['ui-helper']),pid=String(publisherForFailure.pid);
    const rows=execFileSync(helper,[pid,'dump'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
    fs.writeFileSync(path.join(report,'failed-ui.json'),rows);
    const window=execFileSync(helper,[pid,'window'],{encoding:'utf8',timeout:5000}).trim();
    assert(/^\d+$/.test(window));
    execFileSync('/usr/sbin/screencapture',['-x','-o','-l',window,path.join(report,'failed-ui.png')],{timeout:10000});
  }catch(captureError){result.failureInspectionError=String(captureError);}}
}finally{
  for(const child of children)child.kill('SIGTERM');
  await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
  save();console.log(JSON.stringify({report,passed:result.passed}));
}})();
