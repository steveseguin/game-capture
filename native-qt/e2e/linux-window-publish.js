'use strict';
// Extracted Ubuntu DEB -> X11/Wayland window -> software H.264 -> real VDO.Ninja receiver.
// Hosted VM functional coverage only. No hardware encoder, audio or performance claim.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const assert=require('assert/strict'),{spawn}=require('child_process');
const {chromium}=require('playwright');
const {receiver,observe,requireMoving,waitFor,sleep}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
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
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
fs.copyFileSync(__filename,path.join(report,'harness.js'));
fs.copyFileSync(path.join(__dirname,'linux-portal-select.py'),path.join(report,'portal-selector.py'));
fs.copyFileSync(path.join(__dirname,'macos-media-receiver.js'),path.join(report,'receiver.js'));
const result={scope:`Extracted Ubuntu DEB, ${opts.backend==='wayland'?'Wayland portal':'X11'} window capture and software H.264 reception; excludes audio, hardware encoders, endurance and production qualification`,
  executableSha256:sha(exe),manifestSha256:sha(manifestFile),harnessSha256:sha(__filename),
  receiverHarnessSha256:sha(path.join(__dirname,'macos-media-receiver.js')),portalHarnessSha256:sha(path.join(__dirname,'linux-portal-select.py')),
  host:{platform:os.platform(),release:os.release(),arch:os.arch(),logicalCpus:os.cpus().length},
  requested:{backend:opts.backend||'x11',encoder:'software',codec:'h264',width:640,height:360,fps:30,bitrateKbps:2000,audio:'none'},phases:{},passed:false};
