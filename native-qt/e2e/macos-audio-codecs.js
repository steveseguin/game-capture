#!/usr/bin/env node
'use strict';
// Reuse the Windows decoded-audio assertions with owned Mac source/input adapters.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn,spawnSync,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {receive}=require('./audio-settings-packaged-e2e');
const {sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(arg=>{const at=arg.indexOf('=');assert(at>2,'Use --name=value');return[arg.slice(2,at),arg.slice(at+1)];}));
assert.equal(process.platform,'darwin');
for(const key of ['app','fixture','tone-helper','microphone-device','reports'])assert(opts[key],'Required --'+key);
const encoders=(opts.encoders||'videotoolbox,x264').split(',');assert(encoders.every(e=>['videotoolbox','x264'].includes(e)));
const codecs=(opts.codecs||'opus,pcm,red').split(',');assert(codecs.every(c=>['opus','pcm','red'].includes(c)));
const matrix=opts.matrix||'standard';assert(['standard','boundaries','network'].includes(matrix));
const cases=(matrix==='boundaries'?[{codec:'opus',channels:1,bitrate:6},{codec:'opus',channels:2,bitrate:6},{codec:'opus',channels:2,bitrate:510},{codec:'red',channels:1,bitrate:6},{codec:'red',channels:2,bitrate:6},{codec:'red',channels:2,bitrate:510}]:matrix==='network'?['opus','red','pcm'].map(codec=>({codec,channels:2,bitrate:192})):codecs.flatMap(codec=>[1,2].map(channels=>({codec,channels,bitrate:channels===1&&codec!=='pcm'?64:192})))).filter(c=>codecs.includes(c.codec));assert(cases.length);
const gui=opts.gui==='true';assert(!opts.gui||['true','false'].includes(opts.gui));assert(!gui||opts['ui-helper'],'GUI requires --ui-helper');
assert(!opts['spin-controls']||['true','false'].includes(opts['spin-controls']));assert(opts['spin-controls']!=='true'||gui,'Spin controls require GUI');
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture');assert(fs.existsSync(path.join(app,'Contents/Frameworks')),'Use a deployed app');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Packaged Apple Silicon publisher with owned Syphon video and explicit existing BlackHole input; shared Windows decoded-audio/negotiation/bitrate assertions. No physical devices or calibrated A/V. Optional browser-scoped network impairment is separately recorded.',
  app,executableSha256:hash(exe),qtWidgetsSha256:hash(path.join(app,"Contents/Frameworks/QtWidgets.framework/Versions/A/QtWidgets")),harnessSha256:hash(__filename),receiverSha256:hash(path.join(__dirname,'audio-settings-packaged-e2e.js')),
  fixtureSha256:hash(path.resolve(opts.fixture)),toneSha256:hash(path.resolve(opts['tone-helper'])),gui,matrix,
  uiHelperSha256:gui?hash(path.resolve(opts['ui-helper'])):null,cases:[],passed:false};
