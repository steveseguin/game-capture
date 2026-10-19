'use strict';
// Packaged X11/Wayland video + real PipeWire/Pulse routes -> hosted browser decoding.
// Owned virtual input qualifies routing, not a physical microphone or A/V drift.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const assert = require('assert/strict'), {spawn, execFile, execFileSync} = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const {chromium} = require('playwright');
const {receiver, observe, requireMoving, observeAudio, closeAudioObserver, waitFor, sleep} = require('./macos-media-receiver');
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
const previewBeforeLive = opts['preview-before-live'] === 'true';
const previewServiceLoss = opts['preview-service-loss'] === 'true';
const previewHelperUnavailable = opts['preview-helper-unavailable'] === 'true';
assert(!previewHelperUnavailable || (previewBeforeLive && !previewServiceLoss), 'Unavailable preview helper requires local preview without service faults');
const previewCoreStartupDown = opts['preview-core-startup-down'] === 'true';
const unavailableCoreAction = opts['unavailable-core-action'] || 'preview';
assert(['preview','go-live'].includes(unavailableCoreAction) && (previewCoreStartupDown || unavailableCoreAction === 'preview'), 'Unavailable-core action requires the core-startup fixture');
assert(!previewBeforeLive || (wayland && ((matrix === 'gui' && opts.case === 'mix') ||
  (matrix === 'communications-gui' && opts.case === 'communications' && communicationsMix) ||
  (matrix === 'apps-gui' && opts.case === 'selected-app'))),
  'Audio preview promotion requires a supported Wayland GUI audio route');
