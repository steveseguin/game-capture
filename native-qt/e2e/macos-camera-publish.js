#!/usr/bin/env node
'use strict';
// Real packaged camera -> encoder -> VDO.Ninja playback, using only a controlled
// existing OBS virtual device. No OBS configuration or physical camera access.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const {spawn, execFileSync} = require('child_process');
const {chromium} = require('playwright');
const {sleep, waitFor, receiver, observe, observeDecoded, requireMoving, observeAudio} = require('./macos-media-receiver');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf('='); return [arg.slice(2,at),arg.slice(at+1)];
}));
if (process.platform !== 'darwin' || !opts.app || !opts.reports || !opts['camera-device'] || !opts['camera-helper'])
  throw Error('Use --app, --reports, --camera-device (existing OBS UID), and --camera-helper on macOS');
if (opts.gui && (!opts['ui-helper'] || opts.encoder !== 'videotoolbox'))
  throw Error('GUI workflow requires --ui-helper and --encoder=videotoolbox for the default Auto encoder');
const codec=opts.codec||'h264';
if (!['h264','av1'].includes(codec) || (codec==='av1' && (opts.gui || opts.encoder!=='software')))
  throw Error('AV1 camera workflow requires --codec=av1 --encoder=software in CLI mode');
const microphone = opts['microphone-device'];
const bitrateSteps=opts['bitrate-steps']?.split(',').map(v=>v==='false'?false:Number(v))||[];
if(bitrateSteps.length && (opts.gui || bitrateSteps.length>8 || bitrateSteps.some(v=>v!==false&&(!Number.isInteger(v)||v<250||v>20000))))
  throw Error('Bitrate steps require CLI publishing and up to eight 250–20000 kbps requests or false');
const remoteToken=crypto.randomBytes(24).toString('hex');
if (microphone && !opts['tone-helper']) throw Error('Microphone workflow requires the controlled BlackHole --tone-helper');
const app = path.resolve(opts.app), executable = path.join(app,'Contents/MacOS/game-capture');
if (!fs.existsSync(path.join(app,'Contents/Frameworks'))) throw Error('Use a deployed bundle');
const report = path.resolve(opts.reports,crypto.randomUUID()); fs.mkdirSync(report,{recursive:true});
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result = {scope:'Packaged controlled virtual camera playback; physical devices and release qualification excluded',
  executableSha256:hash(executable), harnessSha256:hash(__filename), receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),
  fixtureSha256:hash(path.resolve(opts['camera-helper'])), cameraDevice:opts['camera-device'], microphoneDevice:microphone || null,
  toneFixtureSha256:microphone ? hash(path.resolve(opts['tone-helper'])) : null, codec, gui:!!opts.gui, cases:[],passed:false};
