#!/usr/bin/env node
'use strict';
// Packaged Mac publisher -> ScreenCaptureKit window -> VDO.Ninja browser.
// Captures only this script's generated fixture, never an arbitrary desktop window.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {gzipSync} = require('node:zlib');
const {spawn, execFileSync} = require('child_process');
const {chromium} = require('playwright');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)];
}));
if (process.platform !== 'darwin' || !opts.app || !opts.reports)
  throw Error('Use --app=/path/Game Capture.app --reports=/path/reports on macOS');
const app = path.resolve(opts.app), executable = path.join(app, 'Contents/MacOS/game-capture');
if (!fs.existsSync(path.join(app, 'Contents/Frameworks'))) throw Error('Use a deployed app bundle');
const report = path.resolve(opts.reports, crypto.randomUUID());
fs.mkdirSync(report, {recursive:true});
const {sleep, waitFor, receiver, observe, observeDecoded, requireMoving: requireCodecMoving, observeAudio} = require('./macos-media-receiver');
const {exerciseWindowSuspension} = require('./macos-window-suspension');
const continuousAudio = require('./macos-continuous-audio');
const codec = opts.codec || 'h264';
if (!['h264','h265','vp9','av1'].includes(codec) || (codec === 'h265' && (opts.encoder !== 'videotoolbox' || opts.gui)))
  throw Error('HEVC workflow requires --codec=h265 --encoder=videotoolbox without --gui');
if (['vp9','av1'].includes(codec) && (opts.encoder !== 'software' || opts.gui))
  throw Error('VP9/AV1 workflow requires --encoder=software without --gui');
const requireMoving = (observation, label) => requireCodecMoving(observation, label, 'video/' + codec);
const children = new Set(), browsers = new Set();
const audioRecordings = new Set();
let interference,interferenceError,stoppingFixtures=false;
const audioMode = opts.audio || 'none';
const windowSuspension = opts['window-suspension'] === 'true';
if (opts['window-suspension'] && !['true','false'].includes(opts['window-suspension'])) throw Error('--window-suspension must be true or false');
if (windowSuspension && (audioMode !== 'selected-window' || opts.gui)) throw Error('Window suspension workflow requires selected-window audio and CLI publishing');
if (!['none', 'selected-window', 'default-output', 'default-microphone'].includes(audioMode)) throw Error('Use --audio=none, --audio=selected-window, or --audio=default-output');
const includeMic = opts['include-microphone'] === 'true';
const usesMic = includeMic || audioMode === 'default-microphone';
const mixedMic = includeMic && ['selected-window','default-output'].includes(audioMode);
const performanceSeconds = Number(opts['performance-seconds'] || 0);
const collectPerformanceFailures = opts['collect-performance-failures'] === 'true';
if (opts['collect-performance-failures'] && (!['true','false'].includes(opts['collect-performance-failures']) || !performanceSeconds))
  throw Error('--collect-performance-failures must be true or false and requires a timed observation');
const continuousAudioEnabled = opts['continuous-audio'] === 'true';
if (opts['continuous-audio'] && !['true','false'].includes(opts['continuous-audio']))
  throw Error('--continuous-audio must be true or false');
if (continuousAudioEnabled && (!performanceSeconds || audioMode !== 'selected-window' || usesMic))
  throw Error('--continuous-audio requires timed selected-window audio without additional microphone mixing');
if (!Number.isInteger(performanceSeconds) || (performanceSeconds && (performanceSeconds < 10 || performanceSeconds > 1800)))
  throw Error('--performance-seconds must be 10..1800');
const fixtureStartId = Number(opts['fixture-start-id'] || 0);
const motionPattern = opts['motion-pattern'] || 'bars';
if (!['bars','tiles'].includes(motionPattern)) throw Error('--motion-pattern must be bars or tiles');
if (!Number.isInteger(fixtureStartId) || fixtureStartId < 0 || fixtureStartId > 65535 || (opts['fixture-start-id'] && !performanceSeconds))
  throw Error('--fixture-start-id must be 0..65535 and requires a timed performance observation');
const compactPerformanceReport = opts['compact-performance-report'] === 'true';
if (opts['compact-performance-report'] && !['true','false'].includes(opts['compact-performance-report']))
  throw Error('--compact-performance-report must be true or false');
if (compactPerformanceReport && !performanceSeconds)
  throw Error('--compact-performance-report requires a timed performance observation');
const width = Number(opts.width || (performanceSeconds ? 1280 : 640));
const height = Number(opts.height || (performanceSeconds ? 720 : 360));
const fps = Number(opts.fps || (performanceSeconds ? 60 : 30));
const bitrate = Number(opts['bitrate-kbps'] || (performanceSeconds ? 4000 : 1500));
if (![width,height,fps,bitrate].every(Number.isInteger) || width<320 || width>3840 || height<180 || height>2160 || width%2 || height%2 || fps<1 || fps>120 || bitrate<100 || bitrate>100000)
  throw Error('Invalid width, height, fps or bitrate-kbps');
