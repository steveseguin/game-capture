'use strict';
// Physical HDMI loopback only: display -> selected V4L2 device -> packaged app
// -> hosted VDO.Ninja -> browser. Requires this host's display wired to the camera.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const assert = require('assert/strict'), {spawn, execFileSync} = require('child_process');
const {chromium} = require('playwright');
const {receiver, observe, requireMoving, waitFor, sleep} = require('./macos-media-receiver');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)];
}));
assert.equal(process.platform, 'linux');
const gui = opts.gui === 'true', wayland = gui && opts.backend === 'wayland';
const guiBusyRetry = opts['gui-busy-retry'] === 'true';if(guiBusyRetry)assert(gui);
if (gui) {
  assert(wayland ? process.env.GC_QA_WAYLAND_DESKTOP : process.env.GC_QA_PRIVATE_DESKTOP, 'Use the matching owned desktop wrapper');
  assert(opts['source-wayland-socket'] && path.isAbsolute(opts['source-wayland-socket']), 'Explicit host Wayland socket required for the physical HDMI source');
  assert(opts['camera-label'], 'Exact camera display label required');
}
for (const key of ['publisher', 'reports', 'manifest-sha256', 'camera-id']) assert(opts[key], key);
assert.equal(opts['hdmi-loopback'], 'true', 'Explicitly identify the physical HDMI loopback fixture');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exe = path.resolve(opts.publisher), bundle = path.resolve(path.dirname(exe), '../..');
const manifestFile = path.join(bundle, 'release-artifact-manifest.json');
assert.equal(sha(manifestFile), opts['manifest-sha256']);
const manifest = JSON.parse(fs.readFileSync(manifestFile));
assert.equal(manifest.artifact.sha256, sha(exe));
assert.equal(manifest.payload.fileCount, manifest.payload.files.length);
for (const item of manifest.payload.files) {
  const file = path.resolve(bundle, item.relativePath);
  assert(file.startsWith(bundle + path.sep));
  assert.equal(fs.statSync(file).size, item.size); assert.equal(sha(file), item.sha256);
}
const report = path.resolve(opts.reports, crypto.randomUUID()); fs.mkdirSync(report, {recursive:true, mode:0o700});
for (const name of ['linux-camera-publish.js', 'macos-media-receiver.js']) fs.copyFileSync(path.join(__dirname, name), path.join(report, name));
if (gui) for (const name of ['linux-ui-control.py', 'linux-preview-observer.py']) fs.copyFileSync(path.join(__dirname, name), path.join(report, name));
if (wayland) for (const name of ['linux-portal-select.py','linux-virtual-monitor.py']) fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const result = {
  gui, guiBusyRetry, backend:gui?(wayland?'wayland':'x11'):null,
  scope:'Extracted Ubuntu DEB, physical V4L2 HDMI loopback with 10 Hz source identities and 30 fps software H264; excludes audio, MJPEG, other devices, disconnection, high-motion fidelity, endurance and release qualification',
  executableSha256:sha(exe), manifestSha256:sha(manifestFile), harnessSha256:sha(__filename),
  receiverHarnessSha256:sha(path.join(__dirname, 'macos-media-receiver.js')),
  cameraId:opts['camera-id'], requested:{codec:'h264', encoder:'software', width:gui?1280:640, height:gui?720:360, fps:30, audio:'none'},
  cycles:[], passed:false
};
if (gui) {
  result.scope += '; actual '+(wayland?'native GNOME Wayland':'X11')+' Qt camera selection, idle/live/Stop/restart preview screenshots, persisted settings and independent physical camera reception. Source stays on the original Wayland HDMI display; app uses '+(wayland?'an owned GNOME virtual monitor':'a separate private Xvfb display')+' to avoid visual feedback.';
  result.guiHelperSha256=sha(path.join(report,'linux-ui-control.py'));
  result.previewObserverSha256=sha(path.join(report,'linux-preview-observer.py'));
}
if(guiBusyRetry)result.scope+='; visible GUI busy-camera failure while an owned publisher streams, uninterrupted owner reception and successful explicit retry after releasing the owner.';
const save = () => fs.writeFileSync(path.join(report, 'results.json'), JSON.stringify(result, null, 2) + '\n');
result.harnesses=Object.fromEntries(fs.readdirSync(report).filter(n=>/\.(js|py)$/.test(n)).map(n=>[n,sha(path.join(report,n))]));
const children = []; let sourceBrowser, viewerBrowser, monitor, keyboard, keyboardDirectory;
async function api(control, route, body) {
  const response = await fetch(control.base_url + route, {
    method:body ? 'POST' : 'GET', headers:{Authorization:'Bearer ' + control.token, 'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(5000)
  });
  assert(response.ok, 'Control HTTP ' + response.status); return response.json();
}
function publish(name, env, headless = !gui) {
  const stream = 'gclinuxcam' + crypto.randomBytes(14).toString('hex');
  const discovery = path.join(report, name + '-private-control.json');
  const logFile = path.join(report, name + '-private-publisher.log');
  const log = fs.createWriteStream(logFile);
  const child = spawn(exe, [...(headless ? ['--headless'] : ['--settings-dir='+path.join(report,'private-settings')]), '--source=camera', '--camera-id=' + opts['camera-id'],
    '--stream=' + stream, '--password=false', '--video-encoder=software', '--video-codec=h264',
    '--resolution=640x360', '--fps=30', '--bitrate-kbps=2000', '--audio-source=none',
    '--duration-ms=120000', '--local-control', '--local-control-port=0', '--local-control-discovery=' + discovery],
    {cwd:bundle, env, stdio:['ignore', 'pipe', 'pipe']});
  child.stdout.pipe(log, {end:false}); child.stderr.pipe(log, {end:false});
  const entry = {child, stream, discovery, logFile};
  child.on('error', error => { entry.launchError = String(error); });
  entry.closed = new Promise(resolve => child.once('close', () => log.end(resolve)));
  children.push(entry); return entry;
}
async function shutdown(entry) {
  if (entry.child.exitCode === null) {
    if (!entry.control && fs.existsSync(entry.discovery)) entry.control = JSON.parse(fs.readFileSync(entry.discovery));
    await api(entry.control, '/commands', {command:'quit'});
    await waitFor(() => entry.child.exitCode !== null, 8000, 'Camera shutdown did not finish');
  }
  await entry.closed;
  assert.equal(entry.child.exitCode, 0); assert.equal(entry.child.signalCode, null);
  assert(!fs.existsSync(entry.discovery), 'Discovery survived shutdown');
}
(async () => {
  console.log('Reports: ' + report); save();
  try {
    const env = {...process.env};
    for (const key of Object.keys(env)) if (/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(key) || /^(GH_TOKEN|GITHUB_TOKEN|ACTIONS_.*TOKEN)$/.test(key)) delete env[key];
    env.XDG_STATE_HOME = path.join(report, 'private-state'); env.XDG_CONFIG_HOME = path.join(report, 'private-config'); env.XDG_DATA_HOME = path.join(report, 'private-data');
    env.QT_QPA_PLATFORM = gui && !wayland ? 'xcb' : 'wayland';
    env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1';
    if (gui && !wayland) delete env.WAYLAND_DISPLAY; else env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || 'wayland-0';
    if(wayland){
      keyboardDirectory=fs.mkdtempSync(path.join(require('os').tmpdir(),'gc-wayland-keys-'));fs.chmodSync(keyboardDirectory,0o700);env.GC_QA_KEYBOARD_SOCKET=path.join(keyboardDirectory,'input.sock');
      keyboard=spawn('sudo',['-n','python3',path.join(report,'linux-portal-select.py'),'--keyboard-server='+env.GC_QA_KEYBOARD_SOCKET],{env,stdio:['pipe','pipe','pipe']});keyboard.closed=new Promise(resolve=>keyboard.once('close',resolve));let ready='';keyboard.stdout.on('data',d=>ready+=d);keyboard.stderr.on('data',d=>process.stderr.write(d));
      await waitFor(()=>{assert.equal(keyboard.exitCode,null);return ready.includes('ready');},10000,'Owned keyboard not ready');
      result.portalOwner=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.impl.portal.desktop.gnome'],{env,encoding:'utf8'}).trim();
    }
    const sourceEnv = {...env, WAYLAND_DISPLAY: gui ? opts['source-wayland-socket'] : env.WAYLAND_DISPLAY};
    const browser = opts.browser || '/usr/bin/google-chrome';
    sourceBrowser = await chromium.launch({executablePath:browser, headless:false, env:sourceEnv,
      args:['--ozone-platform=wayland', '--start-fullscreen', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']});
    const source = await sourceBrowser.newPage({viewport:null});
    await source.setContent(`<title>Owned Linux Camera HDMI Fixture</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'); window.fixture={id:0,paused:false};let changed=0;
      // This host's independent HDMI reference has scanout tearing at 60 Hz.
      // Hold identities for 100 ms for this functional workflow; keep the
      // receiver's strict decoding checks. High-motion fidelity remains open.
      function draw(now){canvas.width=innerWidth;canvas.height=innerHeight;if(!fixture.paused&&now-changed>=100){fixture.id=(fixture.id+1)%65536;changed=now;}
        const w=canvas.width,h=canvas.height;ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);
        ctx.fillStyle='red';ctx.fillRect(0,0,.1*w,.15*h);ctx.fillStyle='#00ff00';ctx.fillRect(0,.85*h,.1*w,.15*h);
        ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
        for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
        ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('Physical HDMI source '+fixture.id,20,.9*h);requestAnimationFrame(draw);
      }requestAnimationFrame(draw);</script>`);
    await source.bringToFront();
    const session = await source.context().newCDPSession(source);
    const {windowId} = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {windowId, bounds:{windowState:'fullscreen'}});
    await sleep(1200);
    result.sourceMetrics = await source.evaluate(() => ({innerWidth, innerHeight, outerWidth, outerHeight}));
    await source.screenshot({path:path.join(report, 'source.png')});
    result.browserVersion = sourceBrowser.version();
    if(wayland){
      assert.equal(result.sourceMetrics.innerWidth,800);assert.equal(result.sourceMetrics.innerHeight,600);
      const log=fs.createWriteStream(path.join(report,'virtual-monitor.log'));monitor=spawn('python3',[path.join(report,'linux-virtual-monitor.py'),'--report='+report],{env,stdio:['pipe','pipe','pipe']});monitor.closed=new Promise(resolve=>monitor.once('close',code=>log.end(()=>resolve(code))));let ready='';monitor.stdout.on('data',d=>ready+=d);monitor.stdout.pipe(log,{end:false});monitor.stderr.pipe(log,{end:false});
      await waitFor(()=>{assert.equal(monitor.exitCode,null,'Virtual monitor exited');return ready.includes('"ready": true');},15000,'Virtual monitor not ready');
    }
    viewerBrowser = await chromium.launch({executablePath:browser, headless:true, env, args:['--autoplay-policy=no-user-gesture-required', '--mute-audio']});
    for (let cycle = 0; cycle < 2; ++cycle) {
      const entry = publish('cycle-' + cycle, env), outcome = {cycle, passed:false}; result.cycles.push(outcome); save();
      await waitFor(() => {
        assert.equal(entry.child.exitCode, null, 'Camera publisher exited at startup'); assert(!entry.launchError, entry.launchError);
        return fs.existsSync(entry.discovery);
      }, 15000, 'No control discovery');
      entry.control = JSON.parse(fs.readFileSync(entry.discovery)); assert.equal(entry.control.pid, entry.child.pid);
      const ui=(...args)=>execFileSync('python3',[path.join(report,'linux-ui-control.py'),String(entry.child.pid),...args],{env,encoding:'utf8',timeout:wayland?60000:15000,stdio:['ignore','pipe','pipe']});
      const preview=(label,expected)=>{
        ui('activate');const output=path.join(report,`cycle-${cycle}-preview-${label}.png`);
        return JSON.parse(execFileSync('python3',[path.join(report,'linux-preview-observer.py'),'--pid='+entry.child.pid,'--output='+output,'--expected='+expected],{env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}));
      };
      if(gui){
        await waitFor(()=>{try{return JSON.parse(ui('dump')).some(r=>['Go live','Go live unavailable'].includes(r.name));}catch{return false;}},15000,'GUI not accessible');
        if(wayland){ui('activate');outcome.monitorPlacement=JSON.parse(ui('move-monitor-right'));}
        assert(!(await api(entry.control,'/diagnostics')).app.capturing,'Opening GUI started camera capture');
        let rows=JSON.parse(ui('dump'));
        if(cycle===0){
          ui('press','Show advanced settings');
          if(rows.some(r=>r.role==='combo box'&&r.name==='Window'))ui('choose','Window','Camera / Webcam');
          ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)');
          ui('choose','1280x720','960x540');ui('choose','60','30');
          ui('choose','1920x1080','1280x720');
          rows=JSON.parse(ui('dump'));const audio=rows.find(r=>r.role==='combo box'&&['Selected microphone/input','Selected window/app audio','No audio'].includes(r.name));assert(audio);if(audio.name!=='No audio')ui('choose',audio.name,'No audio');
          rows=JSON.parse(ui('dump'));if(!rows.some(r=>r.role==='combo box'&&r.name==='No microphone'))ui('choose','Linux default microphone/input','No microphone');
        }else{
          for(const name of ['Camera / Webcam','960x540','1280x720','30','No microphone','No audio','Software (x264 / VP9 / AV1 / HEVC)'])assert(rows.some(r=>r.role==='combo box'&&r.name===name),'Camera preference not restored: '+name);
          outcome.settingsRestoredWithoutCapture=true;
        }
        ui('source',opts['camera-label']);ui('text','Stream ID or VDO.Ninja URL',entry.stream);ui('text','Stream password','false');
        outcome.idlePreview=preview('idle','none');assert(outcome.idlePreview.description.includes('Camera opens when streaming starts'));
        if(guiBusyRetry){
          const owner=publish('owner-cycle-'+cycle,env,true);const check={};outcome.busyStartup=check;
          await waitFor(()=>{assert.equal(owner.child.exitCode,null,'Camera owner exited');return fs.existsSync(owner.discovery);},15000,'Camera owner discovery missing');owner.control=JSON.parse(fs.readFileSync(owner.discovery));
          await waitFor(async()=>(await api(owner.control,'/diagnostics')).app.live,15000,'Camera owner did not publish');
          const ownerPage=await receiver(viewerBrowser,owner.stream,owner.child);check.before=await observe(ownerPage,3000);requireMoving(check.before,'Camera owner before GUI attempt');assert.equal(check.before.width,640);assert.equal(check.before.height,360);
          check.ownerBefore=await api(owner.control,'/diagnostics');assert.equal(check.ownerBefore.source.source_id,opts['camera-id']);
          ui('activate');check.startControls=JSON.parse(ui('footer'));assert(check.startControls.goLiveEnabled);ui('press','Go live');
          let message;
          await waitFor(()=>{
            const rows=JSON.parse(ui('dump')),label=rows.find(r=>r.role==='label'&&r.name.includes('Device or resource busy')&&r.name.includes('another app'));
            const go=rows.find(r=>r.role==='push button'&&r.name==='Go live'&&r.states.includes('sensitive'));
            if(label&&go){message=label.name;return true;}return false;
          },15000,'No actionable busy-camera error and retry control');
          check.failed=await api(entry.control,'/diagnostics');assert(!check.failed.app.live&&!check.failed.app.capturing);assert.equal(check.failed.peer_counts.total,0);assert.equal(check.failed.video.frames_captured,0);
          check.visibleError=JSON.parse(ui('footer',message));assert(check.visibleError.goLiveEnabled);
          const screenshot=path.join(report,`cycle-${cycle}-busy-error.png`);
          if(wayland)execFileSync('gnome-screenshot',['-w','-f',screenshot],{env,timeout:10000});
          else execFileSync('python3',['-c','from PIL import ImageGrab;import sys;x,y,w,h=map(int,sys.argv[1:5]);ImageGrab.grab().crop((x,y,x+w,y+h)).save(sys.argv[5])',...check.visibleError.frame.map(String),screenshot],{env,timeout:10000});
          check.screenshot={file:path.basename(screenshot),sha256:sha(screenshot)};
          check.failedPreview=preview('busy-failed','none');check.after=await observe(ownerPage,3000);requireMoving(check.after,'Camera owner after failed GUI attempt');
          check.ownerAfter=await api(owner.control,'/diagnostics');assert(check.ownerAfter.app.live&&check.ownerAfter.app.capturing);assert(check.ownerAfter.video.frames_sent>check.ownerBefore.video.frames_sent);
          await ownerPage.close();await shutdown(owner);check.ownerExitCode=owner.child.exitCode;check.released=true;save();
          ui('activate');assert(JSON.parse(ui('footer')).goLiveEnabled);
        }
        ui('press','Go live');await waitFor(async()=>(await api(entry.control,'/diagnostics')).app.live,15000,'Camera GUI did not publish');
      }
      const page = await receiver(viewerBrowser, entry.stream, entry.child);
      outcome.moving = await observe(page, 6000); outcome.distinct = requireMoving(outcome.moving, 'Physical HDMI camera');
      assert.equal(outcome.moving.width, gui?1280:640); assert.equal(outcome.moving.height, gui?720:360);
      await page.screenshot({path:path.join(report, 'cycle-' + cycle + '-receiver.png')});
      const diagnostics = await api(entry.control, '/diagnostics');
      assert.equal(diagnostics.source.source_id, opts['camera-id']); assert.equal(diagnostics.source.mode, 'camera');
      assert.equal(diagnostics.video.hardware_encoder, false); assert.equal(diagnostics.video.active_encoder, 'libx264');
      outcome.counters = {captured:diagnostics.video.frames_captured, sent:diagnostics.video.frames_sent, failures:diagnostics.video.encode_failures, timeouts:diagnostics.video.encode_timeouts};
      const pausedId = await source.evaluate(() => { fixture.paused = true; return fixture.id; }); await sleep(1000);
      outcome.static = await observe(page, 2500);
      assert.equal(outcome.static.identityReadFailures, 0); assert(!outcome.static.observerError);
      assert(outcome.static.observations.length >= 10); assert.deepEqual([...new Set(outcome.static.observations.map(frame => frame.id))], [pausedId]);
      if(gui)outcome.livePreview=preview('live',pausedId);
      outcome.colors = await page.evaluate(() => {
        const video = [...document.querySelectorAll('video')].find(v => v.videoWidth && !v.paused);
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
        return [.05, .95].map(y => [...context.getImageData(Math.floor(canvas.width * .05), Math.floor(canvas.height * y), 1, 1).data]);
      });
      assert(outcome.colors[0][0] > 170 && outcome.colors[0][1] < 70 && outcome.colors[1][1] > 170 && outcome.colors[1][0] < 70, 'Camera color/orientation mismatch');
      await source.evaluate(() => { fixture.paused = false; });
      if (cycle === 0) {
        const busy = publish('busy', env, true);
        await waitFor(() => busy.child.exitCode !== null, 15000, 'Busy camera attempt did not finish'); await busy.closed;
        assert.equal(busy.child.exitCode, 3); assert(!fs.existsSync(busy.discovery));
        const busyLog = fs.readFileSync(busy.logFile, 'utf8');
        assert(/Device or resource busy/.test(busyLog), 'No actionable busy-device error');
        outcome.busyError = 'Device or resource busy';
        outcome.afterBusy = await observe(page, 3000); requireMoving(outcome.afterBusy, 'Original camera after competing open');
      }
      const late = await receiver(viewerBrowser, entry.stream, entry.child);
      outcome.late = await observe(late, 3000); requireMoving(outcome.late, 'Late camera viewer');
      await late.close(); await page.close();
      if(gui){
        ui('press','Stop streaming');await waitFor(async()=>{const d=await api(entry.control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'GUI Stop did not release camera');
        outcome.stoppedPreview=preview('stopped','none');
        const before=await api(entry.control,'/diagnostics');await sleep(500);assert.equal(before.video.frames_captured,(await api(entry.control,'/diagnostics')).video.frames_captured);
        ui('press','Go live');await waitFor(async()=>(await api(entry.control,'/diagnostics')).app.live,15000,'Camera GUI did not restart');
        const restarted=await receiver(viewerBrowser,entry.stream,entry.child);outcome.restarted=await observe(restarted,4000);requireMoving(outcome.restarted,'Camera GUI restarted');
        const id=await source.evaluate(()=>{fixture.paused=true;return fixture.id;});await sleep(1000);outcome.restartedPreview=preview('restarted',id);await source.evaluate(()=>fixture.paused=false);
        await restarted.close();ui('press','Stop streaming');await waitFor(async()=>!(await api(entry.control,'/diagnostics')).app.capturing,10000,'Second Stop did not release camera');
      }
      await shutdown(entry);
      outcome.exitCode = entry.child.exitCode; outcome.passed = true; save();
    }
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    for (const entry of children) if (entry.child.exitCode === null) {
      try { await shutdown(entry); } catch { entry.child.kill(); await entry.closed; }
    }
    const cleanupErrors=[];
    for(const cleanup of [
      async()=>{if(sourceBrowser)await sourceBrowser.close();},
      async()=>{if(viewerBrowser)await viewerBrowser.close();},
      async()=>{if(keyboard){keyboard.stdin.end();await waitFor(()=>keyboard.exitCode!==null,10000,'Owned keyboard did not retire');await keyboard.closed;assert.equal(keyboard.exitCode,0);}if(keyboardDirectory)fs.rmdirSync(keyboardDirectory);},
      async()=>{if(monitor){monitor.stdin.end();await waitFor(()=>monitor.exitCode!==null,12000,'Virtual monitor did not retire');assert.equal(await monitor.closed,0);result.virtualMonitor=JSON.parse(fs.readFileSync(path.join(report,'virtual-monitor.json')));assert(result.virtualMonitor.passed);}},
      async()=>{if(wayland){const owner=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.impl.portal.desktop.gnome'],{encoding:'utf8'}).trim();assert.equal(owner,result.portalOwner);result.portalSurvived=true;}}
    ])try{await cleanup();}catch(error){cleanupErrors.push(String(error.stack||error));}
    if(cleanupErrors.length){result.cleanupErrors=cleanupErrors;result.passed=false;process.exitCode=1;}
    save(); console.log(JSON.stringify({report, passed:result.passed, error:result.error}));
  }
})();