for(const name of ['macos-camera-publish.js','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children = new Set(); let browser;
async function api(control,route,body) {
  const r = await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  const data=await r.json(); if(!r.ok)throw Error(JSON.stringify(data)); return data;
}
async function orientation(page) {
  const colors=await page.evaluate(() => {
    const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth&&!v.paused);
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const context=canvas.getContext('2d');context.drawImage(video,0,0);
    return [.05,.95].map(y=>[...context.getImageData(Math.floor(canvas.width*.05),Math.floor(canvas.height*y),1,1).data]);
  });
  if(!(colors[0][0]>170&&colors[0][1]<70&&colors[1][1]>170&&colors[1][0]<70)) throw Error('Camera colors/orientation differ from controlled input');
  return colors;
}
function requireMicrophone(observation, silent = false) {
  if (!observation.tracks.some(t => (/audio\/opus/i.test(t.codec) ||
      (/audio\/red/i.test(t.codec) && t.negotiatedCodecs.some(c => /audio\/opus/i.test(c.mimeType)))) && t.packetsReceived > 20))
    throw Error('Camera receiver did not receive Opus packets');
  const good = observation.spectra.filter(s => silent ? s.rms < .0005 :
    s.tone440 > -65 && s.tone880 > -65 && s.rms > .001 &&
    s.channels[0].tone440 > s.channels[0].tone880 + 20 && s.channels[1].tone880 > s.channels[1].tone440 + 20);
  if (good.length < 25) throw Error('Camera microphone signal/silence or stereo routing differs from the controlled source');
}
(async()=>{
  console.log('Reports: '+report);
  try {
    const fixture=spawn(path.resolve(opts['camera-helper']),[opts['camera-device']],{stdio:['pipe','pipe','pipe']});children.add(fixture);
    let ready='',errors='';fixture.stdout.on('data',data=>ready+=data);fixture.stderr.on('data',data=>errors+=data);
    fixture.on('exit',()=>children.delete(fixture));
    await waitFor(()=>{if(fixture.exitCode!==null)throw Error('Camera fixture failed: '+errors);return ready.includes('READY');},5000,'Camera fixture did not start');
    let tone;
    if (microphone) {
      tone=spawn(path.resolve(opts['tone-helper']),[microphone,'440','880'],{stdio:['pipe','pipe','pipe']});children.add(tone);
      let toneReady='',toneErrors='';tone.stdout.on('data',data=>toneReady+=data);tone.stderr.on('data',data=>toneErrors+=data);
      tone.on('exit',()=>children.delete(tone));
      await waitFor(()=>{if(tone.exitCode!==null)throw Error('Tone fixture failed: '+toneErrors);return toneReady.includes('READY');},5000,'Tone fixture did not start');
    }
    browser=await chromium.launch({headless:true,...(opts['browser-executable']?{executablePath:path.resolve(opts['browser-executable'])}:{}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
    result.browserVersion=browser.version();
    if(opts['browser-executable'])result.browserExecutableSha256=hash(path.resolve(opts['browser-executable']));
    const encoders=opts.encoder?[opts.encoder]:['videotoolbox','x264'];
    if(encoders.some(e=>!(codec==='av1'?['software']:['videotoolbox','x264']).includes(e)))throw Error('Unknown encoder');
    for(const encoder of encoders) {
      const entry={encoder,passed:false};result.cases.push(entry);
      const stream='maccam'+crypto.randomBytes(12).toString('hex');
      const discovery=path.join(report,encoder+'-control.json');
      const width=bitrateSteps.length?1920:encoder==='videotoolbox'?640:960,height=bitrateSteps.length?1080:encoder==='videotoolbox'?360:540,fps=bitrateSteps.length?30:encoder==='videotoolbox'?30:24;
      const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(QT_|DYLD_|GAME_CAPTURE_)/.test(key)));
      const publisher=spawn(executable,[...(opts.gui?['--temporary-settings']:['--headless']), '--source=camera',`--camera-id=${opts['camera-device']}`,
        `--stream=${stream}`,'--password=false','--audio-source=none',`--video-encoder=${encoder}`,`--video-codec=${codec}`,
        ...(microphone ? ['--include-microphone',`--microphone-device=${microphone}`] : []),
        `--width=${width}`,`--height=${height}`,`--fps=${fps}`,'--bitrate-kbps=2000',`--duration-ms=${120000+bitrateSteps.length*15000}`,
        ...(bitrateSteps.length?['--remote-control',`--remote-token=${remoteToken}`]:[]),
        '--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],{cwd:report,env,stdio:['ignore','pipe','pipe']});
      children.add(publisher);const log=fs.createWriteStream(path.join(report,encoder+'.log'));
      publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});
      publisher.on('exit',(code,signal)=>{entry.exitCode=code;entry.exitSignal=signal;children.delete(publisher);log.end();});
      await waitFor(()=>{if(publisher.exitCode!==null||publisher.signalCode)throw Error('Publisher exited before ready');return fs.existsSync(discovery);},15000,'No control discovery');
      const control=JSON.parse(fs.readFileSync(discovery));
      const ui=(action,name,value)=>execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),action,...(name?[name]:[]),...(value!==undefined?[value]:[])],{encoding:'utf8',timeout:15000});
      if(opts.gui) {
        ui('activate');await sleep(700);ui('press','sourceModeSelect');await sleep(200);ui('click','Camera / Webcam');await sleep(700);
        ui('click','OBS Virtual Camera');await sleep(250);
        ui('set','streamIdInput',stream);ui('set','passwordInput','false');
        if (microphone) {ui('press','microphoneDeviceSelect');await sleep(250);ui('click','BlackHole 2ch');await sleep(500);}
        ui('verify-selected','OBS Virtual Camera');
        fs.writeFileSync(path.join(report,encoder+'-ui-before-live.json'),ui('dump'));
        ui('press','goLiveButton');
      }
      const page=await receiver(browser,stream,publisher);
      entry.moving=await observe(page,6000);entry.distinctFrames=requireMoving(entry.moving,encoder,'video/'+codec);
      entry.orientation=await orientation(page);
      if(bitrateSteps.length){
        // Existing VDO.Ninja main.js postMessage contract: targetBitrate and
        // remote are forwarded through session.sendRequest to the chosen peer.
        entry.bitrateChanges=[];
        const snapshot=async()=>({epochMs:Date.now(),diagnostics:await api(control,'/diagnostics'),receiver:await page.evaluate(async()=>{
          const tracks=[];for(const pc of window.reviewPCs)for(const v of (await pc.getStats()).values())
            if(v.type==='inbound-rtp'&&v.kind==='video')tracks.push({...v});return tracks;
        })});
        const request=token=>page.evaluate(({rate,token})=>{
          const ids=Object.keys(window.session?.rpcs||{});if(ids.length!==1)throw Error('Expected one controlled publisher');
          return !!window.session.sendRequest({targetBitrate:rate,remote:token},ids[0]);
        },{rate:4000,token});
        entry.unauthorizedBefore=await snapshot();
        if(!await request(remoteToken+'-invalid'))throw Error('Could not send negative authorization control');
        await sleep(1000);entry.unauthorizedAfter=await snapshot();
        if(entry.unauthorizedAfter.diagnostics.video.configured_bitrate_kbps!==2000)throw Error('Unauthorized bitrate changed publisher');
        for(const rate of bitrateSteps){
          const row={request:rate,expectedKbps:rate===false?2000:rate,before:await snapshot()};entry.bitrateChanges.push(row);
          if(!await page.evaluate(({rate,token})=>{
            const ids=Object.keys(window.session?.rpcs||{});if(ids.length!==1)throw Error('Expected one controlled publisher');
            return !!window.session.sendRequest({targetBitrate:rate,remote:token},ids[0]);
          },{rate,token:remoteToken}))throw Error('Existing targetBitrate request did not send');
          await waitFor(async()=> (await api(control,'/diagnostics')).video.configured_bitrate_kbps===row.expectedKbps,10000,'Target bitrate did not apply');
          row.applied=await snapshot();
          [row.presentation,row.decoded]=await Promise.all([observe(page,10000),observeDecoded(page,10000,null,'camera',true)]);
          requireMoving(row.presentation,'Bitrate presentation');requireMoving(row.decoded,'Bitrate decoded');row.after=await snapshot();
          console.log(JSON.stringify({encoder,requestedBitrate:rate,configuredBitrate:row.after.diagnostics.video.configured_bitrate_kbps}));
        }
      }
      if (microphone) {
        entry.audio=await observeAudio(page);requireMicrophone(entry.audio);
        if (opts.gui) {
          ui('press','microphoneMuteButton');await sleep(700);
          entry.liveMicMuted=await observeAudio(page);requireMicrophone(entry.liveMicMuted,true);
          if (!(await api(control,'/diagnostics')).audio.microphone_muted) throw Error('GUI microphone mute did not reach the app');
          ui('press','microphoneMuteButton');await sleep(700);
          entry.liveMicUnmuted=await observeAudio(page);requireMicrophone(entry.liveMicUnmuted);
          if ((await api(control,'/diagnostics')).audio.microphone_muted) throw Error('GUI microphone unmute did not reach the app');
        }
        tone.stdin.write('silence\n');await sleep(700);entry.silence=await observeAudio(page);requireMicrophone(entry.silence,true);
        tone.stdin.write('sound\n');
      }
      const diag=await api(control,'/diagnostics');
      fs.writeFileSync(path.join(report,encoder+'-live-diagnostics.json'),JSON.stringify(diag,null,2));
      if(diag.source.mode!=='camera'||diag.source.source_id!==opts['camera-device'])throw Error('Publisher did not select the explicit camera');
      if(diag.audio.source_mode!=='none' || (microphone ?
          !diag.audio.active_microphone_source?.includes('BlackHole') || !diag.audio.include_microphone :
          diag.audio.active_microphone_source!=='none' || diag.audio.include_microphone))
        throw Error('Camera audio routing differs from the explicit selection');
      if(diag.video.hardware_encoder!==(encoder==='videotoolbox'))throw Error('Actual encoder category differs');
      if(diag.video.active_codec!==(codec==='av1'?'AV1':'H.264'))throw Error('Actual codec differs');
      if(codec==='av1'&&!diag.video.active_encoder.includes('libaom-av1'))throw Error('AV1 did not use libaom');
      entry.configuration={width:diag.video.configured_width,height:diag.video.configured_height,fps:diag.video.configured_fps,encoder:diag.video.active_encoder};
      if(!opts.gui&&(entry.moving.width!==width||entry.moving.height!==height))throw Error('Requested output size differs from decoded camera video');
      fixture.stdin.write('pause\n');await sleep(1000);entry.static=await observe(page,2500);
      if(new Set(entry.static.observations.map(f=>f.id)).size!==1||entry.static.observations.length<10)throw Error('Static camera image did not remain paced');
      fixture.stdin.write('resume\n');
      const late=await receiver(browser,stream,publisher);entry.lateViewer=await observe(late,3000);requireMoving(entry.lateViewer,'Late camera viewer','video/'+codec);
      if (microphone) {entry.lateAudio=await observeAudio(late);requireMicrophone(entry.lateAudio);}
      await page.screenshot({path:path.join(report,encoder+'-receiver.png')});
      if(opts.gui) {
        const window=execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),'window'],{encoding:'utf8'}).trim();
        execFileSync('/usr/sbin/screencapture',['-x','-l',window,path.join(report,encoder+'-publisher.png')]);
        ui('press','goLiveButton');
        await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'GUI camera stop did not complete');
        await page.close();await late.close();
        ui('verify-selected','OBS Virtual Camera');ui('press','goLiveButton');
        const restarted=await receiver(browser,stream,publisher);
        entry.restarted=await observe(restarted,4000);requireMoving(entry.restarted,'Restarted camera','video/'+codec);
        entry.restartedOrientation=await orientation(restarted);
        if (microphone) {entry.restartedAudio=await observeAudio(restarted);requireMicrophone(entry.restartedAudio);}
        const restartedDiag=await api(control,'/diagnostics');
        if(restartedDiag.source.source_id!==opts['camera-device'] || !restartedDiag.app.live) throw Error('GUI restart changed the selected camera');
        fs.writeFileSync(path.join(report,encoder+'-restart-diagnostics.json'),JSON.stringify(restartedDiag,null,2));
        await restarted.close();
      }
      const expectedExit = !opts.gui && encoder === 'videotoolbox' ? 3 : 0;
      if(expectedExit===3) fixture.stdin.write('stall\n');
      else await api(control,'/commands',{command:'quit'});
      await waitFor(()=>publisher.exitCode!==null,10000,'Publisher failed to quit');
      if(publisher.exitCode!==expectedExit||fs.existsSync(discovery))throw Error('Camera publisher shutdown/failure reporting failed');
      if(expectedExit===3) {entry.stallReported=true;fixture.stdin.write('flow\n');}
      await page.close();await late.close();entry.passed=true;console.log(encoder+': passed, distinct frames='+entry.distinctFrames);
    }
    fixture.stdin.write('quit\n');await waitFor(()=>fixture.exitCode!==null,5000,'Camera fixture did not stop');
    if(fixture.exitCode!==0)throw Error('Camera fixture failed during cleanup');
    result.passed=true;
  } catch(error) {result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;}
  finally {
    for(const child of children)child.kill('SIGTERM');
    if(browser)await browser.close().catch(()=>{});
    fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({report,passed:result.passed}));
  }
})();