if (performanceSeconds && opts.gui) throw Error('Performance measurement requires the explicit headless publisher configuration');
if (usesMic && (!opts['microphone-device'] || !opts['tone-helper']))
  throw Error('Microphone workflow requires an explicit existing BlackHole --microphone-device and compiled --tone-helper');
if (opts.gui && (!opts['ui-helper'] || !mixedMic || opts.encoder !== 'videotoolbox' || opts['missing-input']))
  throw Error('GUI workflow uses the default VT encoder and requires --encoder=videotoolbox, --ui-helper and a mixed BlackHole input');
const result = {receiverHarnessSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'macos-media-receiver.js'))).digest('hex'), harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), gui:!!opts.gui, microphoneDevice:opts['microphone-device'] || null, includeMic, missingInput:!!opts['missing-input'], lateAudioStart:!!opts['late-audio'], scope:'Packaged Mac window video with ' + audioMode + ' audio; release qualification excluded',
  executableSha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), cases:[], passed:false};
result.requested = {codec,width,height,fps,bitrateKbps:bitrate,performanceSeconds,windowSuspension};
result.requested.motionPattern = motionPattern;
if (continuousAudioEnabled) result.requested.continuousAudio = true;
if (collectPerformanceFailures) result.requested.collectPerformanceFailures = true;
if (opts['fixture-start-id']) result.requested.fixtureStartId = fixtureStartId;
if (compactPerformanceReport) result.requested.compactPerformanceReport = true;
result.hardware = {cpu:execFileSync('/usr/sbin/sysctl',['-n','machdep.cpu.brand_string'],{encoding:'utf8'}).trim(),
  memoryBytes:Number(execFileSync('/usr/sbin/sysctl',['-n','hw.memsize'],{encoding:'utf8'}).trim())};
for (const name of ['macos-window-publish.js','macos-media-receiver.js','macos-window-suspension.js','macos-continuous-audio.js']) fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
result.continuousAudioHarnessSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'macos-continuous-audio.js'))).digest('hex');
result.suspensionHarnessSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'macos-window-suspension.js'))).digest('hex');

