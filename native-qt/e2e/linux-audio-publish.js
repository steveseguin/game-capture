'use strict';
// Packaged X11/Wayland video + real PipeWire/Pulse routes -> hosted browser decoding.
// Owned virtual input qualifies routing, not a physical microphone or A/V drift.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const assert = require('assert/strict'), {spawn, execFileSync} = require('child_process');
const {chromium} = require('playwright');
const {receiver, observe, requireMoving, observeAudio, waitFor, sleep} = require('./macos-media-receiver');
const {receive} = require('./audio-settings-packaged-e2e');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)];
}));
assert.equal(process.platform, 'linux');
const matrix = opts.matrix || 'routes';
const wayland = opts.backend === 'wayland', automaticApp = matrix === 'apps-auto';
const communications = matrix === 'communications-gui' || matrix === 'communications-cli';
const communicationsMix = opts['communications-mix'] === 'true';
const audioWarnings = opts['audio-warnings'] === 'true';
assert(opts['combined-audio-loss'] !== 'true' || (communications && communicationsMix), 'Combined loss requires communications mixing');
const gui = matrix === 'gui' || matrix === 'apps-gui' || matrix === 'communications-gui', apps = automaticApp || matrix === 'apps' || matrix === 'apps-gui'; assert(['routes', 'codecs', 'gui', 'apps', 'apps-gui', 'apps-auto', 'communications-gui', 'communications-cli'].includes(matrix));
const continuousApps=opts['continuous-app-audio']==='true';
assert(!continuousApps||(matrix==='apps'&&!wayland),'Continuous app diagnostic currently requires explicit X11 CLI apps');
const appOutputMoves=Number(opts['app-output-moves']||1);
assert(Number.isInteger(appOutputMoves)&&appOutputMoves>=1&&appOutputMoves<=5,'App output moves must be 1..5');
assert(appOutputMoves===1||continuousApps,'Repeated output moves require the continuous app diagnostic');
const continuity=continuousApps?require('./linux-app-audio-continuity'):null;
assert(!wayland || gui || (apps && !automaticApp), 'Wayland qualification supports GUI routes/apps and explicit CLI app selection');
for (const key of ['publisher', 'reports', 'manifest-sha256']) assert(opts[key], key);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exe = path.resolve(opts.publisher), bundle = path.resolve(path.dirname(exe), '../..');
const manifestFile = path.join(bundle, 'release-artifact-manifest.json');
assert.equal(sha(manifestFile), opts['manifest-sha256']);
const manifest = JSON.parse(fs.readFileSync(manifestFile));
assert.equal(manifest.artifact.sha256, sha(exe)); assert.equal(manifest.payload.fileCount, manifest.payload.files.length);
for (const item of manifest.payload.files) {
  const file = path.resolve(bundle, item.relativePath); assert(file.startsWith(bundle + path.sep));
  assert.equal(fs.statSync(file).size, item.size); assert.equal(sha(file), item.sha256);
}
const report = path.resolve(opts.reports, crypto.randomUUID()); fs.mkdirSync(report, {recursive:true});
for (const name of ['linux-audio-publish.js', 'macos-media-receiver.js', 'audio-settings-packaged-e2e.js', 'linux-ui-control.py', 'linux-app-audio-source.py', 'linux-portal-select.py']) fs.copyFileSync(path.join(__dirname, name), path.join(report, name));
if(continuousApps)for(const name of ['linux-app-audio-continuity.js','macos-continuous-audio.js','linux-audio-timing-report.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const result = {scope:`Extracted Ubuntu DEB; bounded ${wayland ? 'Wayland portal' : 'X11'} H264 and audio via ${apps ? 'selected application playback' : (communications ? 'explicit communications output and owned virtual microphone' : 'default system output and owned virtual microphone')}; ${matrix} workflow. Physical microphones, native PipeWire/JACK app streams, endurance and A/V drift excluded.`,
  executableSha256:sha(exe), manifestSha256:sha(manifestFile), harnessSha256:sha(__filename),
  receiverHarnessSha256:sha(path.join(__dirname, 'macos-media-receiver.js')),
  codecReceiverSha256:sha(path.join(__dirname, 'audio-settings-packaged-e2e.js')),
  guiHelperSha256:sha(path.join(__dirname, 'linux-ui-control.py')),
  portalHelperSha256:sha(path.join(__dirname, 'linux-portal-select.py')),
  appFixtureSha256:sha(path.join(__dirname, 'linux-app-audio-source.py')), matrix, backend:wayland ? 'wayland' : 'x11', requestedCase:opts.case || 'all', cases:[], passed:false};
if(continuousApps){result.traceAudio=true;result.diagnosticOnly=true;result.appOutputMoves=appOutputMoves;result.continuousHarnesses=Object.fromEntries(['linux-app-audio-continuity.js','macos-continuous-audio.js','linux-audio-timing-report.py'].map(n=>[n,sha(path.join(report,n))]));}
const save = () => fs.writeFileSync(path.join(report, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const pactl = (...args) => execFileSync('pactl', args, {encoding:'utf8', timeout:5000}).trim();
const modules = [], tones = []; let sourceBrowser, viewerBrowser, publisher, log, control, discovery, appSource, portalSelector, keyboardServer, keyboardDirectory, portalOwner;
let continuousPage=null;
const startedAtSeconds = Math.floor(Date.now() / 1000);
const checkPortalOwner = () => {
  const owner = execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetNameOwner', 'org.freedesktop.impl.portal.desktop.gnome'], {encoding:'utf8', timeout:5000, stdio:['ignore', 'pipe', 'pipe']}).trim();
  if (portalOwner) assert.equal(owner, portalOwner, 'GNOME portal restarted during audio workflow');
  else { portalOwner = owner; result.portalBackend = {name:'org.freedesktop.impl.portal.desktop.gnome', owner}; }
};
async function api(route, body) {
  const response = await fetch(control.base_url + route, {method:body ? 'POST' : 'GET',
    headers:{Authorization:'Bearer ' + control.token, 'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(5000)});
  assert(response.ok); return response.json();
}
function tone(device, label) {
  const child = spawn('paplay', ['--raw', '--format=float32le', '--rate=48000', '--channels=2', '--latency-msec=20',
    '--device=' + device, '--property=application.name=Game Capture owned audio QA', '--property=media.name=' + label], {stdio:['pipe', 'ignore', 'pipe']});
  child.closed = new Promise(resolve => child.once('close', resolve));
  const state = {child, frequencies:[440, 880], silent:false, frames:0, blocked:false, error:null};
  child.on('error', e => { state.error = String(e); }); child.stderr.on('data', data => { state.error = String(data); });
  child.stdin.on('error', e => { state.error = String(e); }); child.stdin.on('drain', () => { state.blocked = false; });
  state.timer = setInterval(() => {
    if (state.blocked || child.exitCode !== null) return;
    const block = Buffer.alloc(960 * 2 * 4);
    for (let frame = 0; frame < 960; ++frame) for (let channel = 0; channel < 2; ++channel)
      block.writeFloatLE(state.silent ? 0 : .15 * Math.sin(2 * Math.PI * state.frequencies[channel] * (state.frames + frame) / 48000), (frame * 2 + channel) * 4);
    state.frames += 960; state.blocked = !child.stdin.write(block);
  }, 20);
  tones.push(state); return state;
}
async function startApp(device) {
  const child = spawn('python3', [path.join(__dirname, 'linux-app-audio-source.py'), '--device', device], {detached:true, stdio:['pipe', 'pipe', 'pipe']});
  const lines = [], state = {child, errors:'', ready:false, serial:0}; let buffer = '';
  child.stdout.on('data', data => { buffer += data; while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); const line = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (line.ready) state.ready = true; else lines.push(line); } });
  child.stderr.on('data', data => { state.errors += data; });
  state.closed = new Promise(resolve => child.once('close', resolve));
  state.stop = async () => {
    child.stdin.end();
    try { await waitFor(() => child.exitCode !== null, 8000, 'Owned app fixture did not stop'); }
    catch (error) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await state.closed; throw error; }
    await state.closed; assert.equal(child.exitCode, 0, state.errors);
  };

  state.command = async command => {
    const id = ++state.serial; child.stdin.write(JSON.stringify({...command, id}) + '\n');
    await waitFor(() => { assert.equal(child.exitCode, null, state.errors); return lines.some(line => line.id === id); }, 6000, 'App fixture command failed');
    return lines.find(line => line.id === id);
  };
  await waitFor(() => { assert.equal(child.exitCode, null, state.errors); return state.ready; }, 6000, 'App fixture not ready');
  return state;
}
function requireAudio(observation, label, {silent=false, microphone=false, excluded=false, microphoneOff=false}={}) {
  assert(observation.tracks.some(track => /audio\/opus/i.test(track.codec) && track.packetsReceived > 20), label + ': no decoded Opus');
  const good = observation.spectra.filter(sample => silent ? sample.rms < .0005 :
    sample.rms > .005 && sample.channels[0].tone440 > -55 && sample.channels[1].tone880 > -55 &&
    sample.channels[0].tone440 > sample.channels[0].tone880 + 20 && sample.channels[1].tone880 > sample.channels[1].tone440 + 20 &&
    (!microphone || sample.microphone1200 > -55) && (!microphoneOff || sample.microphone1200 < Math.min(sample.tone440, sample.tone880) - 25) &&
    (!excluded || sample.excluded2000 < Math.min(sample.tone440, sample.tone880) - 30));
  assert(good.length >= 25, label + ': decoded stereo tone/silence/routing differs from the fixture (' + good.length + '/30)');
}
async function quit() {
  if (publisher && publisher.exitCode === null) {
    await api('/commands', {command:'quit'}); await waitFor(() => publisher.exitCode !== null, 8000, 'Publisher did not stop');
  }
  if (publisher) { await publisher.closed; assert.equal(publisher.exitCode, 0); assert.equal(publisher.signalCode, null); }
  if (discovery) assert(!fs.existsSync(discovery), 'Discovery survived shutdown');
  if (log) { await new Promise(resolve => log.end(resolve)); log = null; }
  if (gui) {
    const nativeLog = path.join(report, 'private-state/GameCapture/logs/game-capture-debug.log');
    if (fs.existsSync(nativeLog)) fs.copyFileSync(nativeLog, discovery.replace('-private-control.json', '-private-native.log'));
  }
  publisher = null;
}
function barriers() {
  const states = new Map();
  return label => {
    if (!states.has(label)) { let resolve; const promise = new Promise(done => { resolve = done; }); states.set(label, {count:0, promise, resolve}); }
    const state = states.get(label); if (++state.count === 2) state.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Receiver barrier timed out: ' + label)), 30000);
      state.promise.then(() => { clearTimeout(timer); resolve(); });
    });
  };
}
(async () => {
  console.log('Reports: ' + report); save();
  try {
    const env = {...process.env};
    for (const key of Object.keys(env)) if (/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(key) || /^(GH_TOKEN|GITHUB_TOKEN|ACTIONS_.*TOKEN)$/.test(key)) delete env[key];
    env.XDG_STATE_HOME = path.join(report, 'private-state'); env.XDG_CONFIG_HOME = path.join(report, 'private-config'); env.XDG_DATA_HOME = path.join(report, 'private-data');
    if(continuousApps){env.VERSUS_LINUX_AUDIO_TRACE=path.join(report,'linux-audio-timing.csv');result.audioTrace={path:'linux-audio-timing.csv',scope:'One selected-app lifecycle capture; opt-in timing metadata, no PCM in native trace.'};}
    if (wayland) { env.XDG_SESSION_TYPE = 'wayland'; env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || 'wayland-0'; env.QT_QPA_PLATFORM = 'wayland'; }
    else { env.XDG_SESSION_TYPE = 'x11'; delete env.WAYLAND_DISPLAY; env.QT_QPA_PLATFORM = 'xcb'; }
    if (gui) env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON = '1';
    if (gui && wayland) {
      keyboardDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wayland-keys-')); fs.chmodSync(keyboardDirectory, 0o700);
      env.GC_QA_KEYBOARD_SOCKET = path.join(keyboardDirectory, 'input.sock');
      keyboardServer = spawn('sudo', ['-n', 'python3', path.join(__dirname, 'linux-portal-select.py'), '--keyboard-server=' + env.GC_QA_KEYBOARD_SOCKET], {env, stdio:['pipe', 'pipe', 'pipe']});
      keyboardServer.closed = new Promise(resolve => keyboardServer.once('close', resolve));
      let ready = ''; keyboardServer.stdout.on('data', data => ready += data); keyboardServer.stderr.on('data', data => process.stderr.write(data));
      await waitFor(() => { assert.equal(keyboardServer.exitCode, null, 'Owned keyboard exited'); return ready.includes('ready'); }, 10000, 'Owned keyboard not ready');
    }
    const suffix = crypto.randomBytes(6).toString('hex'), sinkName = 'gc_qa_' + suffix, sourceName = sinkName + '_input';
    const defaultSink = pactl('get-default-sink'); result.defaultSink = defaultSink;
    modules.push(pactl('load-module', 'module-null-sink', 'sink_name=' + sinkName, 'rate=48000', 'channels=2'));
    const createInput = () => {
      const id = pactl('load-module', 'module-remap-source', 'master=' + sinkName + '.monitor', 'source_name=' + sourceName, 'source_properties=device.description=GameCaptureOwnedQAInput');
      modules.push(id); return id;
    };
    let inputModule = createInput();
    const communicationsSink = sinkName + '_communications';
    const createCommunicationsOutput = () => {
      const id = pactl('load-module', 'module-null-sink', 'sink_name=' + communicationsSink, 'sink_properties=device.description=GameCaptureOwnedQACommunications', 'rate=48000', 'channels=2');
      modules.push(id); return id;
    };
    let communicationsModule, communicationsTone, lostMicrophoneDuringOutputLoss = false;
    if (communications) { communicationsModule = createCommunicationsOutput(); communicationsTone = tone(communicationsSink, 'owned communications'); }
    const requireCommunicationsLoss = observation => {
      if (!communicationsMix || lostMicrophoneDuringOutputLoss) requireAudio(observation, 'Removed communications output', {silent:true});
      else assert(observation.spectra.filter(sample => sample.microphone1200 > -55 && sample.tone440 < sample.microphone1200 - 25 && sample.tone880 < sample.microphone1200 - 25 && sample.excluded2000 < sample.microphone1200 - 25).length >= 25, 'Output loss did not leave only the selected microphone');
    };
    const systemTone = tone(defaultSink, 'owned system'), inputTone = tone(sinkName, 'owned microphone');
    const browser = opts.browser || '/usr/bin/google-chrome';
    sourceBrowser = await chromium.launch({executablePath:browser, headless:false, env, args:[...(wayland ? ['--ozone-platform=wayland', '--window-position=10,10', '--window-size=720,560'] : []), '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']});
    const source = await sourceBrowser.newPage(wayland ? {viewport:null} : {viewport:{width:800, height:450}}), title = 'Owned Linux Capture ' + suffix;
    await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
      const canvas=document.querySelector('canvas'),c=canvas.getContext('2d');let id=0;
      function draw(){canvas.width=innerWidth;canvas.height=innerHeight;const w=canvas.width,h=canvas.height;id=(id+1)%65536;c.fillStyle='#183042';c.fillRect(0,0,w,h);c.fillStyle='cyan';c.fillRect(.1*w,.25*h,.05*w,.5*h);c.fillStyle='magenta';c.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){c.fillStyle=(id>>i)&1?'white':'black';c.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}requestAnimationFrame(draw);}draw();</script>`);
    await source.bringToFront();
    if (automaticApp) await source.evaluate(async () => {
      window.audioFixture = new AudioContext({sampleRate:48000});
      const merge = audioFixture.createChannelMerger(2); merge.connect(audioFixture.destination);
      for (const [channel, frequency] of [440, 880].entries()) {
        const oscillator = audioFixture.createOscillator(), gain = audioFixture.createGain();
        oscillator.frequency.value = frequency; gain.gain.value = .15;
        oscillator.connect(gain); gain.connect(merge, 0, channel); oscillator.start();
      }
      await audioFixture.resume();
    });

    viewerBrowser = await chromium.launch({executablePath:browser, headless:true, env, args:['--autoplay-policy=no-user-gesture-required', '--mute-audio']});
    const cases = communications ? [{name:'communications', mode:'communications-output', input:communicationsMix, mix:communicationsMix}] : apps ? [{name:'selected-app', mode:'selected-window'}] : matrix === 'codecs' ? ['opus', 'pcm', 'red'].flatMap(codec => [1, 2].map(channels => ({
      name:codec + '-' + channels, mode:'default-output', codec:codec === 'pcm' ? 'pcm' : 'opus', red:codec === 'red', channels, bitrate:128
    }))) : [
      {name:'system', mode:'default-output'},
      {name:'microphone', mode:'default-microphone', input:true},
      {name:'mix', mode:'default-output', input:true, mix:true}
    ];
    assert(!opts.case || cases.some(fixture => fixture.name === opts.case), 'Unknown requested case');
    for (const fixture of cases.filter(fixture => !opts.case || fixture.name === opts.case)) {
      const entry = {name:fixture.name, passed:false}; result.cases.push(entry); save();
      systemTone.frequencies = fixture.name === 'microphone' ? [2000, 2000] : [440, 880];
      inputTone.frequencies = fixture.name === 'microphone' ? [440, 880] : [1200, 1200];
      systemTone.silent = inputTone.silent = false;
      if (communications) systemTone.frequencies = [2000, 2000];
      if (apps) {
        systemTone.frequencies = inputTone.frequencies = [2000, 2000];
        if (!automaticApp) appSource = await startApp(defaultSink);
      }
      const stream = 'gclinuxaudio' + crypto.randomBytes(12).toString('hex');
      const remoteToken = crypto.randomBytes(24).toString('hex');
      discovery = path.join(report, fixture.name + '-private-control.json');
      const args = [gui ? '--settings-dir=' + path.join(report, fixture.name + '-private-settings') : '--headless', '--source=window', '--window=' + (wayland ? 'Choose a window' : title), '--stream=' + stream, '--password=false',
        '--video-encoder=software', '--video-codec=h264', '--resolution=640x360', '--fps=30', '--bitrate-kbps=2000',
        '--audio-source=' + fixture.mode, fixture.red ? '--audio-red' : '--no-audio-red',
        '--audio-codec=' + (fixture.codec || 'opus'), '--audio-channels=' + (fixture.channels || 2),
        '--audio-bitrate-kbps=' + (fixture.bitrate || 128), '--duration-ms=180000', '--local-control', '--local-control-port=0', '--local-control-discovery=' + discovery];
      if (matrix === 'codecs') args.push('--remote-control', '--remote-token=' + remoteToken);
      if (apps && !automaticApp) args.push('--audio-process=' + appSource.child.pid);
      if (communications) args.push('--communications-output-device=pulse-output:' + communicationsSink);
      if (fixture.input) args.push('--microphone-device=pulse:' + sourceName);
      if (fixture.mix) args.push('--include-microphone');
      log = fs.createWriteStream(path.join(report, fixture.name + '-private-publisher.log'));
      publisher = spawn(exe, args, {cwd:bundle, env, stdio:['ignore', 'pipe', 'pipe']});
      publisher.stdout.pipe(log, {end:false}); publisher.stderr.pipe(log, {end:false});
      let selectionNumber = 0;
      const selectPortal = () => {
        const output = path.join(report, fixture.name + '-portal-' + (++selectionNumber) + '.json');
        portalSelector = spawn('python3', [path.join(__dirname, 'linux-portal-select.py'), '--title=' + title, '--output=' + output], {env, stdio:['ignore', 'pipe', 'pipe']});
        portalSelector.output = output;
        portalSelector.stdout.pipe(log, {end:false}); portalSelector.stderr.pipe(log, {end:false});
      };
      const selectedPortal = async () => {
        await waitFor(() => portalSelector.exitCode !== null, 10000, 'Portal selection did not finish');
        assert.equal(portalSelector.exitCode, 0); assert(JSON.parse(fs.readFileSync(portalSelector.output)).passed); checkPortalOwner();
      };
      if (wayland && !gui) selectPortal();

      publisher.closed = new Promise(resolve => publisher.once('close', resolve));
      publisher.on('error', error => { entry.launchError = String(error); });
      await waitFor(() => { assert.equal(publisher.exitCode, null, 'Publisher exited at startup'); assert(!entry.launchError); return fs.existsSync(discovery); }, 15000, 'No control discovery');
      control = JSON.parse(fs.readFileSync(discovery)); assert.equal(control.pid, publisher.pid);
      if (wayland && !gui) await waitFor(() => { assert.equal(publisher.exitCode, null); return fs.readFileSync(path.join(report, fixture.name + '-private-publisher.log'), 'utf8').includes('[Headless] Going live'); }, 75000, 'Portal selection/startup did not finish');
      const ui = (...arguments_) => execFileSync('python3', [path.join(__dirname, 'linux-ui-control.py'), String(publisher.pid), ...arguments_], {env, encoding:'utf8', timeout:wayland ? 60000 : 10000, stdio:['ignore', 'pipe', 'pipe']});
      const checkAudioWarning = async (pattern, label) => {
        if (!audioWarnings) return;
        await waitFor(async () => {
          const warning = (await api('/diagnostics')).audio.capture_warning;
          assert.equal(typeof warning, 'string', 'Missing structured audio warning');
          const visible = JSON.parse(ui('dump')).filter(row => row.role === 'label' && row.states.includes('visible') && row.name.startsWith('Audio: '));
          return pattern ? pattern.test(warning) && visible.some(row => pattern.test(row.name)) : warning === '' && visible.length === 0;
        }, 6000, 'Audio warning state/visible notice differs: ' + label);
        entry[label] = true;
      };
      const goLive = async () => {
        if (wayland) selectPortal();
        ui('press', 'Go live');
        await waitFor(async () => (await api('/diagnostics')).app.live, wayland ? 30000 : 15000, 'GUI did not go live');
        if (wayland) await selectedPortal();
      };
      if (gui) {
        ui('press', 'Show advanced settings');
        ui('choose', 'Auto (Hardware, then Software)', 'Software (x264 / VP9 / AV1 / HEVC)');
        ui('choose', '1280x720', '960x540'); ui('choose', '60', '30');
        ui('source', wayland ? 'Choose a window' : title); ui('text', 'Stream ID or VDO.Ninja URL', stream); ui('text', 'Stream password', 'false');
        if (fixture.input) ui('choose-prefix', 'No microphone', 'GameCaptureOwnedQAInput');
        const audioMode = JSON.parse(ui('dump')).find(row => row.role === 'combo box' && ['No audio', 'Selected window/app audio'].includes(row.name))?.name;
        assert(audioMode, 'Initial audio choice missing');
        ui('choose', audioMode, communications ? 'Communications output (selected device)' : apps ? 'Selected window/app audio' : fixture.mode === 'default-output' ? 'System audio (all apps)' : 'Selected microphone/input');
        if (communications) {
          ui('press', 'Go live');
          const missing = await api('/diagnostics'); assert(!missing.app.capturing && !missing.app.live); assert.equal(missing.video.frames_captured, 0);
          assert(JSON.parse(ui('dump')).some(row => row.name === 'Choose a communications output before streaming'));
          entry.missingOutputBlockedBeforeCapture = true;
          ui('choose', 'Choose a communications output', 'GameCaptureOwnedQACommunications');
        }
        if (apps) ui('choose', wayland ? 'Choose an audio app' : 'Selected X11 window (automatic)', 'GameCaptureOwnedQAApp (PID ' + appSource.child.pid + ')');
        ui('press', 'Audio encoding');
        // The shared UI defaults to RED. Select plain Opus for the route/mute
        // workflow; the separate codec matrix exercises both RED receivers.
        const controls = JSON.parse(ui('dump'));
        if (controls.find(row => row.name === 'Packet-loss protection (RED, experimental)').states.includes('checked')) ui('press', 'Packet-loss protection (RED, experimental)');
        if (fixture.mix) { ui('value', 'Game Audio Gain', '50'); ui('value', 'Mic Gain', '50'); }
        const beforeLive = ui('dump');
        const communicationsLabel = JSON.parse(beforeLive).find(row => row.role === 'label' && row.name === 'Communications device' && row.states.includes('visible'));
        assert.equal(!!communicationsLabel, communications, 'Communications device row visibility differs from the selected audio mode');
        fs.writeFileSync(path.join(report, fixture.name + '-ui-before-live.json'), beforeLive);
        await goLive();
      }
      if (wayland && !gui) await selectedPortal();
      if (matrix === 'codecs') {
        const directory = path.join(report, fixture.name); fs.mkdirSync(directory);
        const logFile = path.join(report, fixture.name + '-private-publisher.log');
        let viewerUrl;
        await waitFor(() => {
          assert.equal(publisher.exitCode, null);
          viewerUrl = fs.readFileSync(logFile, 'utf8').match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1]; return !!viewerUrl;
        }, 15000, 'Generated viewer link missing');
        const settings = {codec:fixture.codec, red:fixture.red, channels:fixture.channels, bitrate:fixture.bitrate, stream, viewerUrl};
        const concurrent = fixture.red || fixture.codec === 'pcm', sync = concurrent ? barriers() : undefined;
        const requests = (concurrent ? [false, true] : [false]).map(fallback => {
          const target = path.join(directory, fallback ? 'fallback' : 'preferred'); fs.mkdirSync(target);
          return {settings:{...settings, fallback}, target};
        });
        const settled = await Promise.allSettled(requests.map(request => receive(viewerBrowser, request.settings, request.target,
          discovery, concurrent ? undefined : remoteToken, sync, {})));
        entry.receivers = settled.map((value, index) => value.status === 'fulfilled' ? value.value :
          fs.existsSync(path.join(requests[index].target, 'receiver.json')) ? JSON.parse(fs.readFileSync(path.join(requests[index].target, 'receiver.json'))) : {ok:false, error:String(value.reason)});
        assert(entry.receivers.every(value => value.ok), 'Decoded codec/bitrate/fallback checks failed');
        entry.audioDiagnostics = (await api('/diagnostics')).audio;
        await quit(); entry.passed = true; save(); continue;
      }
      const viewer = await receiver(viewerBrowser, stream, publisher);
      if(continuousApps){entry.continuousObserver=await continuity.start(viewer);continuousPage=viewer;entry.continuous=[];}
      const continuousSample=async(label,settings={})=>{
        if(!continuousApps)return;
        const batch=await continuity.drain(viewer),file=label+'-continuous.json.gz';
        fs.writeFileSync(path.join(report,file),require('zlib').gzipSync(JSON.stringify(batch)),{flag:'wx'});
        entry.continuous.push({label,file,sha256:sha(path.join(report,file)),...continuity.analyze(batch,settings)});save();
      };
      entry.video = await observe(viewer, 3000); requireMoving(entry.video, fixture.name + ' video');
      entry.audio = await observeAudio(viewer); requireAudio(entry.audio, fixture.name, {microphone:fixture.mix, excluded:communications || apps || fixture.name === 'microphone'}); save();
      await continuousSample('initial');
      const diagnostics = await api('/diagnostics'); entry.audioDiagnostics = diagnostics.audio;
      assert.equal(diagnostics.audio.source_mode, fixture.mode);
      if (communications) assert.equal(diagnostics.audio.communications_output_device, 'pulse-output:' + communicationsSink);
      if (gui) await checkAudioWarning(null, 'healthyAudioHasNoWarning');
      assert.equal(diagnostics.audio.configured_opus_bitrate_kbps, 128);
      if (fixture.input) assert(diagnostics.audio.active_microphone_source.includes('GameCaptureOwnedQAInput'));
      if (apps) {
        const sample = async (label, checks) => {
          await sleep(1200);
          if (automaticApp) { entry[label + 'SourceClock'] = await source.evaluate(() => ({state:audioFixture.state, time:audioFixture.currentTime, baseLatency:audioFixture.baseLatency, outputLatency:audioFixture.outputLatency})); save(); }
          const observation = await observeAudio(viewer);
          entry[label] = observation; requireAudio(observation, label, {excluded:true, ...checks}); save();
          await continuousSample(label,{silent:!!checks.silent,transition:label==='noStreams'||label==='streamRecreated'});
        };
        if (automaticApp) {
          await source.evaluate(() => audioFixture.suspend()); await sample('automaticAppSilent', {silent:true});
          await source.evaluate(() => audioFixture.resume()); await sample('automaticAppResumed', {microphoneOff:true});
          const late = await receiver(viewerBrowser, stream, publisher);
          entry.lateAudio = await observeAudio(late); requireAudio(entry.lateAudio, 'Automatic app late viewer', {excluded:true});
          await late.close();
        } else {
        await appSource.command({child:true}); await sample('childJoined', {microphone:true});
        await appSource.command({child:false}); await sample('childRemoved', {microphoneOff:true});
        await appSource.command({extra:true}); await sample('secondStreamSameProcess', {microphone:true});
        await appSource.command({extra:false}); await sample('secondStreamRemoved', {microphoneOff:true});
        await appSource.command({primary:false}); await sample('noStreams', {silent:true});
        await appSource.command({primary:true}); await sample('streamRecreated', {microphoneOff:true});
        entry.outputMoves=[];
        for(let move=0;move<appOutputMoves;move++) {
          const playback = JSON.parse(pactl('-f', 'json', 'list', 'sink-inputs')).filter(row => Number(row.properties['application.process.id']) === appSource.child.pid);
          assert.equal(playback.length, 1);
          const destination=move%2===0?sinkName:defaultSink;
          const transition={playbackIndex:playback[0].index,destination,requestedAtMs:Date.now()};
          pactl('move-sink-input', String(playback[0].index), destination);
          transition.completedAtMs=Date.now();entry.outputMoves.push(transition);save();
          await sample(move===0?'outputMoved':'outputMoved'+(move+1), {microphoneOff:true});
        }
        const late = await receiver(viewerBrowser, stream, publisher);
        entry.lateAudio = await observeAudio(late); requireAudio(entry.lateAudio, 'App late viewer', {excluded:true});
        await late.close();
        await continuousSample('lateViewer');
        if(continuousPage){await continuity.stop(continuousPage);continuousPage=null;}
        await appSource.stop();
        appSource = null; await sleep(1200);
        const beforeLoss = await api('/diagnostics'); await sleep(800); const afterLoss = await api('/diagnostics');
        assert.equal(beforeLoss.metrics.audio_packets_sent, afterLoss.metrics.audio_packets_sent, 'Closed app continued sending audio');
        entry.noAudioAfterAppExit = true;
        if (gui) await checkAudioWarning(/Primary audio stopped/, 'appLossWarningVisible');
        entry.videoAfterAppExit = await observe(viewer, 3000); requireMoving(entry.videoAfterAppExit, 'Video continues after app exit');
        }
        await viewer.close();
      } else {
      if (gui && fixture.input) {
        ui('press', 'Mute microphone'); await sleep(800);
        assert.equal((await api('/diagnostics')).audio.microphone_muted, true);
        entry.muted = await observeAudio(viewer);
        requireAudio(entry.muted, fixture.name + ' GUI mute', {silent:!fixture.mix, microphoneOff:fixture.mix});
        entry.videoWhileMuted = await observe(viewer, 3000); requireMoving(entry.videoWhileMuted, 'GUI mute preserves video');
        ui('press', 'Unmute microphone'); await sleep(800);
        assert.equal((await api('/diagnostics')).audio.microphone_muted, false);
        entry.unmuted = await observeAudio(viewer); requireAudio(entry.unmuted, 'GUI unmute', {microphone:fixture.mix, excluded:!fixture.mix});
      }
      if (gui && fixture.mix) {
        assert.equal(diagnostics.audio.primary_gain, .5); assert.equal(diagnostics.audio.additional_gain, .5);
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        entry.mixedRmsAtHalfGain = median(entry.audio.spectra.map(sample => sample.rms));
        assert(entry.mixedRmsAtHalfGain > .025 && entry.mixedRmsAtHalfGain < .095, 'Decoded half-gain mix level is outside fixture bounds');
      }
      systemTone.silent = inputTone.silent = true; if (communicationsTone) communicationsTone.silent = true; await sleep(1000);
      entry.silence = await observeAudio(viewer); requireAudio(entry.silence, fixture.name + ' silence', {silent:true});
      systemTone.silent = inputTone.silent = false; if (communicationsTone) communicationsTone.silent = false; await sleep(1000);
      const late = await receiver(viewerBrowser, stream, publisher);
      entry.lateAudio = await observeAudio(late); requireAudio(entry.lateAudio, fixture.name + ' late viewer', {microphone:fixture.mix, excluded:communications || fixture.name === 'microphone'});
      if (communications && gui) {
        clearInterval(communicationsTone.timer); communicationsTone.retired = true; communicationsTone.child.stdin.destroy(); communicationsTone.child.kill(); await communicationsTone.child.closed;
        pactl('unload-module', communicationsModule); modules.splice(modules.indexOf(communicationsModule), 1);
        await sleep(2000);
        entry.afterOutputLoss = await observeAudio(viewer); requireCommunicationsLoss(entry.afterOutputLoss);
        await checkAudioWarning(/Primary audio stopped/, 'outputLossWarningVisible');
        if (opts['combined-audio-loss'] === 'true') {
          pactl('unload-module', inputModule); modules.splice(modules.indexOf(inputModule), 1);
          await waitFor(async () => (await api('/diagnostics')).audio.active_microphone_source === 'none', 6000, 'Second lost input stayed active');
          lostMicrophoneDuringOutputLoss = true; await sleep(1200);
          entry.afterBothInputsLost = await observeAudio(viewer); requireCommunicationsLoss(entry.afterBothInputsLost);
          await checkAudioWarning(/Primary audio stopped[\s\S]*Microphone\/input stopped/, 'bothAudioWarningsVisible');
          inputModule = createInput();
        }
        entry.videoAfterOutputLoss = await observe(viewer, 3000); requireMoving(entry.videoAfterOutputLoss, 'Video continues after communications output loss');
        communicationsModule = createCommunicationsOutput(); communicationsTone = tone(communicationsSink, 'owned replacement communications');
        await sleep(1500);
        entry.afterOutputRecreation = await observeAudio(viewer); requireCommunicationsLoss(entry.afterOutputRecreation);
        entry.noSilentOutputReplacement = true;
      }
      if (fixture.name === 'microphone') {
        pactl('unload-module', inputModule); modules.splice(modules.indexOf(inputModule), 1);
        await waitFor(async () => (await api('/diagnostics')).audio.active_microphone_source === 'none', 6000, 'Removed microphone stayed active');
        await sleep(1200);
        if (gui) await checkAudioWarning(/Microphone\/input stopped/, 'microphoneLossWarningVisible');
        entry.afterInputLoss = await observeAudio(viewer); requireAudio(entry.afterInputLoss, 'Removed input does not capture default/system audio', {silent:true});
        entry.videoAfterInputLoss = await observe(viewer, 3000); requireMoving(entry.videoAfterInputLoss, 'Video after microphone removal');
        inputModule = createInput(); await sleep(1000);
        assert.equal((await api('/diagnostics')).audio.active_microphone_source, 'none', 'Input silently reopened after removal');
      }
      await late.close(); await viewer.close();
      }
      if (gui) {
        ui('press', 'Stop streaming');
        await waitFor(async () => { const state = (await api('/diagnostics')).app; return !state.live && !state.capturing; }, 10000, 'GUI stop did not finish');
        const before = await api('/diagnostics'); await sleep(500); const after = await api('/diagnostics');
        assert.equal(before.metrics.audio_packets_sent, after.metrics.audio_packets_sent); assert.equal(before.video.frames_captured, after.video.frames_captured);
        assert.equal(after.audio.active_microphone_source, 'none');
        entry.guiStopSettled = true;
        await checkAudioWarning(null, 'audioWarningClearedOnStop');
        fs.writeFileSync(path.join(report, fixture.name + '-ui-stopped.json'), ui('dump'));
        if (wayland) execFileSync('gnome-screenshot', ['-f', path.join(report, fixture.name + '-gui.png')], {env, timeout:10000});
        else execFileSync('python3', ['-c', 'from PIL import ImageGrab; import sys; ImageGrab.grab().save(sys.argv[1])', path.join(report, fixture.name + '-gui.png')], {env, timeout:10000});
      }
      if (gui && communications) {
        lostMicrophoneDuringOutputLoss = false;
        ui('press', 'Refresh outputs');
        await goLive();
        const restarted = await receiver(viewerBrowser, stream, publisher);
        entry.afterExplicitOutputRestart = await observeAudio(restarted); requireAudio(entry.afterExplicitOutputRestart, 'Explicit communications output restart', {microphone:fixture.mix, excluded:true});
        await checkAudioWarning(null, 'audioWarningClearedOnExplicitRestart');
        await restarted.close(); ui('press', 'Stop streaming');
        await waitFor(async () => !(await api('/diagnostics')).app.capturing, 10000, 'Communications restart stop did not finish');
      }
      if (gui && apps) {
        appSource = await startApp(defaultSink);
        ui('press', 'Refresh audio apps');
        const stale = JSON.parse(ui('dump')).find(row => row.role === 'combo box' && row.name.includes('[unavailable; select again]'));
        assert(stale, 'Closed selected app was silently replaced');
        await goLive();
        const staleViewer = await receiver(viewerBrowser, stream, publisher);
        entry.videoWithStaleApp = await observe(staleViewer, 3000); requireMoving(entry.videoWithStaleApp, 'Stale audio app preserves video');
        const before = await api('/diagnostics'); await sleep(1000); const after = await api('/diagnostics');
        assert.equal(before.metrics.audio_packets_sent, after.metrics.audio_packets_sent, 'Replacement app was captured without selection');
        entry.staleAppNotReplaced = true;
        await checkAudioWarning(/Selected audio app is unavailable/, 'staleAppWarningVisible');
        await staleViewer.close(); ui('press', 'Stop streaming');
        await waitFor(async () => !(await api('/diagnostics')).app.capturing, 10000, 'Stale-app stop did not finish');
        ui('choose', stale.name, 'GameCaptureOwnedQAApp (PID ' + appSource.child.pid + ')');
        await goLive();
        const restarted = await receiver(viewerBrowser, stream, publisher);
        entry.afterExplicitReselection = await observeAudio(restarted); requireAudio(entry.afterExplicitReselection, 'Explicit app reselection', {excluded:true});
        await checkAudioWarning(null, 'audioWarningClearedOnExplicitRestart');
        await restarted.close(); ui('press', 'Stop streaming');
        await waitFor(async () => !(await api('/diagnostics')).app.capturing, 10000, 'Reselected-app stop did not finish');
        await appSource.stop(); appSource = null;
      }
      await quit();
      if (gui && (fixture.mix || communications)) {
        log = fs.createWriteStream(path.join(report, fixture.name + '-relaunch-private-publisher.log'));
        publisher = spawn(exe, args, {cwd:bundle, env, stdio:['ignore', 'pipe', 'pipe']});
        publisher.stdout.pipe(log, {end:false}); publisher.stderr.pipe(log, {end:false});
        publisher.closed = new Promise(resolve => publisher.once('close', resolve));
        await waitFor(() => { assert.equal(publisher.exitCode, null); return fs.existsSync(discovery); }, 10000, 'GUI relaunch did not publish discovery');
        control = JSON.parse(fs.readFileSync(discovery)); assert.equal(control.pid, publisher.pid);
        const restored = JSON.parse(ui('dump'));
        assert(restored.some(row => row.role === 'combo box' && row.name === (communications ? 'Communications output (selected device)' : 'System audio (all apps)')));
        if (communications) assert(restored.some(row => row.role === 'combo box' && row.name === 'GameCaptureOwnedQACommunications'));
        if (fixture.input) assert(restored.some(row => row.role === 'combo box' && row.name.startsWith('GameCaptureOwnedQAInput')));
        if (fixture.mix) for (const name of ['Game Audio Gain', 'Mic Gain']) assert.equal(restored.find(row => row.role === 'spin button' && row.name === name).value, 50);
        const idle = await api('/diagnostics'); assert(!idle.app.live && !idle.app.capturing);
        assert.equal(idle.audio.active_microphone_source, 'none'); assert.equal(idle.metrics.audio_packets_sent, 0);
        fs.writeFileSync(path.join(report, 'mix-ui-restored.json'), JSON.stringify(restored, null, 2));
        entry.settingsRestoredWithoutCapture = true; await quit();
      }
      if (communications && gui && opts['missing-output-relaunch'] === 'true') {
        clearInterval(communicationsTone.timer); communicationsTone.retired = true;
        communicationsTone.child.stdin.destroy(); communicationsTone.child.kill(); await communicationsTone.child.closed;
        pactl('unload-module', communicationsModule); modules.splice(modules.indexOf(communicationsModule), 1);
        log = fs.createWriteStream(path.join(report, 'missing-output-private-publisher.log'));
        publisher = spawn(exe, args, {cwd:bundle, env, stdio:['ignore', 'pipe', 'pipe']});
        publisher.stdout.pipe(log, {end:false}); publisher.stderr.pipe(log, {end:false});
        publisher.closed = new Promise(resolve => publisher.once('close', resolve));
        await waitFor(() => { assert.equal(publisher.exitCode, null); return fs.existsSync(discovery); }, 10000, 'Missing-output relaunch did not publish discovery');
        control = JSON.parse(fs.readFileSync(discovery)); assert.equal(control.pid, publisher.pid);
        const missingRows = JSON.parse(ui('dump'));
        assert(missingRows.some(row => row.role === 'combo box' && row.name === 'Selected output unavailable; choose again'));
        assert(!(await api('/diagnostics')).app.capturing);
        entry.unavailableOutputRestored = true;
        ui('source', wayland ? 'Choose a window' : title);
        await goLive();
        const missingViewer = await receiver(viewerBrowser, stream, publisher);
        entry.missingOutputVideo = await observe(missingViewer, 3000); requireMoving(entry.missingOutputVideo, 'Missing communications output preserves video');
        if (fixture.mix) { entry.missingOutputAudio = await observeAudio(missingViewer); requireCommunicationsLoss(entry.missingOutputAudio); }
        else {
          const before = await api('/diagnostics'); await sleep(1500); const after = await api('/diagnostics');
          assert.equal(before.metrics.audio_packets_sent, 0); assert.equal(after.metrics.audio_packets_sent, 0);
          const incoming = await missingViewer.evaluate(async () => { const rows = []; for (const pc of reviewPCs) for (const item of (await pc.getStats()).values()) if (item.type === 'inbound-rtp' && item.kind === 'audio') rows.push(item.packetsReceived || 0); return rows; });
          assert(incoming.every(count => count === 0)); entry.noFallbackAudioWithMissingOutput = true;
        }
        await sleep(5000);
        const warningRows = ui('dump'); fs.writeFileSync(path.join(report, 'missing-output-ui.json'), warningRows);
        entry.missingOutputWarningVisible = JSON.parse(warningRows).some(row => row.role === 'label' && row.states.includes('visible') && /Selected communications output is unavailable/.test(row.name));save();
        if (wayland) execFileSync('gnome-screenshot', ['-f', path.join(report, 'missing-output-warning.png')], {env, timeout:10000});
        else execFileSync('python3', ['-c', 'from PIL import ImageGrab; import sys; ImageGrab.grab().save(sys.argv[1])', path.join(report, 'missing-output-warning.png')], {env, timeout:10000});
        assert(entry.missingOutputWarningVisible, 'Audio startup warning was lost while video was live');
        await checkAudioWarning(/Selected communications output is unavailable/, 'missingOutputWarningRetained');
        if (fixture.mix && opts['fallback-meter-label'] === 'true') {
          assert.equal((await api('/diagnostics')).audio.microphone_is_primary, true);
          const meterRows = JSON.parse(ui('dump'));
          assert(meterRows.some(row => row.role === 'label' && row.name === 'Primary: Selected microphone/input (50%)'));
          assert(meterRows.some(row => row.role === 'label' && row.name === 'Mic/input: Primary source'));
          entry.fallbackMeterIdentifiesMicrophone = true;
        }
        await missingViewer.close(); ui('press', 'Stop streaming');
        await waitFor(async () => !(await api('/diagnostics')).app.capturing, 10000, 'Missing-output Stop failed');
        communicationsModule = createCommunicationsOutput(); communicationsTone = tone(communicationsSink, 'owned restored communications');
        ui('press', 'Refresh outputs'); await goLive();
        const recovered = await receiver(viewerBrowser, stream, publisher);
        entry.afterMissingOutputRecovery = await observeAudio(recovered); requireAudio(entry.afterMissingOutputRecovery, 'Restart after missing output', {microphone:fixture.mix, excluded:true});
        assert(!JSON.parse(ui('dump')).some(row => row.role === 'label' && row.states.includes('visible') && /Selected communications output is unavailable/.test(row.name)), 'Resolved audio warning survived restart');
        await checkAudioWarning(null, 'missingOutputNoticeClearedOnRecovery');
        if (opts['fallback-meter-label'] === 'true') assert.equal((await api('/diagnostics')).audio.microphone_is_primary, false);
        entry.audioWarningClearedOnRecovery = true;
        await recovered.close();ui('press', 'Stop streaming');
        await waitFor(async () => !(await api('/diagnostics')).app.capturing, 10000, 'Recovered-output Stop failed');
        await quit();
      }
      if(continuousApps)assert(entry.continuous.every(c=>c.passed),'Continuous received app audio failed; inspect every recorded phase');
      entry.passed = true; save();
    }
    for (const source of tones.filter(source => !source.retired)) { assert.equal(source.child.exitCode, null); assert(!source.error, source.error); }
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if(continuousPage)try{await continuity.stop(continuousPage);continuousPage=null;}catch(error){result.continuousCleanupError=String(error);result.passed=false;process.exitCode=1;}
    if (publisher) { try { await quit(); } catch { publisher?.kill(); if (publisher) await publisher.closed; } }
    if (portalSelector && portalSelector.exitCode === null) portalSelector.kill();
    if (appSource) { try { await appSource.stop(); } catch (error) { result.fixtureCleanupError = String(error); result.passed = false; process.exitCode = 1; } }
    if (keyboardServer) { keyboardServer.stdin.end(); await waitFor(() => keyboardServer.exitCode !== null, 8000, 'Owned keyboard did not stop'); await keyboardServer.closed; }
    if (keyboardDirectory) fs.rmdirSync(keyboardDirectory);
    if (sourceBrowser) await sourceBrowser.close(); if (viewerBrowser) await viewerBrowser.close();
    for (const source of tones) { clearInterval(source.timer); source.child.stdin.destroy(); if (source.child.exitCode === null) source.child.kill(); }
    for (const module of modules.reverse()) { try { pactl('unload-module', module); } catch (error) { result.cleanupError = String(error); result.passed = false; process.exitCode = 1; } }
    if (log) await new Promise(resolve => log.end(resolve));
    if (wayland) {
      await sleep(2000);
      try {
        const journal = execFileSync('journalctl', ['--user', '-u', 'xdg-desktop-portal.service', '-u', 'xdg-desktop-portal-gnome.service', '--since=@' + startedAtSeconds, '--no-pager', '-o', 'short-iso'], {encoding:'utf8', timeout:5000});
        const file = path.join(report, 'portal-journal.log'); fs.writeFileSync(file, journal); result.portalJournalSha256 = sha(file);
        assert(!/status=\d+\/(?:SEGV|ABRT)|Failed with result 'core-dump'/.test(journal), 'Portal service crashed');
        if (portalOwner) { checkPortalOwner(); result.portalBackend.survived = true; }
      } catch (error) { result.portalAuditError = String(error); result.passed = false; process.exitCode = 1; }
    }
    if(continuousApps){
      try{
        const file=path.join(report,'linux-audio-timing.csv');result.audioTrace.sha256=sha(file);result.audioTrace.bytes=fs.statSync(file).size;save();
        execFileSync('python3',[path.join(report,'linux-audio-timing-report.py'),report],{encoding:'utf8',timeout:30000});
        const analysis=path.join(report,'linux-audio-timing.json');result.audioTrace.analysisSha256=sha(analysis);result.audioTrace.analysis=JSON.parse(fs.readFileSync(analysis));assert(result.audioTrace.analysis.traceComplete);
      }catch(error){result.audioTraceError=String(error);result.passed=false;process.exitCode=1;}
    }
    save(); console.log(JSON.stringify({report, passed:result.passed, error:result.error, cleanupError:result.cleanupError}));
  }
})();
