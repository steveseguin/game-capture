'use strict';
// Extracted Ubuntu DEB -> X11/Wayland window -> selected software codec -> real VDO.Ninja receiver.
// Bounded functional coverage only. No hardware encoder, audio or performance claim.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const assert=require('assert/strict'),{spawn,execFileSync}=require('child_process');
const {chromium}=require('playwright');
const {receiver,observe,requireMoving,waitFor,sleep}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const noTray=opts['no-tray']==='true';assert(!noTray||(opts.gui==='true'&&opts.backend==='x11'),'No-tray fixture requires private X11 GUI');
const tray=opts.tray==='true';assert(!tray||(opts.gui==='true'&&opts.backend==='wayland'),'Tray fixture requires native GNOME Wayland GUI');
const preview=opts.preview==='true';assert(!preview||opts.gui==='true','Preview requires GUI');
const gui=opts.gui==='true',external=opts.external==='true',width=gui?960:640,height=gui?540:360;
const rateControl=opts['rate-control']==='true',portalCancel=opts['portal-cancel']==='true',pendingQuit=opts['pending-quit']==='true',pendingStop=opts['pending-stop']==='true',sourceLoss=opts['source-loss']==='true';
assert(!(pendingQuit&&pendingStop));
assert(!(pendingStop||sourceLoss)||(gui&&opts.backend==='wayland'),'Recovery fixture requires Wayland GUI');
assert(!pendingQuit||(gui&&opts.backend==='wayland'),'Pending quit requires Wayland GUI');
assert(!portalCancel||(gui&&opts.backend==='wayland'),'Portal cancellation fixture requires Wayland GUI');
assert(!rateControl||!gui,'Rate control currently qualifies CLI only');
const targetBitrate=Number(opts['target-bitrate']||1000);
assert([500,1000].includes(targetBitrate),'Unknown rate-control fixture target');
const noiseGrid=opts['noise-grid']||'160x90';
assert(['160x90','80x45','40x23'].includes(noiseGrid),'Unknown noise fixture grid');
const [noiseWidth,noiseHeight]=noiseGrid.split('x').map(Number);
assert(!external||['vp9','av1'].includes(opts.codec),'External helper matrix supports VP9/AV1');
const codec=opts.codec||'h264', expectedCodec='video/'+codec;
assert(['h264','vp8','vp9','av1','h265'].includes(codec),'Unknown codec');
assert(!gui||['h264','vp9','av1'].includes(codec),'GUI codec matrix supports H264/VP9/AV1');
const codecName={h264:'H.264',h265:'H.265',vp8:'VP8',vp9:'VP9',av1:'AV1'}[codec];
assert.equal(process.platform,'linux');for(const key of ['publisher','reports','manifest-sha256'])assert(opts[key]);
const exe=path.resolve(opts.publisher),bundle=path.resolve(path.dirname(exe),'../..'),manifestFile=path.join(bundle,'release-artifact-manifest.json');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(sha(manifestFile),opts['manifest-sha256']);
const manifest=JSON.parse(fs.readFileSync(manifestFile));
assert.equal(manifest.artifact.sha256,sha(exe));
assert.equal(manifest.payload.fileCount,manifest.payload.files.length);
for(const item of manifest.payload.files){
  const file=path.resolve(bundle,item.relativePath);
  assert(file.startsWith(bundle+path.sep),'Payload path escapes package');
  assert.equal(fs.statSync(file).size,item.size);assert.equal(sha(file),item.sha256);
}
assert(fs.existsSync(path.join(bundle,'usr/share/applications/game-capture.desktop')));
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
fs.copyFileSync(__filename,path.join(report,'harness.js'));
if(preview)fs.copyFileSync(path.join(__dirname,'linux-preview-observer.py'),path.join(report,'preview-observer.py'));
if(tray)fs.copyFileSync(path.join(__dirname,'linux-tray-control.py'),path.join(report,'tray-control.py'));
fs.copyFileSync(path.join(__dirname,'linux-portal-select.py'),path.join(report,'portal-selector.py'));
fs.copyFileSync(path.join(__dirname,'macos-media-receiver.js'),path.join(report,'receiver.js'));
fs.copyFileSync(path.join(__dirname,'linux-ui-control.py'),path.join(report,'linux-ui-control.py'));
const helperPath=external?path.join(report,'custom ffmpeg','ffmpeg'):'';
if(external){fs.mkdirSync(path.dirname(helperPath));fs.symlinkSync('/usr/bin/ffmpeg',helperPath);}
const result={scope:`Extracted Ubuntu DEB, ${gui?'actual Qt GUI':'CLI'} ${external?'explicit external FFmpeg':'default encoder'}, ${opts.backend==='wayland'?'Wayland portal':'X11'} window capture and software ${codecName} reception; excludes audio, hardware encoders, endurance and production qualification`,
  executableSha256:sha(exe),manifestSha256:sha(manifestFile),harnessSha256:sha(__filename),
  receiverHarnessSha256:sha(path.join(__dirname,'macos-media-receiver.js')),portalHarnessSha256:sha(path.join(__dirname,'linux-portal-select.py')),
  guiHelperSha256:sha(path.join(__dirname,'linux-ui-control.py')),
  host:{platform:os.platform(),release:os.release(),arch:os.arch(),logicalCpus:os.cpus().length},
  previewObserverSha256:preview?sha(path.join(__dirname,'linux-preview-observer.py')):null,
  trayHelperSha256:tray?sha(path.join(__dirname,'linux-tray-control.py')):null,
  requested:{noTray,tray,trayCopyFocus:opts['tray-copy-focus']==='true',trayCopy:opts['tray-copy']||'tray',preview,backend:opts.backend||'x11',encoder:'software',codec,width,height,external,gui,rateControl,portalCancel,pendingQuit,pendingStop,sourceLoss,targetBitrateKbps:rateControl?targetBitrate:null,noiseGrid:rateControl?noiseGrid:null,fps:30,bitrateKbps:gui?4000:2000,audio:'none'},phases:{},passed:false};
