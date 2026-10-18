'use strict';
// Physical HDMI loopback only: display -> selected V4L2 device -> packaged app
// -> hosted VDO.Ninja -> browser. Requires this host's display wired to the camera.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const assert = require('assert/strict'), {spawn} = require('child_process');
const {chromium} = require('playwright');
const {receiver, observe, requireMoving, waitFor, sleep} = require('./macos-media-receiver');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)];
}));
assert.equal(process.platform, 'linux');
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
const report = path.resolve(opts.reports, crypto.randomUUID()); fs.mkdirSync(report, {recursive:true});
for (const name of ['linux-camera-publish.js', 'macos-media-receiver.js']) fs.copyFileSync(path.join(__dirname, name), path.join(report, name));
const result = {
  scope:'Extracted Ubuntu DEB, physical V4L2 HDMI loopback with 10 Hz source identities and 30 fps software H264; excludes audio, MJPEG, other devices, disconnection, high-motion fidelity, endurance and release qualification',
  executableSha256:sha(exe), manifestSha256:sha(manifestFile), harnessSha256:sha(__filename),
  receiverHarnessSha256:sha(path.join(__dirname, 'macos-media-receiver.js')),
  cameraId:opts['camera-id'], requested:{codec:'h264', encoder:'software', width:640, height:360, fps:30, audio:'none'},
  cycles:[], passed:false
};
const save = () => fs.writeFileSync(path.join(report, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const children = []; let sourceBrowser, viewerBrowser;
async function api(control, route, body) {
  const response = await fetch(control.base_url + route, {
    method:body ? 'POST' : 'GET', headers:{Authorization:'Bearer ' + control.token, 'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(5000)
  });
  assert(response.ok, 'Control HTTP ' + response.status); return response.json();
}
function publish(name, env) {
  const stream = 'gclinuxcam' + crypto.randomBytes(14).toString('hex');
  const discovery = path.join(report, name + '-private-control.json');
  const logFile = path.join(report, name + '-private-publisher.log');
  const log = fs.createWriteStream(logFile);
  const child = spawn(exe, ['--headless', '--source=camera', '--camera-id=' + opts['camera-id'],
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
    env.QT_QPA_PLATFORM = 'wayland'; env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || 'wayland-0';
    const browser = opts.browser || '/usr/bin/google-chrome';
    sourceBrowser = await chromium.launch({executablePath:browser, headless:false, env,
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
    viewerBrowser = await chromium.launch({executablePath:browser, headless:true, env, args:['--autoplay-policy=no-user-gesture-required', '--mute-audio']});
    for (let cycle = 0; cycle < 2; ++cycle) {
      const entry = publish('cycle-' + cycle, env), outcome = {cycle, passed:false}; result.cycles.push(outcome); save();
      await waitFor(() => {
        assert.equal(entry.child.exitCode, null, 'Camera publisher exited at startup'); assert(!entry.launchError, entry.launchError);
        return fs.existsSync(entry.discovery);
      }, 15000, 'No control discovery');
      entry.control = JSON.parse(fs.readFileSync(entry.discovery)); assert.equal(entry.control.pid, entry.child.pid);
      const page = await receiver(viewerBrowser, entry.stream, entry.child);
      outcome.moving = await observe(page, 6000); outcome.distinct = requireMoving(outcome.moving, 'Physical HDMI camera');
      assert.equal(outcome.moving.width, 640); assert.equal(outcome.moving.height, 360);
      await page.screenshot({path:path.join(report, 'cycle-' + cycle + '-receiver.png')});
      const diagnostics = await api(entry.control, '/diagnostics');
      assert.equal(diagnostics.source.source_id, opts['camera-id']); assert.equal(diagnostics.source.mode, 'camera');
      assert.equal(diagnostics.video.hardware_encoder, false); assert.equal(diagnostics.video.active_encoder, 'libx264');
      outcome.counters = {captured:diagnostics.video.frames_captured, sent:diagnostics.video.frames_sent, failures:diagnostics.video.encode_failures, timeouts:diagnostics.video.encode_timeouts};
      const pausedId = await source.evaluate(() => { fixture.paused = true; return fixture.id; }); await sleep(1000);
      outcome.static = await observe(page, 2500);
      assert.equal(outcome.static.identityReadFailures, 0); assert(!outcome.static.observerError);
      assert(outcome.static.observations.length >= 10); assert.deepEqual([...new Set(outcome.static.observations.map(frame => frame.id))], [pausedId]);
      outcome.colors = await page.evaluate(() => {
        const video = [...document.querySelectorAll('video')].find(v => v.videoWidth && !v.paused);
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
        return [.05, .95].map(y => [...context.getImageData(Math.floor(canvas.width * .05), Math.floor(canvas.height * y), 1, 1).data]);
      });
      assert(outcome.colors[0][0] > 170 && outcome.colors[0][1] < 70 && outcome.colors[1][1] > 170 && outcome.colors[1][0] < 70, 'Camera color/orientation mismatch');
      await source.evaluate(() => { fixture.paused = false; });
      if (cycle === 0) {
        const busy = publish('busy', env);
        await waitFor(() => busy.child.exitCode !== null, 15000, 'Busy camera attempt did not finish'); await busy.closed;
        assert.equal(busy.child.exitCode, 3); assert(!fs.existsSync(busy.discovery));
        const busyLog = fs.readFileSync(busy.logFile, 'utf8');
        assert(/Device or resource busy/.test(busyLog), 'No actionable busy-device error');
        outcome.busyError = 'Device or resource busy';
        outcome.afterBusy = await observe(page, 3000); requireMoving(outcome.afterBusy, 'Original camera after competing open');
      }
      const late = await receiver(viewerBrowser, entry.stream, entry.child);
      outcome.late = await observe(late, 3000); requireMoving(outcome.late, 'Late camera viewer');
      await late.close(); await page.close(); await shutdown(entry);
      outcome.exitCode = entry.child.exitCode; outcome.passed = true; save();
    }
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    for (const entry of children) if (entry.child.exitCode === null) {
      try { await shutdown(entry); } catch { entry.child.kill(); await entry.closed; }
    }
    if (sourceBrowser) await sourceBrowser.close(); if (viewerBrowser) await viewerBrowser.close();
    save(); console.log(JSON.stringify({report, passed:result.passed, error:result.error}));
  }
})();