for(const name of ['macos-audio-codecs.js','audio-settings-packaged-e2e.js','macos-media-receiver.js','audio-network-observer.js','macos-syphon-fixture.mm','macos-audio-tone.mm'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
if(gui)fs.copyFileSync(path.join(__dirname,'macos-ui-control.mm'),path.join(report,'macos-ui-control.mm'));
const children=new Set();let browser;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
function launch(program,args,name,cwd=report){
 const log=fs.createWriteStream(path.join(report,name+'.log'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
 const p=spawn(path.resolve(program),args,{cwd,env,stdio:['pipe','pipe','pipe']});children.add(p);let output='';
 p.stdout.on('data',d=>output+=d);p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});p.output=()=>output;
 p.closed=new Promise(resolve=>{p.once('close',(code,signal)=>{children.delete(p);log.end();resolve({code,signal});});p.once('error',error=>p.launchError=String(error));});return p;
}
async function api(control,route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}
function barriers(){
 const map=new Map();return label=>{
  if(!map.has(label)){let resolve;const promise=new Promise(r=>resolve=r);map.set(label,{count:0,promise,resolve});}
  const b=map.get(label);if(++b.count===2)b.resolve();
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Receiver barrier timed out: '+label)),30000);b.promise.then(()=>{clearTimeout(timer);resolve();});});
 };
}
(async()=>{console.log('Reports: '+report);try{
 if(matrix==='boundaries'){
  result.invalidArguments=[];
  for(const argument of ['--audio-bitrate-kbps=5','--audio-bitrate-kbps=511','--audio-bitrate-kbps=abc','--audio-channels=6','--audio-codec=invalid']){
   const invalid=spawnSync(exe,['--headless',argument,'--duration-ms=1000'],{encoding:'utf8',timeout:10000});
   result.invalidArguments.push({argument,exitCode:invalid.status,signal:invalid.signal,error:invalid.error?.message});
   assert.equal(invalid.status,2,'Invalid audio argument was not rejected before capture');
  }
 }
 const sourceName='Audio codec fixture '+crypto.randomUUID();
 const source=launch(opts.fixture,[sourceName,'premultiplied','flipped'],'source');
 const tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');
 await waitFor(()=>{assert(source.exitCode===null&&!source.signalCode&&!source.launchError);return source.output().includes('"uuid"');},10000,'Syphon fixture not ready');
 const sourceId=JSON.parse(source.output().trim().split('\n')[0]).uuid;
 await waitFor(()=>{assert(tone.exitCode===null&&!tone.signalCode&&!tone.launchError);return tone.output().includes('READY '+opts['microphone-device']);},5000,'Owned BlackHole tone not ready');
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});result.browserVersion=browser.version();
 for(const encoder of encoders)for(const {codec,channels,bitrate} of cases){
  const id=`${encoder}-${codec}-${channels}-${bitrate}`,dir=path.join(report,id);fs.mkdirSync(dir);
  const c={codec:codec==='pcm'?'pcm':'opus',red:codec==='red',channels,bitrate,
   stream:'macaudiocodecs'+crypto.randomBytes(12).toString('hex')};
  const entry={encoder,codec,channels,bitrate:c.bitrate,receivers:[],passed:false};result.cases.push(entry);save();
  const discovery=path.join(dir,'control.json'),remoteToken=crypto.randomBytes(24).toString('hex');let control;
  const settings=path.join(dir,'settings');
  if(gui){const org=path.join(settings,'VDO.Ninja');fs.mkdirSync(org,{recursive:true});
   fs.writeFileSync(path.join(org,'Game Capture.ini'),`[video]\nsourceMode=syphon\ncodec=h264\nencoderMode=${encoder==='x264'?'software':encoder}\nresolution=960x540\nfps=30\nbitratePresetKbps=4000\nalphaWorkflow=false\nalphaBackgroundMode=opaque\nalphaBackgroundColor=#224488\n[audio]\nsource=none\nwindowSource=none\nincludeMicrophone=false\nmicrophoneDeviceId=none\ncodec=opus\nred=true\nchannels=2\nbitrateKbps=192\n[control]\nenabled=true\ntoken=${remoteToken}\n[syphon]\nalpha=premultiplied\n`);
  }
  const mediaArgs=gui?[`--settings-dir=${settings}`]:['--headless','--source=syphon',`--syphon-server=${sourceId}`,'--syphon-alpha=premultiplied',
   '--alpha-background=opaque','--alpha-background-color=#224488',`--stream=${c.stream}`,'--password=false',
   '--audio-source=none','--include-microphone',`--microphone-device=${opts['microphone-device']}`,
   `--audio-codec=${c.codec}`,`--audio-channels=${channels}`,`--audio-bitrate-kbps=${c.bitrate}`,c.red?'--audio-red':'--no-audio-red',
   '--video-codec=h264',`--video-encoder=${encoder}`,'--width=640','--height=360','--fps=30','--bitrate-kbps=2000',
   '--remote-control',`--remote-token=${remoteToken}`,'--duration-ms=180000'];
  const launchArgs=[...mediaArgs,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`];
  let publisher=launch(exe,launchArgs,id+'-publisher',dir);
  const ui=(action,...args)=>execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),action,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000});
  const rows=()=>JSON.parse(ui('dump')),field=name=>rows().find(r=>String(r.AXIdentifier||'').endsWith('.'+name));
  async function choose(name,title){
   if(field(name)?.AXTitle===title)return;
   ui('press',name);
   const row=await waitFor(()=>rows().find(r=>r.AXRole==='AXStaticText'&&(r.AXTitle===title||(title==='BlackHole 2ch'&&/^BlackHole 2ch(?: \(Default\))? - /.test(r.AXTitle)))),5000,'Choice missing: '+title);
   ui('press',row.AXTitle);await waitFor(()=>field(name)?.AXTitle===row.AXTitle,5000,'Choice did not commit');return row.AXTitle;
  }
  function encodingState(){return rows().filter(r=>/\.(audioCodecSelect|audioChannelsSelect|audioBitrateSpin|audioRedCheck)$/.test(r.AXIdentifier||''));}
  function verifyEncoding(){
   assert.equal(field('audioCodecSelect').AXTitle,codec==='pcm'?'PCM (experimental)':'Opus (48 kHz)');
   assert.equal(field('audioChannelsSelect').AXTitle,channels===1?'Mono (1 channel)':'Stereo (2 channels)');
   assert.equal(Number(field('audioBitrateSpin').AXValue),c.bitrate);
   assert.equal(Boolean(field('audioBitrateSpin').AXEnabled),codec!=='pcm');
   assert.equal(Boolean(field('audioRedCheck').AXEnabled),codec!=='pcm');
   assert.equal(Boolean(Number(field('audioRedCheck').AXValue)),c.red);
  }
  try{
   await waitFor(async()=>{for(const p of [publisher,source,tone])assert(p.exitCode===null&&!p.signalCode&&!p.launchError,'Owned process exited');
    if(!fs.existsSync(discovery))return false;control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);return gui?!!field('advancedToggle'):(await api(control,'/diagnostics')).app.live;
   },20000,'Publisher not ready');
   if(gui){
    const idle=await api(control,'/diagnostics');assert(!idle.app.live&&!idle.app.capturing);
    execFileSync('/usr/bin/open',['-a',app,'--args',...launchArgs],{timeout:10000,stdio:'pipe'});ui('activate');
    await waitFor(async()=>(await api(control,'/sources/syphon')).sources.some(s=>s.id===sourceId),15000,'Owned source missing');
    ui('press','refreshSourcesButton');ui('set','sourceFilterInput',sourceName);
    await waitFor(()=>{try{ui('source-ready',sourceName);return true;}catch{return false;}},10000,'Source row not ready');
    ui('select-source',sourceName);ui('verify-selected',sourceName);ui('set','streamIdInput',c.stream);ui('set','passwordInput','false');
    if(!Number(field('advancedToggle').AXValue))ui('press','advancedToggle');
    await choose('microphoneDeviceSelect','BlackHole 2ch');
    if(!Number(field('audioEncodingToggle').AXValue))ui('press','audioEncodingToggle');
    assert.equal(field('audioCodecSelect').AXTitle,'Opus (48 kHz)');assert.equal(Number(field('audioBitrateSpin').AXValue),192);
    if(c.bitrate!==192){
     // Qt's generic accessibility decrement can use a range-derived step.
     // AX text assignment also need not commit a spin box's numeric value.
     // Type through its actual editor; wire bitrate is checked below.
     ui('focus','audioBitrateSpin');ui('click','audioBitrateSpin');ui('key','command-a');
     for(const digit of String(c.bitrate))ui('key',digit);
     ui('key','return');
    }
    await choose('audioChannelsSelect',channels===1?'Mono (1 channel)':'Stereo (2 channels)');
    if(Boolean(Number(field('audioRedCheck').AXValue))!==c.red)ui('press','audioRedCheck');
    await choose('audioCodecSelect',codec==='pcm'?'PCM (experimental)':'Opus (48 kHz)');verifyEncoding();
    if(opts['spin-controls']==='true'&&codec!=='pcm'){
     ui('increment','audioBitrateSpin','1');assert.equal(Number(field('audioBitrateSpin').AXValue),c.bitrate+1);
     ui('decrement','audioBitrateSpin','1');assert.equal(Number(field('audioBitrateSpin').AXValue),c.bitrate);
     entry.nativeSpinStepsPassed=true;
    }
    entry.selectedEncodingUi=encodingState();
    ui('press','goLiveButton');await waitFor(async()=>(await api(control,'/diagnostics')).app.live,15000,'GUI did not go live');
   }
   await waitFor(()=>{
    if(gui){const label=field('shareLinkLabel');c.viewerUrl=String(label?.AXValue||label?.AXTitle||'').match(/https:\/\/[^\s"'<>]+/)?.[0]?.replaceAll('&amp;','&');}
    else c.viewerUrl=publisher.output().match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1];
    return !!c.viewerUrl;
   },10000,'Generated viewer link missing');
   const before=await api(control,'/diagnostics');assert.equal(before.video.hardware_encoder,encoder==='videotoolbox');assert.equal(before.source.mode,'syphon');
   entry.initialDiagnostics=before;
   let network;
   const receiverOptions=matrix==='network'?{preparePage:async page=>{network=await require('./audio-network-observer').attach(page);return()=>network.close();},observePlayback:context=>network.exercise(context)}:{};
   if(codec==='opus'||matrix!=='standard')entry.receivers.push(await receive(browser,c,dir,discovery,codec!=='pcm'?remoteToken:undefined,undefined,receiverOptions));
   else{
    const sync=barriers();const receivers=[false,true].map(fallback=>{const target=path.join(dir,fallback?'fallback':'preferred');fs.mkdirSync(target);return{requested:{...c,fallback},target};});
    const settled=await Promise.allSettled(receivers.map(r=>receive(browser,r.requested,r.target,discovery,undefined,sync,{})));
    for(let i=0;i<settled.length;i++){
     const value=settled[i],file=path.join(receivers[i].target,'receiver.json');
     entry.receivers.push(value.status==='fulfilled'?value.value:fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{ok:false,error:String(value.reason)});
    }
   }
   entry.finalDiagnostics=await api(control,'/diagnostics');
   assert(entry.receivers.every(r=>r.ok),'Decoded receiver checks failed');
   assert.equal(entry.finalDiagnostics.audio.send_failures,0);assert.equal(entry.finalDiagnostics.video.encode_failures,0);
   assert(source.exitCode===null&&tone.exitCode===null,'Owned fixtures stopped');
   if(gui){
    ui('press','goLiveButton');await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'GUI Stop did not finish');
    const beforeStop=await api(control,'/diagnostics');await sleep(500);const afterStop=await api(control,'/diagnostics');
    for(const name of ['frames_captured','frames_sent'])assert.equal(beforeStop.video[name],afterStop.video[name]);
    assert.equal(beforeStop.metrics.audio_packets_sent,afterStop.metrics.audio_packets_sent);
    entry.stoppedCountersSettled=true;
    await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'GUI did not quit');
    entry.firstPublisherExit=await publisher.closed;assert.equal(entry.firstPublisherExit.code,0);assert(!fs.existsSync(discovery));
    publisher=launch(exe,launchArgs,id+'-relaunch',dir);
    await waitFor(()=>{assert(publisher.exitCode===null);return fs.existsSync(discovery)&&!!field('advancedToggle');},15000,'Relaunch not ready');
    control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
    if(!Number(field('advancedToggle').AXValue))ui('press','advancedToggle');
    assert.equal(Number(field('audioEncodingToggle').AXValue),0,'Audio encoding should start collapsed');ui('press','audioEncodingToggle');
    verifyEncoding();entry.restoredEncodingUi=encodingState();
    const idle=await api(control,'/diagnostics');assert(!idle.app.live&&!idle.app.capturing&&idle.metrics.audio_packets_sent===0&&idle.video.frames_sent===0);
    entry.encodingPersistedAfterRelaunch=true;
   }
   entry.passed=true;
  }catch(error){
   const saved=path.join(dir,'receiver.json');if(!entry.receivers.length&&fs.existsSync(saved))entry.receivers.push(JSON.parse(fs.readFileSync(saved)));
   entry.error=String(error.stack||error);console.error(id+': '+String(error.message||error));
   if(gui&&publisher.exitCode===null)try{fs.writeFileSync(path.join(dir,'failure-ui.json'),ui('dump'));}catch{}
  }
  finally{
   if(publisher.exitCode===null&&control)await api(control,'/commands',{command:'quit'}).catch(()=>{});
   await Promise.race([publisher.closed,sleep(5000)]);
   if(publisher.exitCode===null&&!publisher.signalCode){entry.passed=false;entry.cleanupError='Publisher required termination';publisher.kill('SIGTERM');}
   entry.publisherExit=await publisher.closed;
   if(entry.publisherExit.code!==0||fs.existsSync(discovery))entry.passed=false;
   assert(!fs.readFileSync(path.join(report,id+'-publisher.log'),'utf8').includes(remoteToken),'Remote token exposed in log');
   save();console.log(id+': '+(entry.passed?'passed':'failed'));
  }
 }
 result.networkComparisons=[];
 if(matrix==='network'&&codecs.includes('opus')&&codecs.includes('red'))for(const encoder of encoders){
  const concealment=codec=>result.cases.find(c=>c.encoder===encoder&&c.codec===codec)?.receivers[0]?.network?.phases.find(p=>p.name==='ten-percent-loss')?.delta.concealedFraction;
  const plain=concealment('opus'),red=concealment('red');
  result.networkComparisons.push({encoder,plainConcealedFraction:plain,redConcealedFraction:red,
   passed:Number.isFinite(plain)&&Number.isFinite(red)&&red<plain*.7});
 }
 result.passed=result.cases.length===encoders.length*cases.length&&result.cases.every(c=>c.passed)&&result.networkComparisons.every(c=>c.passed);
 assert(result.passed,'One or more audio codec workflows failed');
}catch(error){result.error=String(error.stack||error);process.exitCode=1;}
finally{
 if(browser)await browser.close().catch(()=>{});
 for(const p of children)p.stdin.write('quit\n');
 await Promise.all([...children].map(async p=>{await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGTERM');await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');await p.closed;}));
 save();console.log(JSON.stringify({report,passed:result.passed}));}
})();