let publisher,sourceBrowser,viewerBrowser,log,control,discovery,portalSelector;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'Control status '+r.status);return r.json();}
(async()=>{console.log('Reports: '+report);save();try{
  const env={...process.env};for(const k of Object.keys(env))if(/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k))delete env[k];
  for(const k of ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN'])delete env[k];
  env.XDG_STATE_HOME=path.join(report,'private-state');env.XDG_DATA_HOME=path.join(report,'private-data');env.XDG_CONFIG_HOME=path.join(report,'private-config');if(opts.backend==='wayland'){env.XDG_SESSION_TYPE='wayland';env.WAYLAND_DISPLAY=process.env.WAYLAND_DISPLAY||'wayland-0';env.QT_QPA_PLATFORM='wayland';}else{env.XDG_SESSION_TYPE='x11';delete env.WAYLAND_DISPLAY;env.QT_QPA_PLATFORM='xcb';}
  sourceBrowser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:false,env,args:[...(opts.backend==='wayland'?['--ozone-platform=wayland']:[]),'--window-position=10,10',opts.backend==='wayland'?'--window-size=720,560':'--window-size=900,650','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const source=await sourceBrowser.newPage(opts.backend==='wayland'?{viewport:null}:{viewport:{width:800,height:450},deviceScaleFactor:1});
  const title='Owned Linux Capture '+crypto.randomBytes(8).toString('hex');
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0,paused:false};
    function draw(){canvas.width=innerWidth;canvas.height=innerHeight;if(!fixture.paused)fixture.id=(fixture.id+1)%65536;
      const w=canvas.width,h=canvas.height;ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);
      ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
      ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('Owned source '+fixture.id,20,.9*h);requestAnimationFrame(draw);
    }draw();</script>`);
  await source.bringToFront();await sleep(1000);await source.screenshot({path:path.join(report,'source.png')});
  result.browserVersion=sourceBrowser.version();result.sourceTitle=title;result.initialSourceMetrics=await source.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));save();
  const stream='gclinux'+crypto.randomBytes(14).toString('hex');discovery=path.join(report,'private-control.json');
  const args=['--headless','--source=window','--window='+(opts.backend==='wayland'?'Choose a window':title),'--stream='+stream,'--password=false',
    '--video-encoder=software','--video-codec=h264','--resolution=640x360','--fps=30','--bitrate-kbps=2000',
    '--audio-source=none','--duration-ms=150000','--local-control','--local-control-port=0','--local-control-discovery='+discovery];
  log=fs.createWriteStream(path.join(report,'private-publisher.log'));
  publisher=spawn(exe,args,{cwd:bundle,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
  if(opts.backend==='wayland'){portalSelector=spawn('python3',[path.join(__dirname,'linux-portal-select.py'),'--title='+title,'--output='+path.join(report,'portal-selection.json')],{env,stdio:['ignore','pipe','pipe']});portalSelector.stdout.pipe(log,{end:false});portalSelector.stderr.pipe(log,{end:false});}
  publisher.closed=new Promise(resolve=>publisher.once('close',resolve));
  publisher.on('error',error=>{result.launchError=String(error);});
  await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited during startup');assert(!result.launchError,result.launchError);return fs.existsSync(discovery);},15000,'No control discovery');
  control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  if(opts.backend==='wayland')await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited during portal selection');return fs.readFileSync(path.join(report,'private-publisher.log'),'utf8').includes('[Headless] Going live');},75000,'Portal selection/startup did not finish');
  viewerBrowser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:true,env,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  const viewer=await receiver(viewerBrowser,stream,publisher);
  result.phases.moving=await observe(viewer,6000);result.initialDistinct=requireMoving(result.phases.moving,'Initial Linux software stream');await viewer.screenshot({path:path.join(report,'receiver.png')});save();
  assert.equal(result.phases.moving.width,640);assert.equal(result.phases.moving.height,360);
  const diagnostics=await api('/diagnostics');
  result.activeEncoder=diagnostics.video.active_encoder;result.hardwareEncoder=diagnostics.video.hardware_encoder;
  assert.equal(result.hardwareEncoder,false,'Explicit software request used hardware');
  assert.equal(diagnostics.video.active_codec,'H.264');
  result.publisherCounters={framesCaptured:diagnostics.video.frames_captured,framesSent:diagnostics.video.frames_sent,
    encodeFailures:diagnostics.video.encode_failures,encodeTimeouts:diagnostics.video.encode_timeouts};
  await source.evaluate(()=>{fixture.paused=true;});await sleep(1000);
  result.phases.static=await observe(viewer,2500);
  assert(!result.phases.static.observerError);assert.equal(result.phases.static.identityReadFailures,0);
  assert.equal(new Set(result.phases.static.observations.map(x=>x.id)).size,1,'Static picture changed');
  assert(result.phases.static.observations.length>=10,'Static picture was not paced');save();
  await source.evaluate(()=>{fixture.paused=false;});if(opts.backend==='wayland'){const session=await source.context().newCDPSession(source);const {windowId}=await session.send('Browser.getWindowForTarget');await session.send('Browser.setWindowBounds',{windowId,bounds:{width:600,height:460}});}else await source.setViewportSize({width:680,height:420});await sleep(800);await source.screenshot({path:path.join(report,'source-resized.png')});result.resizedSourceMetrics=await source.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio}));const sourceSession=await source.context().newCDPSession(source);result.resizedWindowBounds=await sourceSession.send('Browser.getWindowForTarget');if(opts.backend==='wayland'){assert(result.resizedSourceMetrics.innerWidth<=result.resizedSourceMetrics.outerWidth,'Fixture viewport exceeds its real window');assert(result.initialSourceMetrics.outerWidth!==result.resizedSourceMetrics.outerWidth||result.initialSourceMetrics.outerHeight!==result.resizedSourceMetrics.outerHeight,'Native source window did not resize');}if(opts['desktop-evidence']==='true')await new Promise((resolve,reject)=>{const shot=spawn('gnome-screenshot',['-f',path.join(report,'desktop-resized.png')],{env});shot.once('error',reject);shot.once('close',code=>code===0?resolve():reject(Error('Desktop screenshot failed')));});await viewer.screenshot({path:path.join(report,'receiver-resized.png')});
  result.phases.resized=await observe(viewer,4000);requireMoving(result.phases.resized,'Resized Linux stream');save();
  const late=await receiver(viewerBrowser,stream,publisher);result.phases.late=await observe(late,3000);requireMoving(result.phases.late,'Late Linux receiver');save();
  await sourceBrowser.close();sourceBrowser=null;
  await waitFor(()=>publisher.exitCode!==null,15000,'Publisher did not report destroyed source');
  await publisher.closed;result.exitCode=publisher.exitCode;result.exitSignal=publisher.signalCode;
  assert.equal(result.exitCode,3,'Expected source-loss exit code');assert.equal(result.exitSignal,null);
  assert(!fs.existsSync(discovery),'Discovery survived shutdown');result.sourceClosureReported=true;result.passed=true;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;}finally{
  if(publisher&&publisher.exitCode===null){
    try{if(control)await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,6000,'Cleanup quit timed out');}
    catch{publisher.kill();await publisher.closed;}
  }
  if(portalSelector&&portalSelector.exitCode===null)portalSelector.kill();
  if(sourceBrowser)await sourceBrowser.close();if(viewerBrowser)await viewerBrowser.close();
  if(log)await new Promise(resolve=>log.end(resolve));
  if(publisher){result.exitCode=publisher.exitCode;result.exitSignal=publisher.signalCode;}
  save();console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
}})();