async function api(control, route, body) {
  const response = await fetch(control.base_url + route, {method:body ? 'POST' : 'GET',
    headers:{Authorization:'Bearer ' + control.token, 'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(5000)});
  const json = await response.json();
  if (!response.ok) throw Error(JSON.stringify(json));
  return json;
}

function requireAudio(observation, silent = false, micSilent = false) {
  if (interferenceError) throw interferenceError;
  if (interference && (interference.exitCode !== null || interference.signalCode))
    throw Error('The controlled interfering audio fixture stopped before audio observation completed');
  if (!observation.tracks.some(t => (/audio\/opus/i.test(t.codec) || (/audio\/red/i.test(t.codec) && t.negotiatedCodecs.some(c => /audio\/opus/i.test(c.mimeType)))) && t.packetsReceived > 20))
    throw Error('Receiver did not receive Opus packets');
  if (silent) {
    const quiet = observation.spectra.filter(s => audioMode === 'default-output'
      ? s.tone440 < -65 && s.tone880 < -65 && s.excluded2000 > -65 : s.rms < .0005);
    if (quiet.length < 25) throw Error('Silenced source still contains unexpected audio');
    return;
  }
  if (mixedMic) {
    const mic = observation.spectra.filter(s => micSilent || opts['missing-input'] ? s.microphone1200 < -70 : s.microphone1200 > -65);
    if (mic.length < 25) throw Error('Additional microphone tone does not match requested routing');
  }
  const stereo = observation.spectra.filter(s => s.channels[0].tone440 > s.channels[0].tone880 + 20 &&
    s.channels[1].tone880 > s.channels[1].tone440 + 20);
  if (stereo.length < 25) throw Error('Received channels are swapped or mixed to mono');
  const good = observation.spectra.filter(s => s.tone440 > -65 && s.tone880 > -65 &&
    (audioMode === 'default-output' ? s.excluded2000 > -65 : s.excluded2000 < Math.min(s.tone440, s.tone880) - 25) && s.rms > .001);
  if (good.length < 25) throw Error('Audio tones do not match the selected source mode: ' + JSON.stringify(observation.spectra));
}
function interferenceWav() {
  const rate=48000, frames=rate*30, data=Buffer.alloc(44+frames*2);
  data.write('RIFF'); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(rate,24); data.writeUInt32LE(rate*2,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34);
  data.write('data',36); data.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++) data.writeInt16LE(Math.round(1500*Math.sin(2*Math.PI*2000*i/rate)),44+i*2);
  const file=path.join(report,'other-app-2000Hz.wav'); fs.writeFileSync(file,data); return file;
}
function startInterference(file) {
  if (stoppingFixtures) return;
  const began=Date.now(),noise=interference=spawn('/usr/bin/afplay',[file],{stdio:'ignore'});
  result.interferenceLaunches=(result.interferenceLaunches||0)+1;
  children.add(noise);
  noise.on('error',error=>{interferenceError=error;});
  noise.on('exit',(code,signal)=>{
    children.delete(noise);
    if (stoppingFixtures) return;
    if(code===0&&!signal&&Date.now()-began>=25000)startInterference(file);
    else interferenceError=Error('Controlled interfering audio exited unexpectedly');
  });
}

function saveReport() {
  const temporary = path.join(report,'results.pending.json');
  fs.writeFileSync(temporary,JSON.stringify(result,null,2));
  fs.renameSync(temporary,path.join(report,'results.json'));
}

(async () => {
  console.log('Reports: ' + report);
  try {
    if (performanceSeconds >= 600) {
      const disk = fs.statfsSync(report);
      result.initialAvailableBytes = disk.bavail * disk.bsize;
      if (result.initialAvailableBytes < 512 * 1024 * 1024)
        throw Error('Endurance requires at least 512 MiB free before launching its fixtures');
    }
    const sourceBrowser = await chromium.launch({headless:false, args:[
      '--autoplay-policy=no-user-gesture-required', '--window-position=80,80', '--window-size=1000,700', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']});
    browsers.add(sourceBrowser);
    const source = await sourceBrowser.newPage({viewport:performanceSeconds?{width,height}:{width:960,height:540}, deviceScaleFactor:1});
    const title = 'Mac Capture Fixture ' + crypto.randomBytes(6).toString('hex');
    await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><canvas></canvas>
      <script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
      window.fixture={paused:false,id:${fixtureStartId},trace:[],record:false};const origin=performance.now();
      function draw(){
        canvas.width=innerWidth;canvas.height=innerHeight;
        // The performance source changes identity once per actual draw. Time
        // bucket rounding can repeat IDs despite a perfectly steady rAF loop.
        if(!fixture.paused)fixture.id=${performanceSeconds?'(fixture.id+1)%65536':`Math.floor((performance.now()-origin)*${fps}/1000)%65536`};
        if(fixture.record)fixture.trace.push({id:fixture.id,time:performance.timeOrigin+performance.now()});
        const w=canvas.width,h=canvas.height;
        ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);
        if(${motionPattern === 'tiles'}) {
          // Deterministic moving detail increases capture/encoder load without
          // changing the identity strip or reading any user's desktop content.
          const shift=fixture.id*3%64;
          for(let y=-32;y<h+32;y+=32)for(let x=-64;x<w+64;x+=32) {
            const light=((x/32+y/32)%2+2)%2;
            ctx.fillStyle=light?'#908060':'#304050';
            ctx.fillRect(x+shift,y+(fixture.id%32),30,30);
          }
        }
        ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);
        ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
        for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
        ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('Controlled Mac capture fixture: '+fixture.id,30,.9*h);
        requestAnimationFrame(draw);
      }draw();</script>`);
    const startFixtureAudio = () => source.evaluate(async () => {
        if (window.fixtureAudio) return;
        const context = window.fixtureAudio = new AudioContext({sampleRate:48000});
        const merger = context.createChannelMerger(2); merger.connect(context.destination);
        window.fixtureGains = [];
        for (const [channel,hz] of [440,880].entries()) {
          const tone = context.createOscillator(), gain = context.createGain();
          tone.frequency.value = hz; gain.gain.value = .04;
          tone.connect(gain); gain.connect(merger,0,channel); fixtureGains.push(gain); tone.start();
        }
        await context.resume();
      });
    let micTone;
    if (usesMic) {
      micTone = spawn(path.resolve(opts['tone-helper']),[opts['microphone-device'],mixedMic ? '1200' : '440',mixedMic ? '1200' : '880'],{stdio:['pipe','pipe','pipe']});
      children.add(micTone); micTone.on('exit',() => children.delete(micTone));
      let ready = '', errors = ''; micTone.stdout.on('data',data => { ready += data; }); micTone.stderr.on('data',data => { errors += data; });
      await waitFor(() => { if (micTone.exitCode !== null) throw Error('Tone fixture failed: ' + errors); return ready.includes('READY'); },5000,'Virtual input tone did not start');
    }
    const setFixtureSound = async enabled => {
      await source.evaluate(enabled => window.fixtureGains?.forEach(gain => { gain.gain.value = enabled ? .04 : 0; }), enabled);
      if (micTone) micTone.stdin.write(enabled ? 'sound\n' : 'silence\n');
    };
    if (audioMode !== 'none' || usesMic) {
      if (!opts['late-audio'] && audioMode !== 'default-microphone' && audioMode !== 'none') await startFixtureAudio();
      // Restart a small owned clip so long runs never silently lose their
      // interfering source or allocate a multi-gigabyte fixture recording.
      startInterference(interferenceWav());
    }
    await source.bringToFront(); await sleep(1000);
    if (opts['source-ui-helper']) {
      const session=await sourceBrowser.newBrowserCDPSession();
      const processes=await session.send('SystemInfo.getProcessInfo');
      const ownedBrowser=processes.processInfo.find(p=>p.type==='browser');
      if(!ownedBrowser||!Number.isInteger(ownedBrowser.id))throw Error('Owned source browser PID unavailable');
      const command=execFileSync('/bin/ps',['-p',String(ownedBrowser.id),'-o','command='],{encoding:'utf8'});
      const profile=command.match(/--user-data-dir=(\S+)/)?.[1];
      const browserExecutable=chromium.executablePath(),bundleAt=browserExecutable.indexOf('.app/Contents/MacOS/');
      if(!profile||!profile.includes('/playwright_chromiumdev_profile-')||bundleAt<0)
        throw Error('Cannot bind Launch Services activation to the owned source profile');
      execFileSync('/usr/bin/open',['-a',browserExecutable.slice(0,bundleAt+4),'--args','--user-data-dir='+profile],{timeout:5000});
      await sleep(500);await source.bringToFront();
      execFileSync(path.resolve(opts['source-ui-helper']),[String(ownedBrowser.id),'activate'],{timeout:5000});
      result.sourceActivation={pid:ownedBrowser.id,helperSha256:crypto.createHash('sha256').update(fs.readFileSync(path.resolve(opts['source-ui-helper']))).digest('hex')};
      await session.detach();await sleep(1000);
    }
    await source.screenshot({path:path.join(report,'source.png')});
    const viewerBrowser = await chromium.launch({headless:true,...(opts['receiver-executable'] ? {executablePath:path.resolve(opts['receiver-executable'])} : {}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
    browsers.add(viewerBrowser);
    result.browserVersions={source:sourceBrowser.version(),receiver:viewerBrowser.version()};
    const encoders = opts.encoder ? [opts.encoder] : ['videotoolbox','x264'];
    if (encoders.some(value => !['videotoolbox','x264','software'].includes(value))) throw Error('Unknown encoder');
    for (const encoder of encoders) {
      const entry = {encoder, passed:false}; result.cases.push(entry);
      const stream = 'macdev' + crypto.randomBytes(12).toString('hex');
      const remoteToken = crypto.randomBytes(24).toString('hex');
      const discovery = path.join(report, encoder + '-control.json');
      const diagnostics = path.join(report, encoder + '-diagnostics.json');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(QT_|DYLD_|GAME_CAPTURE_)/.test(key)));
      const child = spawn(executable, [...(opts.gui ? ['--temporary-settings'] : ['--headless']), `--stream=${stream}`, '--password=false',
        `--window=${title}`, `--video-encoder=${encoder}`, `--video-codec=${codec}`, `--audio-source=${audioMode}`,
        ...(usesMic ? [`--microphone-device=${opts['missing-input'] ? 'game-capture-missing-input' : opts['microphone-device']}`] : []),
        ...(includeMic ? ['--include-microphone'] : []),
        ...(performanceSeconds ? ['--remote-control',`--remote-token=${remoteToken}`] : []),
        `--width=${width}`,`--height=${height}`,`--fps=${fps}`,`--bitrate-kbps=${bitrate}`,`--duration-ms=${(performanceSeconds+180)*1000}`,
        '--local-control', '--local-control-port=0', `--local-control-discovery=${discovery}`, `--diagnostics-out=${diagnostics}`],
        {cwd:report, env, stdio:['ignore','pipe','pipe']});
      children.add(child);
      const log = fs.createWriteStream(path.join(report, encoder + '.log'));
      let logError;
      log.on('error', error => {
        logError = error;
        // Keep the harness alive to close its owned browsers and preserve the
        // last complete interval instead of an unhandled WriteStream crash.
        if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
      });
      child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false});
      child.on('exit', (code,signal) => { entry.exitCode = code; entry.exitSignal = signal; children.delete(child); log.end(); });
      await waitFor(() => { if(child.exitCode !== null || child.signalCode) throw Error(`${encoder}: publisher exited before ready`);
        return fs.existsSync(discovery); }, 15000, 'No local-control discovery');
      const control = JSON.parse(fs.readFileSync(discovery));
      const ui = (action,name,value) => execFileSync(path.resolve(opts['ui-helper']),[String(child.pid),action,...(name ? [name] : []),...(value !== undefined ? [value] : [])],{encoding:'utf8',timeout:15000});
      if (opts.gui) {
        ui('activate'); await sleep(1000);
        ui('click',title); await sleep(250);
        fs.writeFileSync(path.join(report,encoder+'-ui-before.json'),ui('dump'));
        ui('set','streamIdInput',stream); ui('set','passwordInput','false');
        ui('press','microphoneDeviceSelect'); await sleep(250);
        fs.writeFileSync(path.join(report,encoder+'-ui-microphone-menu.json'),ui('dump'));
        ui('click','BlackHole 2ch'); await sleep(500);
        fs.writeFileSync(path.join(report,encoder+'-ui-after-input.json'),ui('dump'));
        ui('verify-selected',title);
        ui('press','goLiveButton');
      }
      const page = await receiver(viewerBrowser, stream, child);
      if (audioMode !== 'none' && audioMode !== 'default-microphone' && opts['late-audio']) await startFixtureAudio();
      entry.moving = await observe(page, 6000);
      entry.distinctFrames = requireMoving(entry.moving, encoder);
      if (performanceSeconds) {
        entry.performance = {scope:'Local controlled window and browser on the same Mac; not calibrated latency/A-V or release qualification',chunks:[],samples:[],meetsTarget:true};
        entry.performance.presentationScope='Callback timing only during sustained observation; decoded-track pixels verify content. Initial and functional-control presentation checks still inspect pixels.';
        const samplePerformanceAudio = audioMode !== 'none' || usesMic;
        if (samplePerformanceAudio) entry.performance.audioCoverage = 'Three-second decoded stereo/isolation observations in each ten-second interval; not continuous audio or A/V drift measurement';
        if (continuousAudioEnabled) {
          const recording=await continuousAudio.record(page,path.join(report,encoder+'-received-audio.webm'));
          audioRecordings.add(recording);entry.independentAudioRecording=recording.metadata;
          entry.performance.continuousAudio = await continuousAudio.start(page);
          entry.performance.audioCoverage = 'Continuous received PCM in consecutive 100 ms windows, plus independent three-second spectra each interval; 500 ms initial settling and under 100 ms final partial window excluded. Not A/V drift measurement.';
        }
        const counters = () => page.evaluate(async () => {
          let decoded=0,dropped=0;
          for(const pc of window.reviewPCs) if(pc.connectionState==='connected')
            for(const item of (await pc.getStats()).values()) if(item.type==='inbound-rtp'&&item.kind==='video') {
              decoded+=item.framesDecoded||0;dropped+=item.framesDropped||0;
            }
          return {decoded,dropped};
        });
        for(let elapsed=0;elapsed<performanceSeconds;elapsed+=10) {
          if (logError) throw logError;
          const disk = fs.statfsSync(report);
          if (disk.bavail * disk.bsize < 128 * 1024 * 1024)
            throw Error('Endurance stopped: less than 128 MiB available for evidence and browser state');
          const seconds=Math.min(10,performanceSeconds-elapsed);
          await source.evaluate(()=>{fixture.trace=[];fixture.record=true;});
          const before=await counters(), beforeDiag=await api(control,'/diagnostics');
          let observing=true,samplingError,finishSampling;
          const samplingDone=new Promise(resolve=>{finishSampling=resolve;});
          const sampling=(async()=>{
            while(observing) {
              const diagnostics=await api(control,'/diagnostics');
              const rssKiB=Number(execFileSync('/bin/ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8'}).trim());
              const inbound=continuousAudioEnabled ? await page.evaluate(async()=>{
                const samples=[];
                for(const pc of window.reviewPCs)if(pc.connectionState==='connected')
                  for(const item of (await pc.getStats()).values())if(item.type==='inbound-rtp') {
                    const sample={};
                    for(const key of ['timestamp','kind','packetsReceived','packetsLost','jitter','concealedSamples',
                      'silentConcealedSamples','concealmentEvents','insertedSamplesForDeceleration','removedSamplesForAcceleration',
                      'totalSamplesReceived','jitterBufferDelay','jitterBufferTargetDelay','jitterBufferEmittedCount',
                      'framesDecoded','framesDropped','freezeCount','totalFreezesDuration'])
                      if(item[key]!==undefined)sample[key]=item[key];
                    samples.push(sample);
                  }
                return samples;
              }) : undefined;
              entry.performance.samples.push({time:Date.now(),rssKiB,video:diagnostics.video,system:diagnostics.system,
                ...(inbound?{inbound}: {})});
              await Promise.race([sleep(2000),samplingDone]);
            }
          })().catch(error=>{samplingError=error;});
          let observation,presentation,audioObservation;
          try { [observation,presentation,audioObservation]=await Promise.all([
            observeDecoded(page,seconds*1000,null,'camera',true),observe(page,seconds*1000,null,false),
            samplePerformanceAudio ? observeAudio(page) : Promise.resolve(null)]); }
          finally { observing=false;finishSampling();await sampling; }
          if (samplingError) throw samplingError;
          if (logError) throw logError;
          const after=await counters(),afterDiag=await api(control,'/diagnostics');
          const continuousAudioObservation=continuousAudioEnabled ? await continuousAudio.drain(page) : null;
          const sourceTrace=await source.evaluate(()=>{fixture.record=false;return fixture.trace;});
          const sourceFrames=sourceTrace.filter(f=>f.time>=observation.started&&f.time<=observation.ended);
          const sourceDistinct=new Set(sourceFrames.map(f=>f.id)).size;
          let receivedDistinct;
          try { receivedDistinct=requireMoving(observation,encoder+' sustained'); }
          catch(error) {
            const failed={elapsed,error:String(error),observation,presentation,audioObservation,continuousAudioObservation,
              sourceFrames,beforeDiagnostics:beforeDiag,afterDiagnostics:afterDiag};
            const raw=Buffer.from(JSON.stringify(failed)),compressed=gzipSync(raw);
            const name=`${encoder}-failed-performance-${String(elapsed).padStart(4,'0')}.json.gz`;
            fs.writeFileSync(path.join(report,name),compressed,{flag:'wx'});
            entry.performance.failedInterval={elapsed,error:String(error),evidence:{path:name,compression:'gzip',
              sha256:crypto.createHash('sha256').update(compressed).digest('hex'),
              uncompressedSha256:crypto.createHash('sha256').update(raw).digest('hex')}};
            (entry.performance.failedIntervals ||= []).push(entry.performance.failedInterval);
            entry.performance.meetsTarget=false;saveReport();
            if(collectPerformanceFailures) {console.error(String(error));continue;}
            throw error;
          }
          const gaps=observation.observations.slice(1).map((f,i)=>(f.mediaTime-observation.observations[i].mediaTime)*1000).sort((a,b)=>a-b);
          const wallSeconds=(observation.ended-observation.started)/1000;
          const expectedDistinct=Math.min(sourceDistinct,fps*wallSeconds);
          const chunk={elapsed,seconds:wallSeconds,sourceDistinct,receivedDistinct,sourceFps:sourceDistinct/wallSeconds,
            expectedDistinct,receivedFps:receivedDistinct/wallSeconds,deliveryRatio:receivedDistinct/expectedDistinct,
            p95MediaGapMs:gaps[Math.floor(gaps.length*.95)],maxMediaGapMs:Math.max(...gaps),before,after,
            observation,presentation,presentationCallbacks:presentation.observations.length,
            sourceFrames,beforeDiagnostics:beforeDiag,afterDiagnostics:afterDiag};
          let audioError;
          if (samplePerformanceAudio) {
            chunk.audioObservation = audioObservation;
            try { requireAudio(audioObservation); } catch (error) { audioError = error; }
            chunk.audioCheck = {passed:!audioError,spectra:audioObservation.spectra.length,
              minRms:Math.min(...audioObservation.spectra.map(s=>s.rms)),
              maxRms:Math.max(...audioObservation.spectra.map(s=>s.rms)),
              ...(audioError ? {error:String(audioError)} : {})};
          }
          if (continuousAudioEnabled) {
            chunk.continuousAudioObservation=continuousAudioObservation;
            chunk.continuousAudioCheck=continuousAudio.analyze(continuousAudioObservation,seconds-.35);
            if(!chunk.continuousAudioCheck.passed)
              audioError=Error('Continuous audio: '+JSON.stringify(chunk.continuousAudioCheck));
          }
          chunk.meetsTarget=chunk.sourceFps>=fps*.95&&chunk.deliveryRatio>=.95&&chunk.p95MediaGapMs<=2000/fps+2&&
            observation.width===width&&observation.height===height&&
            afterDiag.video.encode_failures===beforeDiag.video.encode_failures&&afterDiag.video.encode_timeouts===beforeDiag.video.encode_timeouts&&!audioError;
          if (compactPerformanceReport) {
            // Keep every raw observation, but write each interval once. Long
            // runs otherwise rewrite tens of megabytes after every interval.
            const raw = Buffer.from(JSON.stringify(chunk));
            const compressed = gzipSync(raw);
            const name = `${encoder}-performance-${String(elapsed).padStart(4,'0')}.json.gz`;
            fs.writeFileSync(path.join(report,name),compressed,{flag:'wx'});
            const {observation: rawDecoded,presentation: rawPresented,sourceFrames: rawSource,
              beforeDiagnostics: rawBefore,afterDiagnostics: rawAfter,audioObservation: rawAudio,
              continuousAudioObservation: rawContinuousAudio,...summary} = chunk;
            summary.evidence = {path:name,compression:'gzip',bytes:compressed.length,
              sha256:crypto.createHash('sha256').update(compressed).digest('hex'),
              uncompressedBytes:raw.length,uncompressedSha256:crypto.createHash('sha256').update(raw).digest('hex')};
            entry.performance.chunks.push(summary);
          } else entry.performance.chunks.push(chunk);
          entry.performance.meetsTarget&&=chunk.meetsTarget;
          console.log(`${encoder}: ${elapsed+seconds}s source=${chunk.sourceFps.toFixed(1)} received=${chunk.receivedFps.toFixed(1)} fps ratio=${chunk.deliveryRatio.toFixed(3)} p95=${chunk.p95MediaGapMs.toFixed(1)}ms target=${chunk.meetsTarget}`);
          saveReport();
          if (audioError) {
            if(collectPerformanceFailures) console.error(String(audioError));
            else throw audioError;
          }
        }
        if (continuousAudioEnabled) {
          await continuousAudio.stop(page);
          for(const recording of audioRecordings) {await recording.stop();audioRecordings.delete(recording);}
        }
      }
      if (audioMode !== 'none' || usesMic) {
        entry.audio = await observeAudio(page); requireAudio(entry.audio);
        if (opts.gui) {
          ui('press','microphoneMuteButton'); await sleep(700);
          entry.liveMicMuted = await observeAudio(page); requireAudio(entry.liveMicMuted,false,true);
          const muted = await api(control,'/diagnostics');
          if (!muted.audio.microphone_muted) throw Error('GUI microphone mute did not reach the app');
          ui('press','microphoneMuteButton'); await sleep(700);
          entry.liveMicUnmuted = await observeAudio(page); requireAudio(entry.liveMicUnmuted);
          if ((await api(control,'/diagnostics')).audio.microphone_muted) throw Error('GUI microphone unmute did not reach the app');
        }
        if (mixedMic && !opts['missing-input']) {
          micTone.stdin.write('silence\n'); await sleep(700);
          entry.appWithoutMicrophoneTone = await observeAudio(page); requireAudio(entry.appWithoutMicrophoneTone,false,true);
          micTone.stdin.write('sound\n');
        }
        await setFixtureSound(false);
        await sleep(700);
        entry.silence = await observeAudio(page); requireAudio(entry.silence, true);
        await setFixtureSound(true);
      }
      const diag = await api(control,'/diagnostics');
      fs.writeFileSync(path.join(report,encoder + '-live-diagnostics.json'), JSON.stringify(diag,null,2));
      if (usesMic) {
        entry.activeMicrophone = diag.audio.active_microphone_source;
        if (opts['missing-input'] ? entry.activeMicrophone !== 'none' : !entry.activeMicrophone?.includes('BlackHole'))
          throw Error('Selected microphone identity or missing-device behavior differs from the request');
      }
      entry.activeEncoder = diag.video.active_encoder;
      entry.hardwareEncoder = diag.video.hardware_encoder;
      if (entry.hardwareEncoder !== (encoder === 'videotoolbox')) throw Error('Actual encoder category differs from the explicit selection');
      const identity = JSON.stringify(diag.video || diag);
      if (!identity.toLowerCase().includes(codec === 'av1' ? 'libaom-av1' : codec === 'vp9' ? 'libvpx-vp9' : encoder === 'videotoolbox' ? 'videotoolbox' : 'x264'))
        throw Error(`${encoder}: diagnostics do not confirm requested encoder`);
      if (windowSuspension) {
        entry.suspension = {};
        await exerciseWindowSuspension({source,browser:viewerBrowser,stream,page,
          diagnostics:()=>api(control,'/diagnostics'),requireAudio,requireMoving,result:entry.suspension});
        fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
      }
      if (performanceSeconds && fps>=10) {
        entry.frameRateChanges=[];
        for(const targetFps of [fps===30?15:30,fps]) {
          const sent=await page.evaluate(({targetFps,remoteToken})=>{
            const peer=Object.keys(window.session?.rpcs||{})[0];
            if(!peer||typeof window.session.sendRequest!=='function')return false;
            return window.session.sendRequest({requestVideoHack:true,keyname:'frameRate',value:targetFps,remote:remoteToken},peer)!==false;
          },{targetFps,remoteToken});
          if(!sent)throw Error('Could not request live frame-rate change');
          await waitFor(async()=>(await api(control,'/diagnostics')).video.configured_fps===targetFps,15000,'Live frame rate did not change');
          await sleep(800);
          const before=await api(control,'/diagnostics'),moving=await observeDecoded(page,5000),after=await api(control,'/diagnostics');
          const distinct=requireMoving(moving,'Live '+targetFps+' fps'),seconds=(moving.ended-moving.started)/1000;
          const captured=after.video.frames_captured-before.video.frames_captured;
          entry.frameRateChanges.push({targetFps,distinct,seconds,captured,observation:moving,beforeDiagnostics:before,afterDiagnostics:after});
          if(distinct<targetFps*seconds*.9||moving.observations.length>targetFps*seconds*1.08+2||captured>targetFps*seconds*1.08+2)
            throw Error('Live frame-rate output/readback did not follow the request');
        }
      }
      await source.evaluate(() => { fixture.paused = true; });
      await sleep(1000);
      entry.static = await observe(page, 2500);
      const staticIds = new Set(entry.static.observations.map(frame => frame.id));
      if (staticIds.size !== 1 || entry.static.observations.length < 10) throw Error('Static source did not stay paced');
      await source.evaluate(() => { fixture.paused = false; });
      await source.setViewportSize({width:1024,height:640});
      await sleep(800);
      entry.resized = await observe(page, 4000);
      requireMoving(entry.resized, 'Resized ' + encoder);
      const lateViewer = await receiver(viewerBrowser, stream, child);
      entry.lateViewer = await observe(lateViewer, 3000);
      requireMoving(entry.lateViewer, 'Late viewer ' + encoder);
      if (audioMode !== 'none' || usesMic) { entry.lateAudio = await observeAudio(lateViewer); requireAudio(entry.lateAudio); }
      await page.screenshot({path:path.join(report,encoder + '-receiver.png')});
      await api(control,'/commands',{command:'export_diagnostics',path:diagnostics});
      if (encoder === 'x264') {
        await source.close();
        // macOS Chrome may retain the native window after its last page
        // closes. That is a suspended (still existing) capture source, not
        // native window destruction. End the owned browser to verify genuine
        // source loss; the native recovery fixture separately destroys just
        // its AppKit window while retaining the owning process.
        await waitFor(async () => {
          if (child.exitCode !== null) return true;
          try { return (await api(control,'/diagnostics')).source.suspended === true; }
          catch { return child.exitCode !== null; }
        }, 5000, 'Closed browser page neither suspended nor stopped capture');
        if (child.exitCode === null) {
          entry.retainedWindowDiagnostics = await api(control,'/diagnostics');
          if (!entry.retainedWindowDiagnostics.app.live || !entry.retainedWindowDiagnostics.app.capturing)
            throw Error('Retained native window did not preserve its suspended capture session');
          await sourceBrowser.close(); browsers.delete(sourceBrowser);
          entry.closedSourceBrowser = true;
        }
        await waitFor(() => child.exitCode !== null, 10000, 'Publisher did not report source closure');
        if (child.exitCode !== 3) throw Error('Source closure did not produce a capture failure');
        entry.sourceClosureReported = true;
      } else {
        await api(control,'/commands',{command:'quit'});
      }
      await waitFor(() => child.exitCode !== null, 10000, 'Publisher did not quit');
      if(child.exitCode !== (encoder === 'x264' ? 3 : 0) || fs.existsSync(discovery)) throw Error('Publisher shutdown failed');
      if(fs.readFileSync(path.join(report,encoder+'.log'),'utf8').includes(remoteToken))throw Error('Remote token appeared in publisher log');
      await page.close(); await lateViewer.close();
      if (logError) throw logError;
      entry.functionalPassed = true;
      entry.passed = !entry.performance || entry.performance.meetsTarget;
      console.log(encoder + ': functional workflow passed, performance target=' + (entry.performance?entry.performance.meetsTarget:'not measured') + ', distinct frames=' + entry.distinctFrames);
    }
    result.passed = result.cases.every(entry=>entry.passed);
    if (!result.passed) process.exitCode=1;
  } catch (error) {
    result.error = String(error.stack || error); process.exitCode = 1;
    console.error(result.error);
  } finally {
    stoppingFixtures=true;
    for(const recording of audioRecordings) {
      try {await recording.stop();}
      catch(error) {result.recordingError=String(error);result.passed=false;process.exitCode=1;}
    }
    for (const child of children) child.kill('SIGTERM');
    for (const browser of browsers) await browser.close().catch(() => {});
    try { saveReport(); }
    catch (error) { result.passed=false;process.exitCode=1;console.error('Final report write failed; retain the last complete saved interval: '+error.message); }
    console.log(JSON.stringify({report,passed:result.passed}));
  }
})();