let publisher,sourceBrowser,viewerBrowser,log,control,discovery,portalSelector,keyboardServer,keyboardDirectory,portalOwner;
const startedAtSeconds=Math.floor(Date.now()/1000);
const portalBackend='org.freedesktop.impl.portal.desktop.gnome';
const checkPortalOwner=()=>{
  const owner=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner',portalBackend],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
  if(portalOwner)assert.equal(owner,portalOwner,'GNOME portal backend restarted during workflow');
  else{portalOwner=owner;result.portalBackend={name:portalBackend,owner};}
};
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
const processStart=pid=>{try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').pop().split(' ')[19];}catch{return null;}};
const helperProcesses=()=>{
  const children=new Set(fs.readdirSync('/proc/'+publisher.pid+'/task').flatMap(tid=>{
    try{return fs.readFileSync('/proc/'+publisher.pid+'/task/'+tid+'/children','utf8').trim().split(/\s+/).filter(Boolean);}catch{return[];}
  }));
  return [...children].flatMap(pid=>{try{
    const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
    return argv[0]===helperPath?[{pid:Number(pid),startTimeTicks:processStart(pid),argv,executableSha256:sha('/proc/'+pid+'/exe')}]:[];
  }catch{return[];}});
};
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'Control status '+r.status);return r.json();}
(async()=>{console.log('Reports: '+report);save();try{
  const env={...process.env};for(const k of Object.keys(env))if(/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k))delete env[k];
  for(const k of ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])delete env[k];
  env.XDG_STATE_HOME=path.join(report,'private-state');env.XDG_DATA_HOME=path.join(report,'private-data');env.XDG_CONFIG_HOME=path.join(report,'private-config');if(opts.backend==='wayland'){env.XDG_SESSION_TYPE='wayland';env.WAYLAND_DISPLAY=process.env.WAYLAND_DISPLAY||'wayland-0';env.QT_QPA_PLATFORM='wayland';}else{env.XDG_SESSION_TYPE='x11';delete env.WAYLAND_DISPLAY;env.QT_QPA_PLATFORM='xcb';}
  if(gui&&opts.backend==='wayland'){
    keyboardDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'gc-wayland-keys-'));fs.chmodSync(keyboardDirectory,0o700);
    env.GC_QA_KEYBOARD_SOCKET=path.join(keyboardDirectory,'input.sock');
    keyboardServer=spawn('sudo',['-n','python3',path.join(__dirname,'linux-portal-select.py'),'--keyboard-server='+env.GC_QA_KEYBOARD_SOCKET],{env,stdio:['pipe','pipe','pipe']});
    keyboardServer.closed=new Promise(resolve=>keyboardServer.once('close',resolve));let ready='';keyboardServer.stdout.on('data',d=>ready+=d);keyboardServer.stderr.on('data',d=>process.stderr.write(d));
    await waitFor(()=>{assert.equal(keyboardServer.exitCode,null,'Owned keyboard exited');return ready.includes('ready');},10000,'Owned keyboard not ready');
  }
  const sourceBrowserOptions={executablePath:opts.browser||'/usr/bin/google-chrome',headless:false,env,args:[...(opts.backend==='wayland'?['--ozone-platform=wayland']:[]),'--window-position=10,10',opts.backend==='wayland'?'--window-size=720,560':'--window-size=900,650','--disable-background-timer-throttling','--disable-renderer-backgrounding']};
  sourceBrowser=await chromium.launch(sourceBrowserOptions);
  let source=await sourceBrowser.newPage(opts.backend==='wayland'?{viewport:null}:{viewport:{width:800,height:450},deviceScaleFactor:1});
  const title='Owned Linux Capture '+crypto.randomBytes(8).toString('hex');
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0,paused:false};
    const noise=document.createElement('canvas');noise.width=${noiseWidth};noise.height=${noiseHeight};const nctx=noise.getContext('2d'),pixels=nctx.createImageData(${noiseWidth},${noiseHeight});
    function draw(){canvas.width=innerWidth;canvas.height=innerHeight;if(!fixture.paused)fixture.id=(fixture.id+1)%65536;
      const w=canvas.width,h=canvas.height;ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);
      if(${rateControl}){let seed=fixture.id+1;for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=seed>>>24;pixels.data[i+3]=255;}nctx.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(noise,0,0,w,h);}
      ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
      ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('Owned source '+fixture.id,20,.9*h);requestAnimationFrame(draw);
    }draw();</script>`);
  await source.bringToFront();await sleep(1000);await source.screenshot({path:path.join(report,'source.png')});
  result.browserVersion=sourceBrowser.version();result.sourceTitle=title;result.initialSourceMetrics=await source.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));save();
  const stream='gclinux'+crypto.randomBytes(14).toString('hex');discovery=path.join(report,'private-control.json');
  const remoteToken=crypto.randomBytes(24).toString('hex');
  const args=[gui?'--settings-dir='+path.join(report,'private-settings'):'--headless','--source=window','--window='+(opts.backend==='wayland'?'Choose a window':title),'--stream='+stream,'--password=false',
    '--video-encoder=software','--video-codec='+codec,'--resolution='+width+'x'+height,'--fps=30','--bitrate-kbps=2000',
    '--audio-source=none','--duration-ms=150000','--local-control','--local-control-port=0','--local-control-discovery='+discovery];
  if(external)args.push('--ffmpeg-path='+helperPath,'--ffmpeg-options=-threads 2');
  if(rateControl)args.push('--remote-control','--remote-token='+remoteToken);
  if(gui)env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1';
  log=fs.createWriteStream(path.join(report,'private-publisher.log'));
  publisher=spawn(exe,args,{cwd:bundle,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
  const selectPortal=(name='portal-selection',cancel=false,observe='')=>{portalSelector=spawn('python3',[path.join(__dirname,'linux-portal-select.py'),'--title='+title,'--output='+path.join(report,name+'.json'),...(cancel?['--cancel']:[]),...(observe?['--observe='+observe]:[])],{env,stdio:['ignore','pipe','pipe']});portalSelector.stdout.pipe(log,{end:false});portalSelector.stderr.pipe(log,{end:false});};
  if(opts.backend==='wayland'&&!gui)selectPortal();
  publisher.closed=new Promise(resolve=>publisher.once('close',resolve));
  publisher.on('error',error=>{result.launchError=String(error);});
  await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited during startup');assert(!result.launchError,result.launchError);return fs.existsSync(discovery);},15000,'No control discovery');
  control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  const ui=(...arguments_)=>execFileSync('python3',[path.join(__dirname,'linux-ui-control.py'),String(publisher.pid),...arguments_],{env,encoding:'utf8',timeout:opts.backend==='wayland'?60000:10000,stdio:['ignore','pipe','pipe']});
  let trayActionIndex=0;
  const trayUi = (...arguments_) => {
    const shot=arguments_[0]==='action'?path.join(report,'tray-'+(++trayActionIndex)+'-'+arguments_[1].replaceAll(' ','-')+'.png'):null;
    const observation=JSON.parse(execFileSync('python3',[path.join(__dirname,'linux-tray-control.py'),String(publisher.pid),...arguments_,...(shot?['--screenshot='+shot]:[])],{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}));
    if(shot)observation.screenshot={file:path.basename(shot),sha256:sha(shot)};
    return observation;
  };
  const mainVisible = () => JSON.parse(ui('dump')).some(row=>row.role==='frame'&&row.name==='Game Capture - Powered by VDO.Ninja'&&row.states.includes('visible'));
  const previewShot = (label, expected) => {
    ui('activate');
    const output=path.join(report,'preview-'+label+'.png');
    const observation=JSON.parse(execFileSync('python3',[path.join(__dirname,'linux-preview-observer.py'),'--pid='+publisher.pid,'--output='+output,'--expected='+expected],{env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}));
    result.preview ??= {};result.preview[label]={...observation,screenshotSha256:sha(output)};save();return observation;
  };
  const checkPreview = async label => {
    if(!preview)return;
    for(const id of [13735,51546]){
      await source.evaluate(id=>{fixture.paused=true;fixture.id=id;},id);await sleep(2200);
      previewShot(label+'-'+id,id);
    }
    await source.evaluate(()=>{fixture.paused=false;});
  };
  if(gui){
    await waitFor(()=>{try{return JSON.parse(ui('dump')).some(r=>['Go live','Go live unavailable'].includes(r.name));}catch{return false;}},20000,'GUI not accessible');
    if(noTray){const option=JSON.parse(ui('dump')).find(row=>row.name==='Minimize To Tray On Close');assert(option&&!option.states.includes('sensitive')&&!option.states.includes('checked'),'No-host tray preference is enabled');result.noTray={preferenceDisabled:true};}
    if(tray){result.tray={idle:trayUi('snapshot')};assert.match(result.tray.idle.tooltip,/Idle/);save();}
    ui('press','Show advanced settings');
    ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)');
    ui('choose','1280x720','960x540');ui('choose','60','30');
    if(codec!=='h264')ui('choose-prefix','H.264 (Compatibility)',codec==='vp9'?'VP9 (':'AV1 (');
    ui('choose','Selected window/app audio','No audio');
    if((preview||tray||noTray)&&!JSON.parse(ui('dump')).some(row=>row.role==='combo box'&&row.name==='No microphone'))ui('choose','Linux default microphone/input','No microphone');
    ui('source',opts.backend==='wayland'?'Choose a window':title);ui('text','Stream ID or VDO.Ninja URL',stream);ui('text','Stream password','false');
    if(tray){assert.equal(JSON.parse(ui('copy','Stream ID or VDO.Ninja URL')),stream);assert.equal(JSON.parse(ui('paste','Stream ID or VDO.Ninja URL')),stream);result.tray.fixtureCopyPastePassed=true;}
    if(external){ui('text','FFmpeg Path',helperPath);ui('text','FFmpeg Options','-threads 2');}
    fs.writeFileSync(path.join(report,'ui-before-live.json'),ui('dump'));
    if(pendingQuit||pendingStop){
      selectPortal('portal-pending',false,'open');ui('press','Go live');
      await waitFor(()=>portalSelector.exitCode!==null,30000,'Permission dialog did not open');assert.equal(portalSelector.exitCode,0);
      assert(JSON.parse(fs.readFileSync(path.join(report,'portal-pending.json'))).passed);
      const d=await api('/diagnostics');assert(!d.app.capturing&&!d.app.live);assert.equal(d.video.frames_captured,0);
      checkPortalOwner();
      const started=Date.now();await api('/commands',{command:pendingQuit?'quit':'stop'});
      if(pendingQuit){
        await waitFor(()=>publisher.exitCode!==null,8000,'Quit did not cancel pending portal permission');await publisher.closed;
        assert.equal(publisher.exitCode,0);assert(!fs.existsSync(discovery));
      }else{
        await waitFor(()=>JSON.parse(ui('dump')).some(r=>r.name==='Go live'&&r.states.includes('sensitive')),8000,'Stop did not cancel pending permission');
        const stopped=await api('/diagnostics');assert(!stopped.app.live&&!stopped.app.capturing);assert.equal(stopped.video.frames_captured,0);
      }
      const elapsedMs=Date.now()-started;
      selectPortal('portal-after-command',false,'closed');await waitFor(()=>portalSelector.exitCode!==null,12000,'Portal closure observer timed out');assert.equal(portalSelector.exitCode,0);
      result[pendingQuit?'pendingQuit':'pendingStop']={passed:false,appStopped:true,elapsedMs};save();
      await sleep(2000);checkPortalOwner();
      result[pendingQuit?'pendingQuit':'pendingStop'].passed=true;
      if(pendingQuit){result.passed=true;return;}
    }
    if(portalCancel){
      selectPortal('portal-cancel',true);ui('press','Go live');
      await waitFor(()=>portalSelector.exitCode!==null,30000,'Portal cancellation did not finish');assert.equal(portalSelector.exitCode,0);
      assert(JSON.parse(fs.readFileSync(path.join(report,'portal-cancel.json'))).passed);
      await waitFor(()=>JSON.parse(ui('dump')).some(r=>r.name==='Go live'&&r.states.includes('sensitive')),15000,'GUI did not recover from portal cancellation');
      const cancelled=await api('/diagnostics');assert(!cancelled.app.live&&!cancelled.app.capturing);assert.equal(cancelled.video.frames_captured,0);
      const rows=JSON.parse(ui('dump'));assert(rows.some(r=>r.role==='label'&&/failed.*capture/i.test(r.name)),'No visible capture failure status');
      result.portalCancellation={passed:true,noFramesCaptured:true,retryEnabled:true};save();
    }
    if(preview){
      if(opts.backend==='wayland'){
        const shot=previewShot('idle','none');assert(/Go live.*choose a window/i.test(shot.description));
        assert.equal((await api('/diagnostics')).video.frames_captured,0);
        ui('choose','Window','Camera / Webcam');
        assert.equal(previewShot('camera-mode','none').description,'','Window guidance survived source-mode change');
        ui('choose','Camera / Webcam','Window');ui('source','Choose a window');
        assert(/Go live.*choose a window/i.test(previewShot('window-mode-restored','none').description));
        const idle=await api('/diagnostics');assert(!idle.app.capturing);assert.equal(idle.video.frames_captured,0);
        result.previewModeSwitchPassed=true;save();
      }else await checkPreview('idle');
    }
    if(opts.backend==='wayland')selectPortal();
    ui('press','Go live');await waitFor(async()=> (await api('/diagnostics')).app.live,30000,'GUI did not go live');
  }

  if(opts.backend==='wayland'&&!gui)await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited during portal selection');return fs.readFileSync(path.join(report,'private-publisher.log'),'utf8').includes('[Headless] Going live');},75000,'Portal selection/startup did not finish');
  if(opts.backend==='wayland'){await waitFor(()=>portalSelector.exitCode!==null,10000,'Portal selector did not finish');assert.equal(portalSelector.exitCode,0);assert(JSON.parse(fs.readFileSync(path.join(report,'portal-selection.json'))).passed);checkPortalOwner();}
  viewerBrowser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:true,env,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  const capabilities=await viewerBrowser.newPage();result.receiverCapabilities=await capabilities.evaluate(()=>RTCRtpReceiver.getCapabilities('video'));await capabilities.close();save();
  const viewer=await receiver(viewerBrowser,stream,publisher);
  result.phases.moving=await observe(viewer,6000);result.initialDistinct=requireMoving(result.phases.moving,'Initial Linux software stream',expectedCodec);await viewer.screenshot({path:path.join(report,'receiver.png')});save();
  assert.equal(result.phases.moving.width,width);assert.equal(result.phases.moving.height,height);
  await checkPreview('live');
  const diagnostics=await api('/diagnostics');
  result.activeEncoder=diagnostics.video.active_encoder;result.hardwareEncoder=diagnostics.video.hardware_encoder;
  result.configuredBitrateKbps=diagnostics.video.configured_bitrate_kbps;
  assert.equal(result.configuredBitrateKbps,result.requested.bitrateKbps);
  assert.equal(result.hardwareEncoder,false,'Explicit software request used hardware');
  assert.equal(diagnostics.video.active_codec,codecName);
  const encoderNames={h264:'libx264',h265:'libx265',vp8:'libvpx',vp9:'libvpx-vp9',av1:'libaom-av1'};
  assert.equal(result.activeEncoder,(external?'FFmpeg ':'')+encoderNames[codec]);
  if(external){
    result.helperProcesses=helperProcesses();
    assert.equal(result.helperProcesses.length,1,'Custom FFmpeg path did not own exactly one encoder process');
    assert(result.helperProcesses[0].argv.some((arg,i,args)=>arg==='-threads'&&args[i+1]==='2'),'Custom options not passed to the encoder');
    result.helperSha256=sha('/usr/bin/ffmpeg');assert.equal(result.helperProcesses[0].executableSha256,result.helperSha256);
  }
  result.publisherCounters={framesCaptured:diagnostics.video.frames_captured,framesSent:diagnostics.video.frames_sent,
    encodeFailures:diagnostics.video.encode_failures,encodeTimeouts:diagnostics.video.encode_timeouts};
  if(rateControl){
    const send=async(targetBitrate,remote)=>viewer.evaluate(({targetBitrate,remote})=>{
      const uuid=Object.keys(session.rpcs).find(id=>session.rpcs[id].connectionState==='connected');
      if(!uuid)throw Error('No connected publisher');
      return session.sendRequest({targetBitrate,remote},uuid)!==false;
    },{targetBitrate,remote});
    const sample=async label=>{
      const before=await observe(viewer,100);const after=await observe(viewer,7000);
      result.phases[label]=after;save();
      const end=after.tracks.find(t=>t.kind==='video'&&t.codec?.toLowerCase()===expectedCodec);
      const start=before.tracks.find(t=>t.id===end?.id);assert(start&&end,'Missing inbound video stats');
      const kbps=(end.bytesReceived-start.bytesReceived)*8/(end.timestamp-start.timestamp);
      const fps=(end.framesDecoded-start.framesDecoded)*1000/(end.timestamp-start.timestamp);
      assert(kbps>0&&fps>10,'Stream stopped during bitrate control');
      const diagnostic=await api('/diagnostics');assert.equal(diagnostic.video.active_codec,codecName);
      const measurement={kbps,fps,configuredKbps:diagnostic.video.configured_bitrate_kbps};
      result.rateControl[label]=measurement;save();
      requireMoving(after,label,expectedCodec);return measurement;
    };
    const change=async(target,wanted,label)=>{
      const [transition]=await Promise.all([observe(viewer,4000),(async()=>{
        // Start observation before sending control so the transition is included.
        await sleep(150);assert(await send(target,remoteToken));
        await waitFor(async()=>(await api('/diagnostics')).video.configured_bitrate_kbps===wanted,10000,'Bitrate control not applied');
      })()]);
      result.phases[label]=transition;save();requireMoving(transition,label,expectedCodec);
    };
    result.rateControl={};
    await sleep(2000);const baseline=await sample('rateBaseline');
    assert.equal(baseline.configuredKbps,2000);
    assert(await send(targetBitrate,'invalid-owned-fixture-token'));await sleep(1500);
    assert.equal((await api('/diagnostics')).video.configured_bitrate_kbps,2000,'Unauthorized control was accepted');
    result.rateControl.unauthorizedRejected=true;
    await change(targetBitrate,targetBitrate,'rateReductionTransition');const reduced=await sample('rateReduced');
    // Measure the received payload: a changed diagnostics field alone is insufficient.
    assert(reduced.kbps<baseline.kbps*.65,'Received video bitrate did not fall');
    assert(reduced.kbps>=targetBitrate*.5&&reduced.kbps<=targetBitrate*1.5,'Received video rate is outside the bounded target tolerance');
    await change(false,2000,'rateRestorationTransition');const restored=await sample('rateRestored');
    assert(restored.kbps>reduced.kbps*1.5,'Received video bitrate did not recover');
    assert(restored.kbps>baseline.kbps*.65,'Restored video bitrate remains below baseline');save();
  }
  await source.evaluate(()=>{fixture.paused=true;});await sleep(1000);
  result.phases.static=await observe(viewer,2500);
  assert(!result.phases.static.observerError);assert.equal(result.phases.static.identityReadFailures,0);
  assert.equal(new Set(result.phases.static.observations.map(x=>x.id)).size,1,'Static picture changed');
  assert(result.phases.static.observations.length>=10,'Static picture was not paced');save();
  await source.evaluate(()=>{fixture.paused=false;});if(opts.backend==='wayland'){const session=await source.context().newCDPSession(source);const {windowId}=await session.send('Browser.getWindowForTarget');await session.send('Browser.setWindowBounds',{windowId,bounds:{width:600,height:460}});}else await source.setViewportSize({width:680,height:420});await sleep(800);await source.screenshot({path:path.join(report,'source-resized.png')});result.resizedSourceMetrics=await source.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));const sourceSession=await source.context().newCDPSession(source);result.resizedWindowBounds=await sourceSession.send('Browser.getWindowForTarget');if(opts.backend==='wayland'){assert(result.resizedSourceMetrics.innerWidth<=result.resizedSourceMetrics.outerWidth,'Fixture viewport exceeds its real window');assert(result.initialSourceMetrics.outerWidth!==result.resizedSourceMetrics.outerWidth||result.initialSourceMetrics.outerHeight!==result.resizedSourceMetrics.outerHeight,'Native source window did not resize');}if(opts['desktop-evidence']==='true')await new Promise((resolve,reject)=>{const shot=spawn('gnome-screenshot',['-f',path.join(report,'desktop-resized.png')],{env});shot.once('error',reject);shot.once('close',code=>code===0?resolve():reject(Error('Desktop screenshot failed')));});await viewer.screenshot({path:path.join(report,'receiver-resized.png')});
  result.phases.resized=await observe(viewer,4000);requireMoving(result.phases.resized,'Resized Linux stream',expectedCodec);save();
  const late=await receiver(viewerBrowser,stream,publisher);result.phases.late=await observe(late,3000);requireMoving(result.phases.late,'Late Linux receiver',expectedCodec);save();
  if(external){result.helpersBeforeStop=helperProcesses();assert.equal(result.helpersBeforeStop.length,1);}
  await checkPreview('resized');
  if(noTray){
    ui('activate');ui('close-window');await waitFor(()=>publisher.exitCode!==null,10000,'Window close stranded the publisher without a tray');await publisher.closed;
    assert.equal(publisher.exitCode,0);assert(!fs.existsSync(discovery));result.noTray.closeExitsWhileLive=true;result.passed=true;save();return;
  }
  if(tray){
    result.tray.live=trayUi('snapshot');assert.match(result.tray.live.tooltip,/LIVE/);
    assert.notEqual(result.tray.idle.iconSha256,result.tray.live.iconSha256,'Live tray icon did not change');
    const share=JSON.parse(ui('dump')).filter(row=>row.role==='label'&&row.name.startsWith('https://vdo.ninja/?view='+stream));assert.equal(share.length,1);
    ui('activate');ui('close-window');await waitFor(()=>!mainVisible(),6000,'Close did not hide the window to tray');
    assert((await api('/diagnostics')).app.live);result.tray.closeHidesWhileLive=true;
    result.phases.trayHidden=await observe(viewer,4000);requireMoving(result.phases.trayHidden,'Publishing while closed to tray',expectedCodec);save();
    if(opts['tray-copy']==='window'){
      result.tray.show=trayUi('action','Show');await waitFor(()=>mainVisible(),6000,'Tray Show did not reopen');ui('activate');ui('press','Copy Link');result.tray.copy={action:'Window Copy Link button'};
    }else{
      result.tray.copy=trayUi('action','Copy Share Link');
      if(opts['tray-copy-focus']==='true'){
        await waitFor(()=>{const rows=JSON.parse(ui('dump'));return rows.some(row=>row.role==='frame'&&row.name==='Game Capture - Powered by VDO.Ninja'&&row.states.includes('active'))&&rows.some(row=>row.role==='label'&&row.name==='Share link copied to clipboard');},6000,'Tray copy did not restore focus and complete');
        result.tray.copyRestoredFocusAndCompleted=true;
      }else{
        assert(!mainVisible(),'Copy link unexpectedly reopened the window');
        result.tray.show=trayUi('action','Show');await waitFor(()=>mainVisible(),6000,'Tray Show did not reopen the window');
      }
    }
    result.tray.hide=trayUi('action','Hide');await waitFor(()=>!mainVisible(),6000,'Tray Hide did not hide the window');
    result.phases.trayHiddenAgain=await observe(viewer,3000);requireMoving(result.phases.trayHiddenAgain,'Publishing after tray Hide',expectedCodec);
    trayUi('action','Show');await waitFor(()=>mainVisible(),6000,'Second Show did not reopen the window');
    result.tray.stop=trayUi('action','Stop');await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'Tray Stop did not stop capture');
    const before=await api('/diagnostics');await sleep(600);assert.equal(before.video.frames_captured,(await api('/diagnostics')).video.frames_captured);
    result.tray.stopped=trayUi('snapshot');assert.match(result.tray.stopped.tooltip,/Idle/);assert.equal(result.tray.stopped.iconSha256,result.tray.idle.iconSha256);
    ui('activate');const pasted=JSON.parse(ui('paste','Stream ID or VDO.Ninja URL'));assert(pasted===share[0].name,'Copy/paste differs from the shown share link');
    result.tray.shareLinkRoundTripPassed=true;
    trayUi('action','Hide');await waitFor(()=>!mainVisible(),6000,'Window did not hide before tray restart');
    selectPortal('portal-tray-restart');result.tray.restart=trayUi('action','Go Live');
    await waitFor(async()=> (await api('/diagnostics')).app.live,30000,'Tray Go Live did not restart publishing');
    await waitFor(()=>portalSelector.exitCode!==null,10000,'Tray restart portal selection did not finish');assert.equal(portalSelector.exitCode,0);
    assert(JSON.parse(fs.readFileSync(path.join(report,'portal-tray-restart.json'))).passed);
    const restarted=await receiver(viewerBrowser,stream,publisher);result.phases.trayRestarted=await observe(restarted,4000);requireMoving(result.phases.trayRestarted,'Tray Go Live after pasted share URL',expectedCodec);
    assert(!mainVisible(),'Tray restart unexpectedly reopened the window');result.tray.restartWhileHiddenPassed=true;
    result.tray.quit=trayUi('action','Quit');await waitFor(()=>publisher.exitCode!==null,10000,'Tray Quit did not retire the live publisher');await publisher.closed;
    assert.equal(publisher.exitCode,0);assert(!fs.existsSync(discovery));
    const owner=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.NameHasOwner',result.tray.live.service],{encoding:'utf8',timeout:5000});assert(owner.includes('false'),'Tray registration survived app exit');
    result.tray.quitWhileHiddenLivePassed=true;result.passed=true;save();return;
  }
  if(gui){
    let replacementMarkup;
    if(sourceLoss){
      replacementMarkup=await source.content();await sourceBrowser.close();sourceBrowser=null;
      await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.live&&!d.app.capturing;},15000,'GUI did not retire a destroyed source');
      const rows=JSON.parse(ui('dump'));assert(rows.some(r=>r.role==='label'&&/window capture stopped/i.test(r.name)),'Missing source-loss status');
      assert(rows.some(r=>r.name==='Go live'&&r.states.includes('sensitive')),'Source loss did not enable retry');result.guiSourceLossPassed=true;
    }else{ui('press','Stop streaming');await waitFor(async()=>!(await api('/diagnostics')).app.capturing,10000,'GUI stop did not finish');}

    const before=await api('/diagnostics');await sleep(500);const after=await api('/diagnostics');
    assert.equal(before.video.frames_captured,after.video.frames_captured);result[sourceLoss?'guiSourceLossSettled':'guiStopSettled']=true;
    if(opts.backend==='wayland'){
      if(preview){const shot=previewShot('stopped','none');assert(/Go live.*choose a window/i.test(shot.description),'Missing Wayland preview permission guidance');}
      if(sourceLoss){sourceBrowser=await chromium.launch(sourceBrowserOptions);source=await sourceBrowser.newPage({viewport:null});await source.setContent(replacementMarkup);await source.bringToFront();await sleep(1000);ui('source','Choose a window');}
      selectPortal('portal-restarted');ui('press','Go live');
      await waitFor(async()=> (await api('/diagnostics')).app.live,30000,'Wayland GUI restart did not go live');
      await waitFor(()=>portalSelector.exitCode!==null,10000,'Restarted portal selection did not finish');assert.equal(portalSelector.exitCode,0);
      assert(JSON.parse(fs.readFileSync(path.join(report,'portal-restarted.json'))).passed);
      const restarted=await receiver(viewerBrowser,stream,publisher);result.phases.restarted=await observe(restarted,4000);requireMoving(result.phases.restarted,'Restarted Wayland GUI',expectedCodec);await checkPreview('restarted');await restarted.close();
      ui('press','Stop streaming');await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.capturing&&!d.app.live;},10000,'Restarted GUI did not stop');result.guiRestartPassed=true;
    }
    await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,8000,'GUI quit did not finish');await publisher.closed;
    assert.equal(publisher.exitCode,0);assert(!fs.existsSync(discovery));result.passed=true;
  }else{
  await sourceBrowser.close();sourceBrowser=null;
  await waitFor(()=>publisher.exitCode!==null,15000,'Publisher did not report destroyed source');
  await publisher.closed;result.exitCode=publisher.exitCode;result.exitSignal=publisher.signalCode;
  assert.equal(result.exitCode,3,'Expected source-loss exit code');assert.equal(result.exitSignal,null);
  assert(!fs.existsSync(discovery),'Discovery survived shutdown');result.sourceClosureReported=true;result.passed=true;
  }
  if(external){
    await waitFor(()=>[...result.helperProcesses,...result.helpersBeforeStop].every(p=>processStart(p.pid)!==p.startTimeTicks),5000,'Owned FFmpeg helper survived shutdown');
    result.helpersRetired=true;
  }
}catch(error){result.passed=false;result.error=String(error.stack||error);process.exitCode=1;if(gui&&opts.backend==='wayland'&&publisher?.exitCode===null){try{fs.writeFileSync(path.join(report,'ui-failure.json'),execFileSync('python3',[path.join(__dirname,'linux-ui-control.py'),String(publisher.pid),'dump'],{env:{...process.env,QT_QPA_PLATFORM:'wayland'},timeout:10000}));execFileSync('gnome-screenshot',['-f',path.join(report,'desktop-failure.png')],{env:{...process.env,WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0'},timeout:10000});}catch{}}}finally{
  if(publisher&&publisher.exitCode===null){
    try{if(control)await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,6000,'Cleanup quit timed out');}
    catch{publisher.kill();await publisher.closed;}
  }
  if(portalSelector&&portalSelector.exitCode===null)portalSelector.kill();
  if(keyboardServer){keyboardServer.stdin.end();await waitFor(()=>keyboardServer.exitCode!==null,8000,'Owned keyboard did not stop');await keyboardServer.closed;}if(keyboardDirectory)fs.rmdirSync(keyboardDirectory);
  if(sourceBrowser)await sourceBrowser.close();if(viewerBrowser)await viewerBrowser.close();
  if(log)await new Promise(resolve=>log.end(resolve));
  if(publisher){result.exitCode=publisher.exitCode;result.exitSignal=publisher.signalCode;}
  if(gui){const nativeLog=path.join(report,'private-state/GameCapture/logs/game-capture-debug.log');if(fs.existsSync(nativeLog))fs.copyFileSync(nativeLog,path.join(report,'private-native.log'));}
  if(opts.backend==='wayland'){
    await sleep(2000);
    try{
      const journal=execFileSync('journalctl',['--user','-u','xdg-desktop-portal.service','-u','xdg-desktop-portal-gnome.service','--since=@'+startedAtSeconds,'--no-pager','-o','short-iso'],{encoding:'utf8',timeout:5000});
      const journalFile=path.join(report,'portal-journal.log');fs.writeFileSync(journalFile,journal);result.portalJournalSha256=sha(journalFile);
      assert(!/status=\d+\/(?:SEGV|ABRT)|Failed with result 'core-dump'/.test(journal),'Portal service crashed during workflow');
      if(portalOwner)checkPortalOwner();
      if(result.portalBackend)result.portalBackend.survived=true;
    }catch(error){result.passed=false;result.error=[result.error,String(error.stack||error)].filter(Boolean).join('\n');process.exitCode=1;}
  }
  save();console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
}})();