assert(opts['combined-audio-loss'] !== 'true' || (communications && communicationsMix), 'Combined loss requires communications mixing');
const gui = matrix === 'gui' || matrix === 'apps-gui' || matrix === 'communications-gui', apps = automaticApp || matrix === 'apps' || matrix === 'apps-gui'; assert(['routes', 'codecs', 'gui', 'apps', 'apps-gui', 'apps-auto', 'communications-gui', 'communications-cli'].includes(matrix));
const audioServerLoss = opts['audio-server-loss'] === 'true';
const audioServerStopDown = opts['audio-server-stop-down'] === 'true';
const audioServerQuitDown = opts['audio-server-quit-down'] === 'true';
const audioServerStartupDown = opts['audio-server-startup-down'] === 'true';
const captureServerLoss = opts['capture-server-loss'] === 'true';
assert(!previewServiceLoss || (previewBeforeLive && audioServerLoss && !audioServerStopDown && !audioServerQuitDown && !audioServerStartupDown), 'Preview fault requires preview/mixed-audio service-loss fixture and excludes post-live lifecycle variants');
assert(!previewCoreStartupDown || (previewServiceLoss && captureServerLoss), 'Whole-core unavailable startup requires the preview core-loss fixture');
assert(!captureServerLoss || (audioServerLoss && wayland && !audioServerStopDown && !audioServerStartupDown), 'Capture-server loss requires Wayland server loss; capture should stop automatically, and unavailable video startup is a separate workflow');
assert(!audioServerStopDown || audioServerLoss,'Stop during an audio outage requires the server-loss workflow');
assert(!audioServerQuitDown || (audioServerLoss && !audioServerStopDown),'Quit during an audio outage requires server loss and excludes the separate Stop workflow');
assert(!audioServerStartupDown || audioServerQuitDown,'Unavailable-server startup requires the Quit-during-outage workflow');
assert(!audioServerLoss || (matrix === 'gui' && opts.case === 'mix' && audioWarnings && process.env.GC_QA_AUDIO_SOCKET), 'Audio server loss requires an owned audio fixture and GUI mix with audio warnings');
assert(!audioServerLoss || !wayland || (process.env.GC_QA_OWNED_WAYLAND && process.env.GC_QA_AUDIO_FAULT_SCOPE === (captureServerLoss ? 'pipewire' : 'pulse-only')), 'Wayland service loss requires the matching owned compositor fault scope');
assert(!audioServerLoss || (process.env.GC_QA_RECEIVER_PULSE_SERVER && process.env.GC_QA_RECEIVER_PULSE_SERVER !== process.env.PULSE_SERVER), 'Audio server loss requires an independent receiver audio clock/server');
const continuousApps=opts['continuous-app-audio']==='true';
const appPlaybackBackend=opts['app-playback-backend']||'pulse';
assert(['pulse','pipewire','jack'].includes(appPlaybackBackend));
const nativeDirectSelection=appPlaybackBackend==='pipewire'&&matrix==='apps-gui';
const jackSystem=appPlaybackBackend==='jack'&&matrix==='routes'&&opts.case==='system';
assert(appPlaybackBackend==='pulse'||((['apps','apps-gui'].includes(matrix)||jackSystem)&&!continuousApps&&!previewBeforeLive),'Native playback supports explicit app selection or JACK system-output routing');
const selectedAppPid=source=>nativeDirectSelection?source.playbackPid:source.child.pid;
assert(!continuousApps||(matrix==='apps'&&!wayland),'Continuous app diagnostic currently requires explicit X11 CLI apps');
const appOutputMoves=Number(opts['app-output-moves']||1);
assert(Number.isInteger(appOutputMoves)&&appOutputMoves>=1&&appOutputMoves<=20,'App output moves must be 1..20');
assert(appOutputMoves===1||['apps','apps-gui'].includes(matrix),'Repeated output moves require explicit app capture');
const continuity=continuousApps?require('./linux-app-audio-continuity'):null;
const snapshotContext=opts['app-snapshot-context']||'fresh';
const resumeSnapshotDelayMs=Number(opts['app-resume-snapshot-delay-ms']||1200);
assert(['fresh','persistent'].includes(snapshotContext)&&[1200,2200].includes(resumeSnapshotDelayMs),'Invalid snapshot observer control');
assert(continuousApps||(snapshotContext==='fresh'&&resumeSnapshotDelayMs===1200),'Snapshot controls require continuous app diagnostics');
const persistentSnapshot=snapshotContext==='persistent';
const resumeReference=opts['app-resume-reference']==='true';
assert(!resumeReference||continuousApps,'Independent source reference requires continuous app diagnostics');
const appReference=resumeReference?require('./linux-app-audio-reference'):null;
const resumeRecording=opts['app-resume-recording']==='true';
assert(!resumeRecording||continuousApps,'Receiver recording requires continuous app diagnostics');
const encodedCapture=opts['app-encoded-audio']==='true';
assert(!encodedCapture||continuousApps,'Encoded audio copy requires continuous app diagnostics');
const playoutReference=opts['app-playout-reference']==='true';
assert(!playoutReference||continuousApps,'Receiver playout requires continuous app diagnostics');
const playoutHeaded=opts['app-playout-headed']==='true';
assert(!playoutHeaded||playoutReference,'Visible receiver control requires owned playout');
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
if(audioServerLoss)fs.copyFileSync(path.join(__dirname,'linux-private-audio.py'),path.join(report,'linux-private-audio.py'));
if(previewBeforeLive)fs.copyFileSync(path.join(__dirname,'linux-preview-observer.py'),path.join(report,'linux-preview-observer.py'));
if(wayland)fs.copyFileSync(path.join(__dirname,'linux-pipewire-snapshot.py'),path.join(report,'linux-pipewire-snapshot.py'));
if(continuousApps)for(const name of ['linux-app-audio-continuity.js','macos-continuous-audio.js','linux-audio-timing-report.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
if(resumeReference)for(const name of ['linux-app-audio-reference.js','linux-audio-reference-report.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
if(resumeRecording)fs.copyFileSync(path.join(__dirname,'linux-received-audio-report.py'),path.join(report,'linux-received-audio-report.py'));
if(encodedCapture)for(const name of ['linux-encoded-audio.js','linux-decode-opus-report.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
if(playoutReference)for(const name of ['linux-app-audio-reference.js','linux-playout-audio-report.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const result = {scope:`Extracted Ubuntu DEB; bounded ${wayland ? 'Wayland portal' : 'X11'} H264 and audio via ${apps ? 'selected application playback' : (communications ? 'explicit communications output and owned virtual microphone' : 'default system output and owned virtual microphone')}; ${matrix} workflow. Physical microphones, native PipeWire/JACK app streams, endurance and A/V drift excluded.`,
  executableSha256:sha(exe), manifestSha256:sha(manifestFile), harnessSha256:sha(__filename),
  receiverHarnessSha256:sha(path.join(__dirname, 'macos-media-receiver.js')),
  codecReceiverSha256:sha(path.join(__dirname, 'audio-settings-packaged-e2e.js')),
  guiHelperSha256:sha(path.join(__dirname, 'linux-ui-control.py')),
  portalHelperSha256:sha(path.join(__dirname, 'linux-portal-select.py')),
  appFixtureSha256:sha(path.join(__dirname, 'linux-app-audio-source.py')), matrix, backend:wayland ? 'wayland' : 'x11', requestedCase:opts.case || 'all', cases:[], passed:false};
result.appPlaybackBackend=appPlaybackBackend;
if(appPlaybackBackend==='pipewire')result.scope=result.scope.replace('native PipeWire/JACK app streams','JACK app streams')+(nativeDirectSelection?' Native pw-cat GUI discovery/selection, sibling exclusion and stale selection/reselection.':' Native pw-cat children and grandchildren; explicit parent-PID capture, not same-PID streams or GUI app discovery.');
if(appPlaybackBackend==='jack')result.scope=result.scope.replace('native PipeWire/JACK app streams','other JACK servers/clients')+' Real JACK API via pw-jack in an owned PipeWire server; dynamic same-process and child-client routing.';
if(jackSystem)result.scope='Packaged X11 window video and system-output capture of actual JACK API stereo playback through pw-jack. Independent browser decoding, silence/resume and late reception. No per-JACK-client capture, physical audio, other JACK servers, performance or drift qualification.';
if(audioServerLoss)result.audioServerFault={requested:true,captureServerLoss,phase:previewServiceLoss?'local-preview':'publishing',previewCoreStartupDown,unavailableCoreAction,scope:process.env.GC_QA_AUDIO_FAULT_SCOPE||'whole-private-audio-server',stopWhileDown:audioServerStopDown,quitWhileDown:audioServerQuitDown,startupWhileDown:audioServerStartupDown,fixtureSha256:sha(path.join(report,'linux-private-audio.py')),receiverPulseServer:process.env.GC_QA_RECEIVER_PULSE_SERVER,publisherPulseServer:process.env.PULSE_SERVER};
if(previewBeforeLive)result.previewBeforeLive={requested:true,helperUnavailable:previewHelperUnavailable,observerSha256:sha(path.join(report,'linux-preview-observer.py'))};
if(wayland)result.pipewireSnapshotHelperSha256=sha(path.join(report,'linux-pipewire-snapshot.py'));
if(continuousApps){result.traceAudio=true;result.diagnosticOnly=true;result.appOutputMoves=appOutputMoves;result.continuousHarnesses=Object.fromEntries(['linux-app-audio-continuity.js','macos-continuous-audio.js','linux-audio-timing-report.py'].map(n=>[n,sha(path.join(report,n))]));}
if(continuousApps)result.snapshotObserver={context:snapshotContext,resumeDelayMs:resumeSnapshotDelayMs,scope:'Observer-lifecycle diagnostic; all tone/isolation and continuous level checks retained. No timing/continuity threshold is relaxed.'};
if(resumeReference)result.sourceReferenceHarnesses=Object.fromEntries(['linux-app-audio-reference.js','linux-audio-reference-report.py'].map(n=>[n,sha(path.join(report,n))]));
if(resumeRecording)result.receiverRecordingAnalyzerSha256=sha(path.join(report,'linux-received-audio-report.py'));
if(encodedCapture)result.encodedAudioHarnesses=Object.fromEntries(['linux-encoded-audio.js','linux-decode-opus-report.py'].map(n=>[n,sha(path.join(report,n))]));
if(playoutReference)result.playoutHarnesses=Object.fromEntries(['linux-app-audio-reference.js','linux-playout-audio-report.py'].map(n=>[n,sha(path.join(report,n))]));
const save = () => fs.writeFileSync(path.join(report, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const pactl = (...args) => execFileSync('pactl', args, {encoding:'utf8', timeout:5000}).trim();
const modules = [], tones = []; let sourceBrowser, viewerBrowser, publisher, log, control, discovery, appSource, portalSelector, keyboardServer, keyboardDirectory, portalOwner;
let continuousPage=null;
let snapshotPage=null;
let sourceReference=null;
let receiverRecording=null;
let encodedAudio=null;
let playout=null;
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
  const child = spawn(appPlaybackBackend==='jack'?'pw-jack':'python3', [...(appPlaybackBackend==='jack'?['python3']:[]), path.join(__dirname, 'linux-app-audio-source.py'), '--device', device, '--backend', appPlaybackBackend], {detached:true, stdio:['pipe', 'pipe', 'pipe'],
    env:{...process.env,...(appPlaybackBackend==='pipewire'&&opts['capture-native-source']==='true'?{GC_QA_PIPEWIRE_TRACE_DIR:report}:{})}});
  const lines = [], state = {child, errors:'', ready:false, serial:0}; let buffer = '';
  child.stdout.on('data', data => { buffer += data; while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); const line = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if(line.playbackPid)state.playbackPid=line.playbackPid; if (line.ready) state.ready = true; else lines.push(line); } });
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
    if(continuousApps||opts['capture-audio-diagnostics']==='true'){env.VERSUS_LINUX_AUDIO_TRACE=path.join(report,'linux-audio-timing.csv');result.audioTrace={path:'linux-audio-timing.csv',scope:'One selected-app lifecycle capture; opt-in timing metadata, no PCM in native trace.'};}
    if (wayland) { env.XDG_SESSION_TYPE = 'wayland'; env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || 'wayland-0'; env.QT_QPA_PLATFORM = 'wayland'; }
    else { env.XDG_SESSION_TYPE = 'x11'; delete env.WAYLAND_DISPLAY; env.QT_QPA_PLATFORM = 'xcb'; }
    if (gui) env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON = '1';
    const ownedWaylandInput = gui && wayland && env.GC_QA_OWNED_WAYLAND;
    if (ownedWaylandInput) {
      assert(env.GC_QA_KEYBOARD_SOCKET && fs.statSync(env.GC_QA_KEYBOARD_SOCKET).isSocket(), 'Owned compositor input socket missing');
      result.ownedWaylandDesktop = env.GC_QA_OWNED_WAYLAND;
      result.scope += ' Isolated software-rendered GNOME with compositor-confined keyboard; not physical-desktop qualification.';
    }
    if (gui && wayland && !ownedWaylandInput) {
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
    let systemTone = tone(defaultSink, 'owned system'), inputTone = tone(sinkName, 'owned microphone');
    const browser = opts.browser || '/usr/bin/google-chrome';
    sourceBrowser = await chromium.launch({executablePath:browser, headless:false, env, args:[...(wayland ? ['--ozone-platform=wayland', '--window-position=10,10', '--window-size=720,560'] : []), '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']});
    const source = await sourceBrowser.newPage(wayland ? {viewport:null} : {viewport:{width:800, height:450}}), title = 'Owned Linux Capture ' + suffix;
    await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
      const canvas=document.querySelector('canvas'),c=canvas.getContext('2d');let id=0;window.fixture={staticId:null};
      function paint(){canvas.width=innerWidth;canvas.height=innerHeight;const w=canvas.width,h=canvas.height;id=fixture.staticId??((id+1)%65536);c.fillStyle='#183042';c.fillRect(0,0,w,h);c.fillStyle='cyan';c.fillRect(.1*w,.25*h,.05*w,.5*h);c.fillStyle='magenta';c.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){c.fillStyle=(id>>i)&1?'white':'black';c.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}}
      function draw(){paint();requestAnimationFrame(draw);}draw();</script>`);
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

    let receiverSink;
    if(playoutReference){
      const name=sinkName+'_receiver';
      const moduleId=pactl('load-module','module-null-sink','sink_name='+name,'sink_properties=device.description=GameCaptureOwnedQAReceiver','rate=48000','channels=2');
      modules.push(moduleId);receiverSink={name,moduleId};result.receiverSink={...receiverSink,headless:!playoutHeaded,muted:false};save();
    }
    viewerBrowser = await chromium.launch({executablePath:browser, headless:!playoutHeaded,
      env:receiverSink?{...env,PULSE_SINK:receiverSink.name}:process.env.GC_QA_RECEIVER_PULSE_SERVER?{...env,PULSE_SERVER:process.env.GC_QA_RECEIVER_PULSE_SERVER}:env,
      ...(playoutReference?{ignoreDefaultArgs:['--mute-audio']}:{}),
      args:['--autoplay-policy=no-user-gesture-required',...(playoutReference?[]:['--mute-audio']),
        ...(playoutHeaded?['--window-position=850,10','--window-size=550,700']:[])]});
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
        if(appPlaybackBackend==='pipewire'){
          const pid=appSource.playbackPid;
          assert(Number.isInteger(pid)&&pid>0);
          const executable=fs.realpathSync('/proc/'+pid+'/exe');
          const mappings=fs.readFileSync('/proc/'+pid+'/maps','utf8');
          assert.equal(path.basename(executable),'pw-cat');
          assert(mappings.includes('libpipewire-0.3.so'),'Source is not a native PipeWire client');
          assert(!mappings.includes('libpulse.so'),'Source unexpectedly uses Pulse');
          entry.nativePlayback={pid,parentPid:appSource.child.pid,executable,executableSha256:sha(executable),nativePipeWireLibrary:true,pulseLibrary:false};save();
        }
        if(appPlaybackBackend==='jack'){
          const mappings=fs.readFileSync('/proc/'+appSource.child.pid+'/maps','utf8');
          assert(mappings.includes('/pipewire-0.3/jack/libjack.so'),'JACK fixture did not load the PipeWire JACK implementation');
          entry.nativePlayback={pid:appSource.child.pid,jackThroughPipeWire:true};save();
        }
      }
      if(jackSystem){
        systemTone.silent=true;
        appSource=await startApp(defaultSink);
        assert(fs.readFileSync('/proc/'+appSource.child.pid+'/maps','utf8').includes('/pipewire-0.3/jack/libjack.so'));
        entry.nativePlayback={pid:appSource.child.pid,jackThroughPipeWire:true};save();
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
      const selectedPortal = async (timeout=10000) => {
        await waitFor(() => portalSelector.exitCode !== null, timeout, 'Portal selection did not finish');
        assert.equal(portalSelector.exitCode, 0); assert(JSON.parse(fs.readFileSync(portalSelector.output)).passed); checkPortalOwner();
      };
      if (wayland && !gui) selectPortal();

      publisher.closed = new Promise(resolve => publisher.once('close', resolve));
      publisher.on('error', error => { entry.launchError = String(error); });
      await waitFor(() => { assert.equal(publisher.exitCode, null, 'Publisher exited at startup'); assert(!entry.launchError); return fs.existsSync(discovery); }, 15000, 'No control discovery');
      control = JSON.parse(fs.readFileSync(discovery)); assert.equal(control.pid, publisher.pid);
      if (wayland && !gui) await waitFor(() => { assert.equal(publisher.exitCode, null); return fs.readFileSync(path.join(report, fixture.name + '-private-publisher.log'), 'utf8').includes('[Headless] Going live'); }, 75000, 'Portal selection/startup did not finish');
      const ui = (...arguments_) => execFileSync('python3', [path.join(__dirname, 'linux-ui-control.py'), String(publisher.pid), ...arguments_], {env, encoding:'utf8', timeout:wayland ? 60000 : 10000, stdio:['ignore', 'pipe', 'pipe']});
      const screenshot = name => wayland ? execFileSync('gnome-screenshot', ['-f', path.join(report,name)], {env,timeout:10000}) :
        execFileSync('python3',['-c','from PIL import ImageGrab; import sys; ImageGrab.grab().save(sys.argv[1])',path.join(report,name)],{env,timeout:10000});
      const captureNodes = () => {
        result.pipewireSnapshots ||= [];
        const output=path.join(report,'pipewire-snapshot-'+result.pipewireSnapshots.length+'.json');
        const {objects,batches}=JSON.parse(execFileSync('python3',[path.join(__dirname,'linux-pipewire-snapshot.py'),'--output='+output],{env,encoding:'utf8',timeout:7000}));
        result.pipewireSnapshots.push({file:path.basename(output),sha256:sha(output),batches});
        const clients = new Set(objects.filter(o => o.type === 'PipeWire:Interface:Client' && String(o.info?.props?.['application.process.id']) === String(publisher.pid)).map(o => o.id));
        return objects.filter(o => o.type === 'PipeWire:Interface:Node' && clients.has(o.info?.props?.['client.id']) && o.info?.props?.['media.type'] === 'Video').map(o => ({id:o.id,serial:o.info.props['object.serial']}));
      };
      const checkAudioWarning = async (pattern, label) => {
        if (!audioWarnings) return;
        await waitFor(async () => {
          const warning = (await api('/diagnostics')).audio.capture_warning;
          assert.equal(typeof warning, 'string', 'Missing structured audio warning');
          const visible = JSON.parse(ui('dump')).filter(row => row.role === 'label' && row.states.includes('visible') && row.name.startsWith('Audio: '));
          entry.audioWarningObservations ||= {};
          entry.audioWarningObservations[label] = {structured:warning,visible:visible.map(row=>row.name)};
          return pattern ? pattern.test(warning) && visible.some(row => pattern.test(row.name)) : warning === '' && visible.length === 0;
        }, 6000, 'Audio warning state/visible notice differs: ' + label);
        entry[label] = true;
      };
      const goLive = async (promotePreview=false) => {
        if (wayland && !promotePreview) selectPortal();
        ui('press', 'Go live');
        await waitFor(async () => (await api('/diagnostics')).app.live, wayland ? 30000 : 15000, 'GUI did not go live');
        if (wayland && !promotePreview) await selectedPortal();
      };
      const launchSaved = async (label, unavailableInput=false) => {
        log=fs.createWriteStream(path.join(report,label+'-private-publisher.log'));
        publisher=spawn(exe,args,{cwd:bundle,env,stdio:['ignore','pipe','pipe']});
        publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
        publisher.closed=new Promise(resolve=>publisher.once('close',resolve));
        publisher.on('error',error=>{entry.recoveryLaunchError=String(error);});
        await waitFor(()=>{assert.equal(publisher.exitCode,null);assert(!entry.recoveryLaunchError);return fs.existsSync(discovery);},15000,'Audio outage relaunch did not publish discovery');
        control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
        const rows=JSON.parse(ui('dump'));
        fs.writeFileSync(path.join(report,label+'-idle-ui.json'),JSON.stringify(rows,null,2));
        screenshot(label+'-idle.png');
        assert(rows.some(row=>row.role==='combo box'&&row.name==='System audio (all apps)'));
        assert(rows.some(row=>row.role==='combo box'&&(unavailableInput?row.name==='Selected input unavailable; choose again':row.name.startsWith('GameCaptureOwnedQAInput'))),'Saved microphone selection was lost on relaunch');
        for(const name of ['Game Audio Gain','Mic Gain'])assert.equal(rows.find(row=>row.role==='spin button'&&row.name===name).value,50);
        const idle=await api('/diagnostics');assert(!idle.app.live&&!idle.app.capturing);
        assert.equal(idle.metrics.audio_packets_sent,0);assert.equal(idle.video.frames_captured,0);
        assert(!idle.app.primary_audio_capturing&&!idle.app.microphone_capturing);
        return idle;
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
        if (apps) ui('choose', wayland ? 'Choose an audio app' : 'Selected X11 window (automatic)', 'GameCaptureOwnedQAApp (PID ' + selectedAppPid(appSource) + ')');
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
        if(previewBeforeLive){
          entry.localPreview={audioRoute:fixture.mode,microphoneConfigured:!!fixture.mix};
          const localOnly=async(active,audioAvailable=true,videoAvailable=true)=>{
            if(previewHelperUnavailable)assert.equal(pactl('get-default-sink'),defaultSink,'Owned default output changed while configuring local preview');
            const d=await api('/diagnostics');
            assert.equal(d.app.window_preview_active,active);
            assert(!d.app.live&&!d.app.capturing&&!d.app.primary_audio_capturing&&!d.app.microphone_capturing,'Preview started publishing or audio capture');
            assert.equal(d.video.frames_sent,0);assert.equal(d.video.frames_captured,0);assert.equal(d.metrics.audio_packets_sent,0);
            const audio=audioAvailable?JSON.parse(pactl('--format=json','list','source-outputs')).filter(s=>String(s.properties?.['application.process.id'])===String(publisher.pid)):null;
            if(audio)assert.equal(audio.length,0,'Preview opened a recording stream with mixed audio configured');
            const nodes=videoAvailable?captureNodes():null;if(nodes)assert.equal(nodes.length,active?1:0);
            return {app:d.app,source:d.source,videoFramesSent:d.video.frames_sent,audioPacketsSent:d.metrics.audio_packets_sent,audioCaptureStreams:audio?.length??null,nodes};
          };
          const previewShot=async(label,identity)=>{
            let sourceIdentity=null;
            if(identity!=='none'){
              sourceIdentity=await source.evaluate(id=>{
                fixture.staticId=id;paint();
                let observed=0;
                for(let bit=0;bit<16;bit++)if(c.getImageData(Math.floor((.2+(bit+.5)*.6/16)*canvas.width),Math.floor(.5*canvas.height),1,1).data[0]>127)observed|=1<<bit;
                return observed;
              },identity);
              assert.equal(sourceIdentity,identity,'Fixture canvas did not render the requested preview identity');
              // The idle/local-preview UI refreshes every 1500 ms. Match the
              // window-preview workflow's 2200 ms observation window.
              await sleep(2200);
            }
            const output=path.join(report,'preview-'+label+'.png');
            const shot=JSON.parse(execFileSync('python3',[path.join(__dirname,'linux-preview-observer.py'),'--pid='+publisher.pid,'--output='+output,'--expected='+identity],{env,encoding:'utf8',timeout:20000}));
            return {...shot,sourceIdentity,screenshotSha256:sha(output)};
          };
          const beginPreview=async()=>{
            selectPortal();ui('press','Preview window');await selectedPortal(30000);
            await waitFor(async()=>(await api('/diagnostics')).app.window_preview_active,10000,'Configured-audio local preview did not start');
            return localOnly(true);
          };
          entry.localPreview.idle=await localOnly(false);
          entry.localPreview.initial=await beginPreview();save();
          entry.localPreview.firstPixels=await previewShot('mixed-first',13735);
          entry.localPreview.changedPixels=await previewShot('mixed-changed',51546);
          entry.localPreview.afterPixels=await localOnly(true);save();
          ui('press','Stop preview');
          await waitFor(async()=>!(await api('/diagnostics')).app.window_preview,10000,'Configured-audio preview did not stop');
          entry.localPreview.stopped=await localOnly(false);
          entry.localPreview.clearedPixels=await previewShot('mixed-stopped','none');
          entry.localPreview.beforePromotion=await beginPreview();
          entry.localPreview.restartedPixels=await previewShot('mixed-restarted',24681);
          entry.localPreview.beforePromotion=await localOnly(true);save();
          if(previewHelperUnavailable){
            const failure=entry.localPreview.unavailableHelper={path:path.join(report,'missing custom helper','ffmpeg')};
            assert(!fs.existsSync(failure.path));
            ui('choose-prefix','H.264 (Compatibility)','VP9 (');
            ui('text','FFmpeg Path',failure.path);
            ui('text','FFmpeg Options','-threads 2');
            failure.before=await localOnly(true);
            ui('press','Go live');
            await waitFor(()=>{
              const rows=JSON.parse(ui('dump'));
              return rows.some(r=>r.role==='label'&&r.states.includes('visible')&&r.name.startsWith('FFmpeg unavailable:'))&&rows.some(r=>r.name==='Go live'&&r.states.includes('sensitive'));
            },15000,'Missing helper did not reject promotion and allow retry');
            failure.after=await localOnly(true);
            assert.deepEqual(failure.after.nodes,failure.before.nodes,'Helper preflight failure replaced the granted preview');
            failure.visibleStatus=JSON.parse(ui('dump')).filter(r=>r.role==='label'&&r.states.includes('visible')&&r.name.startsWith('FFmpeg unavailable:')).map(r=>r.name);
            failure.pixels=await previewShot('helper-unavailable',49106);
            await checkAudioWarning(null,'previewHelperFailureNoAudioWarning');
            fs.writeFileSync(path.join(report,'preview-helper-unavailable-ui.json'),ui('dump'));save();
            ui('text','FFmpeg Path','');
            const selectedCodec=JSON.parse(ui('dump')).find(r=>r.role==='combo box'&&r.name.startsWith('VP9 ('));
            assert(selectedCodec,'Selected VP9 codec control missing after helper failure');
            ui('choose',selectedCodec.name,'H.264 (Compatibility)');
            // Saved VP9 tuning must not leak into native H.264 encoding.
            failure.corrected=await localOnly(true);
            assert.deepEqual(failure.corrected.nodes,failure.before.nodes);
            failure.correctedPixels=await previewShot('helper-corrected',34821);
            failure.portalSelectionsBeforeRetry=selectionNumber;assert.equal(selectionNumber,2);
            entry.localPreview.beforePromotion=failure.corrected;save();
          }
          if(previewServiceLoss){
            const command=action=>JSON.parse(execFileSync('python3',[path.join(__dirname,'linux-private-audio.py'),'--request='+action],{env,encoding:'utf8',timeout:25000}));
            const fault=entry.localPreview.serviceLoss={scope:captureServerLoss?'pipewire':'pulse-only',before:entry.localPreview.beforePromotion};
            const started=Date.now();fault.stop=command('stop');modules.length=0;save();
            for(const source of [systemTone,inputTone]){
              clearInterval(source.timer);source.retired=true;
              await waitFor(()=>source.child.exitCode!==null,6000,'Owned preview tone did not disconnect');
            }
            if(captureServerLoss){
              await waitFor(async()=>!(await api('/diagnostics')).app.window_preview,15000,'Whole PipeWire outage did not retire local preview');
              fault.automaticPreviewStopMs=Date.now()-started;
              fault.during=await localOnly(false,false,false);
              fault.clearedPixels=await previewShot('service-lost','none');
              const rows=JSON.parse(ui('dump'));
              assert(rows.some(r=>r.name==='Preview window'&&r.states.includes('sensitive')),'Preview retry unavailable after service failure');
              assert(rows.some(r=>r.role==='label'&&/preview stopped|window capture stopped/i.test(r.name)),'Preview failure has no stopped status');
              await checkAudioWarning(null,'previewCoreLossNoStaleAudioWarning');
            }else{
              fault.during=await localOnly(true,false);
              assert.deepEqual(fault.during.nodes,fault.before.nodes,'Pulse loss replaced local preview grant');
              fault.pixelsDuringOutage=await previewShot('pulse-down',49106);
              await checkAudioWarning(null,'previewPulseLossNoUnusedInputWarning');
              await source.evaluate(()=>{fixture.staticId=null;});
              await goLive(true);
              const down=await api('/diagnostics');
              assert(!down.app.window_preview&&down.app.live&&down.app.capturing);
              assert(!down.app.primary_audio_capturing&&!down.app.microphone_capturing);
              assert.equal(down.metrics.audio_packets_sent,0);
              fault.promotedWhileDownNodes=captureNodes();
              assert.deepEqual(fault.promotedWhileDownNodes,fault.before.nodes,'Unavailable-audio promotion replaced grant');
              await checkAudioWarning(/(?:Could not connect to the desktop audio service|Desktop audio service is unavailable)/,'previewPromotionAudioUnavailableWarning');
              const silent=await receiver(viewerBrowser,stream,publisher);
              fault.videoWhileAudioDown=await observe(silent,3000);requireMoving(fault.videoWhileAudioDown,'Preview promotion with audio service down');
              assert.equal((await api('/diagnostics')).metrics.audio_packets_sent,0);
              await silent.close();ui('press','Stop streaming');
              await waitFor(async()=>!(await api('/diagnostics')).app.capturing,10000,'Unavailable-audio promotion did not Stop');
              await checkAudioWarning(null,'previewDownStopClearsWarnings');
              fault.stoppedWhileDown=true;
            }
            fs.writeFileSync(path.join(report,'preview-service-down-ui.json'),ui('dump'));screenshot('preview-service-down.png');save();
            if(previewCoreStartupDown){
              const down=fault.startupWhileDown={action:unavailableCoreAction};
              down.quitAction=JSON.parse(ui('quit-menu'));
              await waitFor(()=>publisher.exitCode!==null,8000,'Quit with PipeWire unavailable did not finish');
              await quit();down.firstExitAndDiscoveryRetired=true;
              down.idle=await launchSaved('core-unavailable',true);
              ui('source','Choose a window');
              down.idleLocalOnly=await localOnly(false,false,false);save();
              selectPortal();ui('press',unavailableCoreAction==='preview'?'Preview window':'Go live');
              await selectedPortal(30000);down.permissionSelected=true;
              await waitFor(async()=>{
                const d=await api('/diagnostics');const rows=JSON.parse(ui('dump'));
                return !d.app.window_preview&&!d.app.live&&!d.app.capturing&&rows.some(r=>r.name==='Preview window'&&r.states.includes('sensitive'))&&rows.some(r=>r.name==='Go live'&&r.states.includes('sensitive'));
              },75000,'Capture request with unavailable PipeWire did not settle into retry state');
              down.failedCaptureAttempt=await localOnly(false,false,false);
              const rows=JSON.parse(ui('dump'));down.visibleStatus=rows.filter(r=>r.role==='label'&&r.states.includes('visible')&&/preview|unavailable|failed|PipeWire/i.test(r.name)).map(r=>r.name);
              assert(down.visibleStatus.includes(unavailableCoreAction==='preview'?'Window preview cancelled or unavailable.':'Failed to start capture'),'Unavailable-core request has no failure status');
              await checkAudioWarning(null,'unavailableCorePreviewHasNoAudioWarning');
              down.clearedPixels=await previewShot('core-unavailable','none');
              fs.writeFileSync(path.join(report,'core-unavailable-failed-ui.json'),JSON.stringify(rows,null,2));save();
            }
            fault.start=command('start');
            modules.push(pactl('load-module','module-null-sink','sink_name='+sinkName,'rate=48000','channels=2'));inputModule=createInput();
            systemTone=tone(defaultSink,'owned system after preview fault');inputTone=tone(sinkName,'owned microphone after preview fault');inputTone.frequencies=[1200,1200];
            await sleep(1500);
            // Pulse-only promotion has already published video, so its lifetime
            // video counters need not be zero. Audio must still never have started.
            const restored=await api('/diagnostics');
            assert(!restored.app.live&&!restored.app.capturing&&!restored.app.window_preview);
            assert(!restored.app.primary_audio_capturing&&!restored.app.microphone_capturing);
            assert.equal(restored.metrics.audio_packets_sent,0);assert.equal(captureNodes().length,0);
            assert.equal(JSON.parse(pactl('--format=json','list','source-outputs')).filter(s=>String(s.properties?.['application.process.id'])===String(publisher.pid)).length,0);
            fault.noAutomaticReopen=true;await checkAudioWarning(null,'previewServiceReturnWarningsClear');
            // Diagnostics reset publication counters on a new capture start;
            // retain the original strict pre-publish checks for whole-core loss.
            selectPortal();ui('press','Preview window');await selectedPortal(30000);
            await waitFor(async()=>(await api('/diagnostics')).app.window_preview_active,10000,'Explicit preview retry failed');
            const retry=await api('/diagnostics');assert(!retry.app.live&&!retry.app.capturing&&!retry.app.primary_audio_capturing&&!retry.app.microphone_capturing);
            assert.equal(retry.metrics.audio_packets_sent,0);
            assert.equal(JSON.parse(pactl('--format=json','list','source-outputs')).filter(s=>String(s.properties?.['application.process.id'])===String(publisher.pid)).length,0);
            entry.localPreview.beforePromotion={nodes:captureNodes()};assert.equal(entry.localPreview.beforePromotion.nodes.length,1);
            fault.recoveryPortalSelection=selectionNumber;fault.recoveredPreviewNodes=entry.localPreview.beforePromotion.nodes;
            if(!captureServerLoss)assert.notDeepEqual(fault.recoveredPreviewNodes,fault.before.nodes,'Explicit retry reused retired grant');
            fault.recoveredPixels=await previewShot('service-recovered',34821);save();
          }
          await source.evaluate(()=>{fixture.staticId=null;});
          await goLive(true);
          const promoted=await api('/diagnostics');
          assert(!promoted.app.window_preview&&promoted.app.capturing&&promoted.app.primary_audio_capturing);
          assert.equal(promoted.app.microphone_capturing,!!fixture.mix,'Preview promotion opened an unexpected microphone route');
          entry.localPreview.promotedApp=promoted.app;
          entry.localPreview.promotedNodes=captureNodes();
          assert.deepEqual(entry.localPreview.promotedNodes,entry.localPreview.beforePromotion.nodes,'Go live replaced the granted preview stream');
          entry.localPreview.promotedSameSession=true;save();
        }else await goLive();
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
      const viewer = await receiver(viewerBrowser, stream, publisher,encodedCapture?async page=>{encodedAudio=await require('./linux-encoded-audio').install(page,report);}:undefined);
      if(encodedAudio){result.encodedAudioSelectedId=await encodedAudio.select();save();}
      if(persistentSnapshot){entry.snapshotPrepared=await observeAudio(viewer,null,{reuseContext:true,prepareOnly:true});snapshotPage=viewer;}
      if(continuousApps){entry.continuousObserver=await continuity.start(viewer);continuousPage=viewer;entry.continuous=[];}
      const continuousSample=async(label,settings={})=>{
        if(!continuousApps)return;
        const drainRequestedAtMs=Date.now();
        const batch=await continuity.drain(viewer),file=label+'-continuous.json.gz';
        const drainCompletedAtMs=Date.now();
        fs.writeFileSync(path.join(report,file),require('zlib').gzipSync(JSON.stringify(batch)),{flag:'wx'});
        entry.continuous.push({label,file,sha256:sha(path.join(report,file)),...continuity.analyze(batch,settings),drainRequestedAtMs,drainCompletedAtMs,evidenceSavedAtMs:Date.now()});save();
      };
      entry.video = await observe(viewer, 3000); requireMoving(entry.video, fixture.name + ' video');
      entry.audio = await observeAudio(viewer,null,{reuseContext:persistentSnapshot,traceObserver:continuousApps}); requireAudio(entry.audio, fixture.name, {microphone:fixture.mix, excluded:communications || apps || fixture.name === 'microphone'}); save();
      await continuousSample('initial');
      const diagnostics = await api('/diagnostics'); entry.audioDiagnostics = diagnostics.audio;
      assert.equal(diagnostics.audio.source_mode, fixture.mode);
      if (communications) assert.equal(diagnostics.audio.communications_output_device, 'pulse-output:' + communicationsSink);
      if (gui) await checkAudioWarning(null, 'healthyAudioHasNoWarning');
      assert.equal(diagnostics.audio.configured_opus_bitrate_kbps, 128);
      if (fixture.input) assert(diagnostics.audio.active_microphone_source.includes('GameCaptureOwnedQAInput'));
      if (apps) {
        const sample = async (label, checks) => {
          await sleep(label==='streamRecreated'?resumeSnapshotDelayMs:1200);
          if (automaticApp) { entry[label + 'SourceClock'] = await source.evaluate(() => ({state:audioFixture.state, time:audioFixture.currentTime, baseLatency:audioFixture.baseLatency, outputLatency:audioFixture.outputLatency})); save(); }
          const observation = await observeAudio(viewer,null,{reuseContext:persistentSnapshot,traceObserver:continuousApps});
          entry[label] = observation;
          if(opts['capture-audio-diagnostics']==='true'){
            entry[label+'Diagnostic']={sourceProgress:appSource?await appSource.command({}):null,atMs:Date.now(),diagnostics:await api('/diagnostics'),playback:JSON.parse(pactl('-f','json','list','sink-inputs')),clients:JSON.parse(pactl('-f','json','list','clients'))};
          }
          save();
          try{requireAudio(observation, label, {excluded:true, ...checks});}
          catch(error){
            // Inspect the owned source output before retiring the failed app.
            // A direct monitor can return valid zero PCM after a native stream
            // moves; this separate sink recording distinguishes that from a
            // source/graph outage. Never open a host desktop monitor here.
            if(nativeDirectSelection&&label.startsWith('outputMoved')&&opts['capture-audio-diagnostics']==='true'&&process.env.GC_QA_AUDIO_SOCKET){
              try{
                const destination=entry.outputMoves.at(-1).destination;
                assert(destination===sinkName||destination==='gc_audio_default');
                const graph=path.join(report,label+'-pipewire-graph.json');
                fs.writeFileSync(graph,execFileSync('pw-dump',[],{timeout:5000,maxBuffer:16*1024*1024}),{flag:'wx',mode:0o600});
                entry[label+'PipeWireGraph']={path:path.basename(graph),sha256:sha(graph)};
                const recordOutput=async suffix=>{
                  const before=await appSource.command({});
                  const {stdout:raw}=await execFileAsync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','pulse','-i',destination+'.monitor','-t','2','-ar','48000','-ac','2','-c:a','pcm_f32le','-f','f32le','pipe:1'],{timeout:10000,maxBuffer:4*1024*1024,encoding:'buffer'});
                  const after=await appSource.command({});
                  assert(raw.length>=48000*8&&raw.length%8===0);
                  const file=path.join(report,label+suffix+'-owned-output.f32le');fs.writeFileSync(file,raw,{flag:'wx',mode:0o600});
                  const frames=raw.length/8,channels=[];
                  for(let channel=0;channel<2;channel++){
                    let power=0;const tones={};
                    for(let n=0;n<frames;n++)power+=raw.readFloatLE(n*8+channel*4)**2;
                    for(const hz of [440,880,2000]){
                      let re=0,im=0;
                      for(let n=0;n<frames;n++){const value=raw.readFloatLE(n*8+channel*4),angle=2*Math.PI*hz*n/48000;re+=value*Math.cos(angle);im+=value*Math.sin(angle);}
                      tones[hz]=2*Math.hypot(re,im)/frames;
                    }
                    channels.push({rms:Math.sqrt(power/frames),toneAmplitudes:tones});
                  }
                  entry[label+suffix+'SourceOutput']={sourceBefore:before,sourceAfter:after,path:path.basename(file),sha256:sha(file),destination,frames,channels,scope:'Independent recording of the owned virtual output after the failed receiver check; not physical timing or uninterrupted capture evidence.'};
                  save();
                };
                await recordOutput('');
                entry[label+'AfterReferenceDiagnostic']=await api('/diagnostics');
                await quit();
                entry[label+'CaptureRetiredAtMs']=Date.now();save();
                await sleep(1200);
                await recordOutput('AfterCaptureQuit');
              }catch(referenceError){entry[label+'SourceOutputError']=String(referenceError);}
              save();
            }
            throw error;
          }
          // Prepare recording while the source is intentionally silent, before
          // the drain starts the resume phase. All continuous rows are retained.
          if(label==='noStreams'&&resumeRecording){receiverRecording=await require('./macos-continuous-audio').record(viewer,path.join(report,'resume-receiver.webm'));result.resumeReceiverRecording=receiverRecording.metadata;save();}
          await continuousSample(label,{silent:!!checks.silent,transition:label==='noStreams'||label==='streamRecreated'});
        };
        if (automaticApp) {
          await source.evaluate(() => audioFixture.suspend()); await sample('automaticAppSilent', {silent:true});
          await source.evaluate(() => audioFixture.resume()); await sample('automaticAppResumed', {microphoneOff:true});
          const late = await receiver(viewerBrowser, stream, publisher);
          entry.lateAudio = await observeAudio(late); requireAudio(entry.lateAudio, 'Automatic app late viewer', {excluded:true});
          await late.close();
        } else {
        if(nativeDirectSelection){
          await appSource.command({silent:true}); await sample('nativeSilent',{silent:true});
          await appSource.command({silent:false}); await sample('nativeResumed',{microphoneOff:true});
          await appSource.command({extra:true}); await sample('unselectedNativeSiblingExcluded',{microphoneOff:true});
          await appSource.command({extra:false});
        }else{
        await appSource.command({child:true}); await sample('childJoined', {microphone:true});
        await appSource.command({child:false}); await sample('childRemoved', {microphoneOff:true});
        await appSource.command({extra:true}); await sample(appPlaybackBackend==='pipewire'?'secondNativeChildStream':'secondStreamSameProcess', {microphone:true});
        await appSource.command({extra:false});
        if(playoutReference){
          result.receiverMediaElements=await viewer.evaluate(()=>[...document.querySelectorAll('video,audio')].map(e=>({tag:e.tagName,muted:e.muted,volume:e.volume,paused:e.paused,readyState:e.readyState,audioTracks:e.srcObject?.getAudioTracks().map(t=>({enabled:t.enabled,muted:t.muted,readyState:t.readyState}))})));
          assert(result.receiverMediaElements.some(e=>!e.muted&&!e.paused&&e.volume>0&&e.audioTracks?.some(t=>t.enabled&&t.readyState==='live')),'Receiver has no playing unmuted media element');
          playout=await require('./linux-app-audio-reference').startPlayout(report,receiverSink);save();
        }
        await sample('secondStreamRemoved', {microphoneOff:true});
        if(playoutReference)result.sourcePause={requestedAtMs:Date.now()};
        await appSource.command({primary:false});
        if(playoutReference){result.sourcePause.completedAtMs=Date.now();save();}
        await sample('noStreams', {silent:true});
        if(playoutReference)result.sourceResume={requestedAtMs:Date.now()};
        await appSource.command({primary:true});
        if(playoutReference){result.sourceResume.completedAtMs=Date.now();save();}
        if(resumeReference)sourceReference=await appReference.start(report,appSource.child.pid);
        await sample('streamRecreated', {microphoneOff:true});
        if(playout){
          result.receiverPlayout=await playout.stop();playout=null;save();
          execFileSync('python3',[path.join(report,'linux-playout-audio-report.py'),report],{encoding:'utf8',timeout:30000});
          result.receiverPlayoutAnalysis={path:'receiver-playout-analysis.json',sha256:sha(path.join(report,'receiver-playout-analysis.json'))};save();
        }
        if(receiverRecording){await receiverRecording.stop();receiverRecording=null;save();}
        if(sourceReference){
          result.resumeSource=await sourceReference.stop();sourceReference=null;
          execFileSync('python3',[path.join(report,'linux-audio-reference-report.py'),report],{encoding:'utf8',timeout:30000});
          result.resumeSourceAnalysis={path:'resume-source-analysis.json',sha256:sha(path.join(report,'resume-source-analysis.json'))};save();
        }
        if(resumeRecording){
          execFileSync('python3',[path.join(report,'linux-received-audio-report.py'),report],{encoding:'utf8',timeout:40000});
          result.resumeReceiverAnalysis={path:'resume-receiver-analysis.json',sha256:sha(path.join(report,'resume-receiver-analysis.json'))};save();
        }
        }
        entry.outputMoves=[];
        for(let move=0;move<appOutputMoves;move++) {
          const nativeClients=appPlaybackBackend!=='pulse'?JSON.parse(pactl('-f','json','list','clients')).filter(row=>Number(row.properties['application.process.id'])===appSource.playbackPid).map(row=>Number(row.index)):[];
          const playback = JSON.parse(pactl('-f', 'json', 'list', 'sink-inputs')).filter(row => appPlaybackBackend!=='pulse'?nativeClients.includes(Number(row.client)):Number(row.properties['application.process.id']) === appSource.child.pid);
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
        if(encodedAudio){
          result.encodedAudio=await encodedAudio.stop();encodedAudio=null;save();
          execFileSync('python3',[path.join(report,'linux-decode-opus-report.py'),report],{encoding:'utf8',timeout:30000});
          const file=path.join(report,'received-opus-analysis.json'),analysis=JSON.parse(fs.readFileSync(file));
          result.encodedAudioAnalysis={path:path.basename(file),sha256:sha(file),resumeLevelChecksPassed:analysis.resumeLevelChecksPassed};save();
          assert.equal(analysis.rtpDiscontinuities.length,0,'Incoming encoded audio has RTP timestamp discontinuities');
        }
        if(continuousPage){await continuity.stop(continuousPage);continuousPage=null;}
        if(snapshotPage){await closeAudioObserver(snapshotPage);snapshotPage=null;entry.snapshotObserverClosed=true;}
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
        requireAudio(entry.muted, fixture.name + ' GUI mute', {silent:!fixture.mix, microphoneOff:fixture.mix, excluded:communications});
        entry.videoWhileMuted = await observe(viewer, 3000); requireMoving(entry.videoWhileMuted, 'GUI mute preserves video');
        ui('press', 'Unmute microphone'); await sleep(800);
        assert.equal((await api('/diagnostics')).audio.microphone_muted, false);
        entry.unmuted = await observeAudio(viewer); requireAudio(entry.unmuted, 'GUI unmute', {microphone:fixture.mix, excluded:communications || !fixture.mix});
      }
      if (gui && fixture.mix) {
        assert.equal(diagnostics.audio.primary_gain, .5); assert.equal(diagnostics.audio.additional_gain, .5);
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        entry.mixedRmsAtHalfGain = median(entry.audio.spectra.map(sample => sample.rms));
        assert(entry.mixedRmsAtHalfGain > .025 && entry.mixedRmsAtHalfGain < .095, 'Decoded half-gain mix level is outside fixture bounds');
      }
      systemTone.silent = inputTone.silent = true; if (communicationsTone) communicationsTone.silent = true;
      if(jackSystem)await appSource.command({silent:true});
      await sleep(1000);
      entry.silence = await observeAudio(viewer); requireAudio(entry.silence, fixture.name + ' silence', {silent:true});
      systemTone.silent = inputTone.silent = false; if (communicationsTone) communicationsTone.silent = false;
      if(jackSystem){systemTone.silent=true;await appSource.command({silent:false});}
      await sleep(1000);
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
      if (audioServerLoss && !previewServiceLoss) {
        const command = action => JSON.parse(execFileSync('python3',[path.join(__dirname,'linux-private-audio.py'),'--request='+action],{env,encoding:'utf8',timeout:25000}));
        const nodesBeforeFault = wayland ? captureNodes() : null;
        if(wayland)assert.equal(nodesBeforeFault.length,1,'Missing portal video stream before service fault');
        const faultStarted = Date.now();
        entry.serverLoss = {nodesBeforeFault,stop:command('stop')}; modules.length=0; save();
        for(const source of [systemTone,inputTone]){
          clearInterval(source.timer); source.retired=true;
          await waitFor(()=>source.child.exitCode!==null,6000,'Owned tone did not disconnect with the audio server');
        }
        await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.primary_audio_capturing&&!d.app.microphone_capturing&&d.audio.active_microphone_source==='none';},10000,'Audio capture stayed active after server loss');
        if(captureServerLoss){
          await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.live&&!d.app.capturing;},15000,'PipeWire outage did not retire video capture');
          entry.serverLoss.automaticCaptureStopMs=Date.now()-faultStarted;
          const rows=JSON.parse(ui('dump'));
          assert(rows.some(r=>r.role==='label'&&/window capture stopped/i.test(r.name)),'Missing capture-service loss status');
          assert(rows.some(r=>r.name==='Go live'&&r.states.includes('sensitive')),'Capture-service loss did not enable retry');
          const before=await api('/diagnostics');await sleep(1200);const after=await api('/diagnostics');
          assert.equal(before.video.frames_captured,after.video.frames_captured,'Frames continue after capture-service loss');
          assert.equal(before.metrics.audio_packets_sent,after.metrics.audio_packets_sent,'Audio packets continue after capture-service loss');
          entry.serverLoss.automaticCaptureStop=true;entry.serverLoss.audioPacketsSettled=true;
          fs.writeFileSync(path.join(report,'capture-service-lost-ui.json'),JSON.stringify(rows,null,2));
          screenshot('capture-service-lost.png');
          await checkAudioWarning(null,'captureLossClearedAudioWarnings');save();
        }else{
        await checkAudioWarning(/Primary audio stopped[\s\S]*Microphone\/input stopped/,'serverLossWarnings');
        }
        fs.writeFileSync(path.join(report,'server-loss-ui.json'),ui('dump'));
        screenshot('server-loss-warning.png');
        if(!captureServerLoss){
        entry.serverLoss.video = await observe(viewer,3000); requireMoving(entry.serverLoss.video,'Video continues while the audio server is down');
        const before=await api('/diagnostics');await sleep(1200);const after=await api('/diagnostics');
        assert(after.app.live&&after.app.capturing);assert.equal(before.metrics.audio_packets_sent,after.metrics.audio_packets_sent,'Audio packets continue after both inputs stopped');
        entry.serverLoss.audioPacketsSettled=true;
        if(wayland){
          entry.serverLoss.nodesDuringOutage=captureNodes();
          assert.deepEqual(entry.serverLoss.nodesDuringOutage,nodesBeforeFault,'Audio-only outage replaced the granted video stream');
        }
        }
        if(audioServerStopDown){
          const started=Date.now();ui('press','Stop streaming');
          await waitFor(async()=>{const d=await api('/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'Stop did not finish while the audio server was down');
          entry.serverLoss.stopWhileDownMs=Date.now()-started;
          await checkAudioWarning(null,'serverDownStopClearedWarnings');
        }
        if(audioServerQuitDown){
          const started=Date.now();
          entry.serverLoss.quitAction=JSON.parse(ui('quit-menu'));
          await waitFor(()=>publisher.exitCode!==null,8000,'File-menu Quit did not finish while the audio server was down');
          entry.serverLoss.quitWhileDownMs=Date.now()-started;
          entry.serverLoss.quitExitCode=publisher.exitCode;
          await quit(); // Verify exit, discovery retirement and close the log.
          entry.serverLoss.discoveryRetired=true;save();
        }
        if(audioServerStartupDown){
          entry.serverLoss.unavailableStartupIdle=await launchSaved('server-unavailable',true);
          ui('source',wayland?'Choose a window':title);await goLive();
          await checkAudioWarning(/(?:Could not connect to the desktop audio service|Desktop audio service is unavailable)/,'startupServerWarningVisible');
          const unavailable=await receiver(viewerBrowser,stream,publisher);
          entry.serverLoss.unavailableStartupVideo=await observe(unavailable,3000);requireMoving(entry.serverLoss.unavailableStartupVideo,'Video with audio server unavailable at launch');
          const state=await api('/diagnostics');assert(!state.app.primary_audio_capturing&&!state.app.microphone_capturing);assert.equal(state.metrics.audio_packets_sent,0);
          fs.writeFileSync(path.join(report,'server-unavailable-live-ui.json'),ui('dump'));
          screenshot('server-unavailable-live.png');
          const started=Date.now();ui('quit-menu');await waitFor(()=>publisher.exitCode!==null,8000,'Quit after unavailable-server startup did not finish');
          entry.serverLoss.unavailableStartupQuitMs=Date.now()-started;await quit();await unavailable.close();save();
        }
        entry.serverLoss.start=command('start');
        modules.push(pactl('load-module','module-null-sink','sink_name='+sinkName,'rate=48000','channels=2'));inputModule=createInput();
        systemTone=tone(defaultSink,'owned system after server restart');inputTone=tone(sinkName,'owned microphone after server restart');inputTone.frequencies=[1200,1200];
        await sleep(1500);
        if(audioServerQuitDown){
          await launchSaved('server-recovery');
          entry.serverLoss.settingsRestoredIdle=true;
          ui('source',wayland?'Choose a window':title);
        }
        const restored=await api('/diagnostics');assert(!restored.app.primary_audio_capturing&&!restored.app.microphone_capturing);
        assert.equal(JSON.parse(pactl('--format=json','list','source-outputs')).filter(s=>String(s.properties?.['application.process.id'])===String(publisher.pid)).length,0,'Audio silently reopened after server restart');
        if(captureServerLoss){
          entry.serverLoss.nodesAfterServiceReturn=captureNodes();assert.equal(entry.serverLoss.nodesAfterServiceReturn.length,0,'Video silently reopened after PipeWire restart');
          assert(!restored.app.live&&!restored.app.capturing);entry.serverLoss.noAutomaticVideoReopen=true;
        }
        await checkAudioWarning(captureServerLoss||audioServerStopDown||audioServerQuitDown?null:/Primary audio stopped[\s\S]*Microphone\/input stopped/,'serverReturnWarnings');
        entry.serverLoss.noAutomaticReopen=true;save();
      }
      await late.close(); await viewer.close();
      }
      if (gui) {
        if(previewServiceLoss||(!audioServerStopDown&&!audioServerQuitDown&&!captureServerLoss))ui('press', 'Stop streaming');
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
      if (audioServerLoss && !previewServiceLoss) {
        await goLive();
        const restarted=await receiver(viewerBrowser,stream,publisher);
        entry.serverLoss.restartedVideo=await observe(restarted,3000);requireMoving(entry.serverLoss.restartedVideo,'Video after explicit audio server recovery');
        entry.serverLoss.restartedAudio=await observeAudio(restarted);requireAudio(entry.serverLoss.restartedAudio,'Both audio sources after explicit restart',{microphone:true});
        await checkAudioWarning(null,'serverRecoveryWarningsCleared');
        await restarted.close();ui('press','Stop streaming');
        await waitFor(async()=>!(await api('/diagnostics')).app.capturing,10000,'Recovered stream did not stop');
        entry.serverLoss.explicitRestartPassed=true;save();
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
        ui('choose', stale.name, 'GameCaptureOwnedQAApp (PID ' + selectedAppPid(appSource) + ')');
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
      if(playoutReference)assert(JSON.parse(fs.readFileSync(path.join(report,'receiver-playout-analysis.json'))).passedAfterTransitions,'Receiver playout content failed');
      entry.passed = true; save();
    }
    for (const source of tones.filter(source => !source.retired)) { assert.equal(source.child.exitCode, null); assert(!source.error, source.error); }
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if(continuousPage)try{await continuity.stop(continuousPage);continuousPage=null;}catch(error){result.continuousCleanupError=String(error);result.passed=false;process.exitCode=1;}
    if(snapshotPage)try{await closeAudioObserver(snapshotPage);snapshotPage=null;}catch(error){result.snapshotCleanupError=String(error);result.passed=false;process.exitCode=1;}
    if(sourceReference)try{await sourceReference.stop();sourceReference=null;}catch(error){result.sourceReferenceCleanupError=String(error);result.passed=false;process.exitCode=1;}
    if(receiverRecording)try{await receiverRecording.stop();receiverRecording=null;}catch(error){result.receiverRecordingCleanupError=String(error);result.passed=false;process.exitCode=1;}
    if(encodedAudio)try{result.encodedAudio=await encodedAudio.stop();encodedAudio=null;}catch(error){result.encodedAudioCleanupError=String(error);result.passed=false;process.exitCode=1;}
    if(playout)try{result.receiverPlayout=await playout.stop();playout=null;}catch(error){result.playoutCleanupError=String(error);result.passed=false;process.exitCode=1;}
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
