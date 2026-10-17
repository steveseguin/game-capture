#!/usr/bin/env node
'use strict';
// Real hosted director/scene/guest pages, packaged Mac publisher and controlled media.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {gzipSync}=require('node:zlib');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,installReceiverProbe,observe,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const director=require('./director-room-e2e');
const {create:createSignalingProxy}=require('./signaling-fault-proxy');
const roomRecovery=require('./macos-room-recovery-observer');
const continuousAudio=require('./macos-continuous-audio');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
for(const key of ['app','reports','camera-device','camera-helper','microphone-device','tone-helper'])assert(opts[key],'Required --'+key);
assert.equal(process.platform,'darwin');
assert(['enabled','disabled'].includes(opts['remote-control']||'enabled'),'--remote-control must be enabled or disabled');
const remoteEnabled=opts['remote-control']!=='disabled';
const rtcLog=opts['rtc-log']||'off';assert(['off','debug'].includes(rtcLog),'--rtc-log must be off or debug');
for(const key of ['signaling-recovery','password-protected'])assert(['true','false'].includes(opts[key]||'false'),'--'+key+' must be true or false');
const recoverSignaling=opts['signaling-recovery']==='true',passwordProtected=opts['password-protected']==='true';
assert(!recoverSignaling||remoteEnabled,'Room recovery requires the guest/director controls workflow');
const performanceSeconds=Number(opts['performance-seconds']||0);
const extraScenes=Number(opts['extra-scenes']||0),compact=opts['compact-performance-report']==='true';
const continuous=opts['continuous-audio']==='true';
const fuzzEnabled=opts['fuzz-seed']!==undefined;
assert(!opts['fuzz-steps']||fuzzEnabled,'--fuzz-steps requires --fuzz-seed');
const fuzzSeed=fuzzEnabled?Number(opts['fuzz-seed']):null;
assert(['true','false'].includes(opts['fuzz-local-control']||'false'),'Invalid --fuzz-local-control');
const fuzzLocalControl=opts['fuzz-local-control']==='true';
assert(!fuzzLocalControl||fuzzEnabled,'Local control fuzz requires --fuzz-seed');
const fuzzPlan=fuzzEnabled?require('./macos-room-fuzz-plan')(fuzzSeed,Number(opts['fuzz-steps']||8)):[];
assert(!fuzzEnabled||(remoteEnabled&&!recoverSignaling&&opts['drop-guest-bye']!=='true'),'Fuzz requires ordinary enabled room controls');
const guestCycles=Number(opts['guest-cycles']||2);
assert(Number.isInteger(guestCycles)&&guestCycles>=2&&guestCycles<=10,'--guest-cycles must be 2..10');
assert(['true','false'].includes(opts['drop-guest-bye']||'false'),'Invalid --drop-guest-bye');
const dropGuestBye=opts['drop-guest-bye']==='true';
for(const key of ['expect-closed-guest-cleanup','guest-refresh'])assert(['true','false'].includes(opts[key]||'false'),'Invalid --'+key);
const expectClosedGuestCleanup=opts['expect-closed-guest-cleanup']==='true',guestRefresh=opts['guest-refresh']==='true';
assert(!expectClosedGuestCleanup||dropGuestBye,'Closed-guest cleanup proof requires deliberately suppressed BYE');
assert(!guestRefresh||(remoteEnabled&&!recoverSignaling),'Guest refresh requires normal room controls');
assert(!dropGuestBye||(remoteEnabled&&!recoverSignaling),'Guest bye negative control requires ordinary enabled room controls');
assert(!opts['continuous-audio']||['true','false'].includes(opts['continuous-audio']),'Invalid --continuous-audio');
assert(!continuous||performanceSeconds,'Continuous audio requires a timed room observation');
assert(Number.isInteger(extraScenes)&&extraScenes>=0&&extraScenes<=2,'--extra-scenes must be 0..2');
assert(!opts['compact-performance-report']||['true','false'].includes(opts['compact-performance-report']),'Invalid --compact-performance-report');
assert(!extraScenes||performanceSeconds,'Additional scene receivers require a timed room observation');
assert(!compact||performanceSeconds,'Compact reports require a timed room observation');
assert(Number.isInteger(performanceSeconds)&&performanceSeconds>=0&&performanceSeconds<=1800&&performanceSeconds%10===0,
  '--performance-seconds must be 0..1800 in ten-second increments');
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture');assert(fs.existsSync(path.join(app,'Contents/Frameworks')),'Use the deployed app');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={executableSha256:hash(exe),harnessSha256:hash(__filename),receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),
  directorHarnessSha256:hash(path.join(__dirname,'director-room-e2e.js')),remoteControlEnabled:remoteEnabled,rtcLog,performanceSeconds,extraScenes,compactPerformanceReport:compact,continuousAudio:continuous,recoverSignaling,passwordProtected,
  continuousAudioHarnessSha256:hash(path.join(__dirname,'macos-continuous-audio.js')),guestCycles,dropGuestBye,expectClosedGuestCleanup,guestRefresh,fuzzSeed,fuzzPlan,fuzzLocalControl,
  cameraFixtureSha256:hash(path.resolve(opts['camera-helper'])),toneFixtureSha256:hash(path.resolve(opts['tone-helper'])),
  scope:'Packaged controlled camera/input with real VDO.Ninja director, scene and guest camera-join UI; optional bounded dual-tier load observation; physical devices, calibrated A/V timing and release qualification excluded',cases:[],passed:false};
for(const name of ['macos-room-publish.js','macos-room-fuzz-plan.js','macos-live-control-fuzz.js','macos-media-receiver.js','macos-continuous-audio.js','director-room-e2e.js','macos-camera-fixture.mm','macos-audio-tone.mm','signaling-fault-proxy.js','macos-room-recovery-observer.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set(),proxies=new Map();let browser;
function launch(program,args,name){const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
  if(path.resolve(program)===exe&&rtcLog==='debug')env.GAME_CAPTURE_RTC_LOG='debug';
  const p=spawn(path.resolve(program),args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(p);
  p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});let output='';p.stdout.on('data',d=>output+=d);p.output=()=>output;
  p.closed=new Promise(resolve=>{p.once('close',code=>{children.delete(p);log.end();resolve(code);});p.once('error',e=>result.launchError=String(e));});return p;}
async function api(control,route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'Control HTTP '+r.status);return r.json();}
function requireAudio(audio){assert(audio.spectra.filter(s=>s.rms>.001&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length>=25,'Stereo audio missing or crossed');}
function installGuestCleanupProbe({dropGuestBye=false}){
  window.__guestLeaveEvidence=[];
  const closePeer=RTCPeerConnection.prototype.close,closeChannel=RTCDataChannel.prototype.close;
  RTCPeerConnection.prototype.close=function(){
    if(window.__guestLeaveEnabled&&window.__guestLeavePeer===this)
      window.__guestLeaveEvidence.push({time:Date.now(),event:'peer-close-request',toPublisher:true,
        state:this.connectionState,iceState:this.iceConnectionState});
    return closePeer.call(this);
  };
  RTCDataChannel.prototype.close=function(){
    if(window.__guestLeaveEnabled&&window.__guestLeaveChannels?.includes(this))
      window.__guestLeaveEvidence.push({time:Date.now(),event:'channel-close-request',toPublisher:true,
        state:this.readyState,bufferedAmount:this.bufferedAmount});
    return closeChannel.call(this);
  };
  const send=RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send=function(data){
    if(!window.__guestLeaveEnabled)return send.call(this,data);
    let message,text;
    try{
      if(typeof data==='string')text=data;
      else if(data instanceof ArrayBuffer||ArrayBuffer.isView(data))text=new TextDecoder().decode(data);
      if(text&&text.length<65536)message=JSON.parse(text);
    }catch{}
    const object=message&&typeof message==='object';
    const entry={time:Date.now(),event:'send',channel:this.label,toPublisher:window.__guestLeaveChannels?.includes(this)||false,
      state:this.readyState,bufferedAmount:this.bufferedAmount,type:typeof data==='string'?'string':data?.constructor?.name,
      bytes:typeof data==='string'?new TextEncoder().encode(data).length:data?.byteLength,
      bye:!!object&&('bye' in message),cleanup:!!object&&message.request==='cleanup'};
    window.__guestLeaveEvidence.push(entry);
    if(dropGuestBye&&entry.toPublisher&&entry.bye){entry.droppedByDiagnostic=true;entry.bufferedAfter=this.bufferedAmount;return;}
    try{const value=send.call(this,data);entry.returned=true;entry.bufferedAfter=this.bufferedAmount;return value;}
    catch(error){entry.error=String(error);throw error;}
  };
}
async function pageAt(url,cleanupProbe=false){const page=await browser.newPage({viewport:{width:1600,height:1000}});await installReceiverProbe(page);if(cleanupProbe)await page.addInitScript(installGuestCleanupProbe,{dropGuestBye});await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});return page;}
function check(value,label){assert(value.ok,label+': '+JSON.stringify(value));return value;}
async function dimensions(page,width,height,peerUuid=null){await waitFor(()=>page.evaluate(({width,height,peerUuid})=>[...document.querySelectorAll('video')].some(v=>!v.paused&&v.videoWidth===width&&v.videoHeight===height&&v.currentTime>0&&(!peerUuid||v.dataset.sid===window.session?.rpcs?.[peerUuid]?.streamID||v.id===`videosource_${peerUuid}`)),{width,height,peerUuid}),25000,'No decoded '+width+'x'+height+' video');}
async function media(page,width,height,label,seconds=4,peerUuid=null){await dimensions(page,width,height,peerUuid);const observed=await observe(page,seconds*1000,peerUuid);const distinct=requireMoving(observed,label);assert.equal(observed.width,width);assert.equal(observed.height,height);return {distinctFrames:distinct,...observed};}
async function videoCounters(page){return page.evaluate(async()=>{let frames=0,keyframes=0;for(const pc of window.reviewPCs)if(pc.connectionState==='connected')for(const s of(await pc.getStats()).values())if(s.type==='inbound-rtp'&&s.kind==='video'){frames+=s.framesDecoded||0;keyframes+=s.keyFramesDecoded||0;}return {frames,keyframes};});}
(async()=>{console.log('Reports: '+report);try{
  const fixture=launch(opts['camera-helper'],[opts['camera-device']],'camera'),tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');
  for(const p of [fixture,tone])await waitFor(()=>{assert.equal(p.exitCode,null,'Fixture exited');return p.output().includes('READY');},5000,'Fixture not ready');
  async function sourceState(){
    const offset=fixture.output().length;fixture.stdin.write('state\n');let state;
    await waitFor(()=>{assert(fixture.exitCode===null&&!fixture.signalCode,'Camera fixture exited');
      const line=fixture.output().slice(offset).split('\n').find(line=>line.startsWith('{')&&line.endsWith('}'));
      if(line)state=JSON.parse(line);return state;
    },3000,'Camera fixture does not report published-frame state; rebuild macos-camera-fixture');
    return state;
  }
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});result.browserVersion=browser.version();
  for(const encoder of (opts.encoders||'videotoolbox,x264').split(',')){
    const entry={encoder,passed:false,phases:[],checks:[]};result.cases.push(entry);
    const stream='macroom'+crypto.randomBytes(10).toString('hex'),room='mac'+crypto.randomBytes(10).toString('hex'),remoteToken=crypto.randomBytes(24).toString('hex');
    const password=passwordProtected?crypto.randomBytes(16).toString('hex'):'false';
    const config={baseUrl:'https://vdo.ninja/',streamId:stream,room,password,timeoutMs:30000};
    const proxy=recoverSignaling?await createSignalingProxy():null;if(proxy)proxies.set(proxy,entry);
    const discovery=path.join(report,encoder+'-control.json');
    const publisherArgs=['--headless','--source=camera',`--camera-id=${opts['camera-device']}`,`--stream=${stream}`,`--room=${room}`,`--password=${password}`,...(proxy?['--server='+proxy.url]:[]),
      '--audio-source=none','--include-microphone',`--microphone-device=${opts['microphone-device']}`,`--video-encoder=${encoder}`,'--video-codec=h264','--resolution=1280x720','--fps=30','--bitrate-kbps=4000',
      ...(remoteEnabled?['--remote-control']:[]),`--remote-token=${remoteToken}`,`--duration-ms=${480000+performanceSeconds*1000+fuzzPlan.length*90000}`,'--max-viewers=8','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`];
    const publisher=launch(exe,publisherArgs,encoder+'-publisher');
    await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited');return fs.existsSync(discovery);},15000,'No local control');const control=JSON.parse(fs.readFileSync(discovery));
    const dir=await pageAt(director.buildDirectorUrl(config)+'&stereo=1');
    const peer=check(await director.waitForDirectorPeer(dir,config),'Director peer');const uuid=peer.uuid;
    check(await director.waitForDecodedDirectorVideo(dir,config),'Director video');
    check(await director.installMessageProbe(dir,uuid),'Director message probe');
    const info=check(await director.waitForStatsInfo(dir,uuid,"info => info.room_init_received === true && info.assigned_role === 'director' && info.assigned_tier === 'lq'",15000),'Director LQ routing');entry.initialDirectorInfo=info.state.info;
    const scene=await pageAt(`https://vdo.ninja/?scene=0&room=${room}&password=${password}&autostart&stereo=1&cleanoutput`);
    entry.phases.push({phase:'simultaneous',director:await media(dir,640,360,'Director LQ'),scene:await media(scene,1280,720,'Scene HQ')});
    entry.directorAudio=await observeAudio(dir);requireAudio(entry.directorAudio);entry.sceneAudio=await observeAudio(scene);requireAudio(entry.sceneAudio);
    const additional=[];
    for(let i=0;i<extraScenes;i++) {
      const page=await pageAt(`https://vdo.ninja/?scene=0&room=${room}&password=${password}&autostart&stereo=1&cleanoutput`);
      const initial=await media(page,1280,720,'Additional scene '+i),audio=await observeAudio(page);requireAudio(audio);
      additional.push(page);(entry.additionalScenes ||= []).push({initial,audio});
    }
    let diag=await api(control,'/diagnostics');entry.initialDiagnostics=diag;
    assert.equal(diag.signaling.password_disabled,!passwordProtected);
    assert(diag.room_quality.effective&&diag.room_quality.reason==='enabled');assert(diag.video.lq_encoder_initialized&&diag.video.lq_encoder.includes('x264'));
    assert.equal(diag.video.hardware_encoder,encoder==='videotoolbox');assert(diag.peer_counts.hq>=1&&diag.peer_counts.lq>=1);
    if(performanceSeconds){
      const audioPages=[['preview',dir],['high',scene],...additional.map((page,i)=>['extra'+i,page])];
      const audioPackets=new Map();
      entry.performance={scope:`${2+extraScenes} simultaneous real receivers: ${1+extraScenes} at 1280x720/30 HQ and independent 640x360/30 x264 preview. `+
        (continuous?'Continuous received PCM on every receiver, 100 ms windows; 500 ms startup settling and final partial window excluded. ':'')+
        'Stereo audio also sampled for three seconds in each ten-second interval. Not calibrated A/V or physical playback.',chunks:[],meetsTarget:true};
      if(continuous)entry.performance.audioObservers=await Promise.all(audioPages.map(async([tier,page])=>({tier,...await continuousAudio.start(page)})));
      for(let elapsed=0;elapsed<performanceSeconds;elapsed+=10){
        const disk=fs.statfsSync(report);assert(disk.bavail*disk.bsize>=128*1024*1024,'Room observation stopped: insufficient evidence space');
        for(const p of [publisher,fixture,tone])assert(p.exitCode===null&&!p.signalCode,'Owned process exited during room load');
        const sourceBefore=await sourceState();
        const before=await api(control,'/diagnostics');
        const [preview,high,previewAudio,highAudio,extra]=await Promise.all([
          observeDecoded(dir,10000,null,'camera',true),observeDecoded(scene,10000,null,'camera',true),observeAudio(dir),observeAudio(scene),
          Promise.all(additional.map(async page=>{const [video,audio]=await Promise.all([
            observeDecoded(page,10000,null,'camera',true),observeAudio(page)]);return {video,audio};}))]);
        const after=await api(control,'/diagnostics');
        const sourceAfter=await sourceState();
        const continuousObservations=continuous?await Promise.all(audioPages.map(async([tier,page])=>{
          const counters=await page.evaluate(async()=>{
            const rows=[];
            for(const pc of window.reviewPCs)if(pc.connectionState==='connected')
              for(const stat of (await pc.getStats()).values())if(stat.type==='inbound-rtp'&&stat.kind==='audio')rows.push({...stat});
            return rows;
          });
          return {tier,counters,observation:await continuousAudio.drain(page)};
        })):[];
        // Preserve all received pixels/identity failures and audio before any
        // assertion can terminate the interval. Compact summaries retain hashes.
        const raw=Buffer.from(JSON.stringify({elapsed,preview,high,previewAudio,highAudio,extra,continuousObservations,
          sourceBefore,sourceAfter,beforeDiagnostics:before,afterDiagnostics:after}));
        const compressed=gzipSync(raw),name=`${encoder}-room-${String(elapsed).padStart(4,'0')}.json.gz`;
        fs.writeFileSync(path.join(report,name),compressed,{flag:'wx'});
        const evidence={path:name,compression:'gzip',sha256:crypto.createHash('sha256').update(compressed).digest('hex'),
          uncompressedSha256:crypto.createHash('sha256').update(raw).digest('hex')};
        entry.performance.pendingInterval={elapsed,evidence};
        fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
        requireAudio(previewAudio);requireAudio(highAudio);for(const data of extra)requireAudio(data.audio);
        const chunk={elapsed,beforeDiagnostics:before,afterDiagnostics:after,
          source:{before:sourceBefore,after:sourceAfter,changedFps:(sourceAfter.changedFrames-sourceBefore.changedFrames)/(sourceAfter.time-sourceBefore.time)},
          publisherRssKiB:Number(execFileSync('/bin/ps',['-o','rss=','-p',String(publisher.pid)],{encoding:'utf8'}).trim()),
          previewAudio,highAudio,evidence,
          continuousAudioChecks:continuousObservations.map(({tier,observation,counters})=>{
            const check={tier,...continuousAudio.analyze(observation,9.65)},packets=counters.reduce((n,s)=>n+(s.packetsReceived||0),0);
            check.receivedPackets=packets;check.previousReceivedPackets=audioPackets.get(tier)||0;
            if(packets<=check.previousReceivedPackets){check.passed=false;check.errors.push('Received audio packets stopped advancing');}
            audioPackets.set(tier,packets);return check;
          })};
        for(const [tier,data,width,height] of [['preview',preview,640,360],['high',high,1280,720],
          ...extra.map((data,index)=>['extra'+index,data.video,1280,720])]){
          if(!compact)fs.writeFileSync(path.join(report,`${encoder}-${tier}-${elapsed}.json`),JSON.stringify(data));
          const distinct=requireMoving(data,`${encoder} ${tier} sustained`),seconds=(data.ended-data.started)/1000;
          const gaps=data.observations.slice(1).map((f,i)=>(f.mediaTime-data.observations[i].mediaTime)*1000).sort((a,b)=>a-b);
          chunk[tier]={seconds,distinctFrames:distinct,decodedFps:distinct/seconds,deliveryRatio:distinct/seconds/30,
            p95MediaGapMs:gaps[Math.floor(gaps.length*.95)],maxMediaGapMs:Math.max(...gaps),width:data.width,height:data.height};
          chunk[tier].meetsTarget=chunk[tier].deliveryRatio>=.95&&chunk[tier].p95MediaGapMs<=2000/30+2&&data.width===width&&data.height===height;
        }
        assert(after.room_quality.effective&&after.video.lq_encoder_initialized&&after.video.lq_encoder.includes('x264'));
        assert.equal(after.video.hardware_encoder,encoder==='videotoolbox');
        assert(after.peer_counts.hq>=1+extraScenes&&after.peer_counts.lq>=1);
        assert.equal(after.macos_media_activity_active,true);
        chunk.meetsTarget=chunk.source.changedFps>=28.5&&chunk.preview.meetsTarget&&chunk.high.meetsTarget&&after.video.encode_failures===0&&
          after.video.encode_timeouts===0&&after.video.send_failures===0&&after.audio.send_failures===0&&
          extra.every((_,index)=>chunk['extra'+index].meetsTarget)&&chunk.continuousAudioChecks.every(check=>check.passed);
        if(compact)for(const key of ['beforeDiagnostics','afterDiagnostics','previewAudio','highAudio'])delete chunk[key];
        entry.performance.chunks.push(chunk);entry.performance.meetsTarget&&=chunk.meetsTarget;
        delete entry.performance.pendingInterval;
        fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
        console.log(`${encoder}: room ${elapsed+10}s preview=${chunk.preview.decodedFps.toFixed(2)} HQ=${chunk.high.decodedFps.toFixed(2)}`+
          extra.map((_,index)=>` extra${index}=${chunk['extra'+index].decodedFps.toFixed(2)}`).join('')+` fps target=${chunk.meetsTarget}`);
      }
      if(continuous)await Promise.all(audioPages.map(([,page])=>continuousAudio.stop(page)));
      assert(entry.performance.meetsTarget,'Sustained dual-tier room video/audio delivery missed its target');
    }
    for(const page of additional)await page.close();
    fixture.stdin.write('pause\n');await sleep(800);
    entry.static=await Promise.all([observe(dir,2500),observe(scene,2500)]);
    for(const observation of entry.static){assert(observation.observations.length>40,'Static frames not paced');assert.equal(new Set(observation.observations.map(f=>f.id)).size,1);}
    fixture.stdin.write('resume\n');
    if(!remoteEnabled){
      // Run the existing Windows director UI contract against the Mac bundle.
      // Only the launch adapter differs; its shared assertions stay intact.
      await director.runRemoteControlContract({page:dir,uuid,
        config:{...config,remoteControlContract:'disabled',targetBitrateKbps:2500,requestWidth:960,requestHeight:540,strictNegotiation:false},
        publisher:{args:publisherArgs.map(arg=>arg.startsWith('--remote-token=')?'--remote-token=<redacted>':arg)},report:entry,check:async(name,fn)=>{
          const outcome=await fn();entry.checks.push({name,...outcome});return outcome;
        }});
      // Disabling remote control must also reject an otherwise valid token.
      const sceneUuid=await scene.evaluate(()=>Object.keys(window.session.rpcs)[0]);
      check(await director.installMessageProbe(scene,sceneUuid),'Disabled scene message probe');
      const rejectionStart=await scene.evaluate(()=>window.__directorRoomE2EProbe.messages.length);
      check(await director.sendDirectorRequest(scene,sceneUuid,{targetBitrate:1200,remote:remoteToken}),'Disabled token control');
      check(await director.waitForProbeMessage(scene,"entry => entry.message.rejected === 'targetBitrate' && entry.message.reason === 'unauthorized'",10000,rejectionStart),'Disabled token rejection');
      check(await director.settleUnsupportedAlerts(scene,6000),'Disabled token alert');
      entry.phases.push({phase:'controls-disabled',director:await media(dir,640,360,'Disabled director still plays'),scene:await media(scene,1280,720,'Disabled scene unchanged')});
      entry.finalAudio=await observeAudio(scene);requireAudio(entry.finalAudio);
      entry.finalDiagnostics=await api(control,'/diagnostics');
      assert.equal(entry.finalDiagnostics.video.configured_bitrate_kbps,4000);
      assert.equal(entry.finalDiagnostics.video.configured_width,1280);assert.equal(entry.finalDiagnostics.video.configured_height,720);
      await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));
      assert(!fs.readFileSync(path.join(report,encoder+'-publisher.log'),'utf8').includes(remoteToken),'Remote token in logs');
      await dir.close();await scene.close();entry.passed=true;console.log(encoder+': disabled remote controls passed');
      fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));continue;
    }
    // Join through the real hosted guest UI. Chrome exposes only synthetic
    // devices. Never inject an init/role message; observe the site's own role.
    async function joinGuest(label){
      const page=await pageAt(`https://vdo.ninja/?room=${room}&password=${password}&stereo=1&label=ControlledGuest&easyexit`,true);
      await page.getByText('Join Room with Camera',{exact:true}).click();
      await page.locator('#gowebcam').waitFor({state:'visible'});
      const devices=await page.locator('#videoSourceSelect option').allTextContents();
      assert(devices.some(name=>name.startsWith('fake_device_')),'Synthetic camera absent');
      assert(devices.every(name=>name.startsWith('fake_device_')||name==='Disable Video'),'Unexpected physical camera in browser');
      assert.equal((await page.locator('#gowebcam').innerText()).trim(),'START');
      // START pulses continuously; a pointer stability wait can time out.
      // Activate the ready visible button through its normal keyboard path.
      await waitFor(()=>page.locator('#gowebcam').isEnabled(),15000,'Guest media devices did not become ready');
      await page.locator('#gowebcam').focus();await page.locator('#gowebcam').press('Enter');
      const peerUuid=await waitFor(()=>page.evaluate(stream=>Object.keys(window.session?.rpcs||{}).find(id=>window.session.rpcs[id].streamID===stream),stream),30000,'Guest did not connect to Mac publisher');
      await waitFor(async()=>{const probe=await director.installMessageProbe(page,peerUuid);return probe.ok;},15000,'Guest data channel did not open');
      const routing=check(await director.waitForStatsInfo(page,peerUuid,"info => info.room_init_received === true && info.assigned_role === 'guest' && info.assigned_tier === 'lq'",15000),'Natural guest LQ assignment');
      const received=await media(page,640,360,label,4,peerUuid);
      const [audio,decoded]=await Promise.all([observeAudio(page,peerUuid),observeDecoded(page,4000,peerUuid)]);requireAudio(audio);
      const distinctDecoded=requireMoving(decoded,label+' decoded track');
      const decodedFps=distinctDecoded/((decoded.ended-decoded.started)/1000);
      assert.equal(decoded.width,640);assert.equal(decoded.height,360);assert(decodedFps>=28.5,'Guest preview missed 95% of its 30 fps target');
      const guestStream=await page.evaluate(()=>window.session.streamID);
      assert(guestStream&&guestStream!==stream,'Guest has no independent publication');
      // Ensure START really publishes: the director must decode the guest's
      // synthetic video, independently of the Mac publication being received.
      const published=await waitFor(()=>dir.evaluate(async guestStream=>{
        const pc=Object.values(window.session.rpcs).find(pc=>pc.streamID===guestStream);
        if(!pc)return null;
        const stats=[...await pc.getStats()].map(([,s])=>s).filter(s=>s.type==='inbound-rtp');
        const video=stats.find(s=>s.kind==='video'&&s.framesDecoded>15);
        const audio=stats.find(s=>s.kind==='audio'&&s.packetsReceived>15);
        return video&&audio?{video,audio}:null;
      },guestStream),15000,'Director did not receive synthetic guest publication');
      const diagnostics=await api(control,'/diagnostics');
      assert(diagnostics.peers.some(p=>p.room.role==='guest'&&p.room.assigned_tier==='lq'),'No guest/LQ diagnostics');
      await page.screenshot({path:path.join(report,`${encoder}-${label.replaceAll(' ','-')}.png`)});
      return {page,peerUuid,evidence:{label,devices,routing:routing.state.info,received,decoded,decodedFps,audio,published,diagnostics}};
    }
    async function leaveGuest(guest,abrupt=false){
      if(proxy)return roomRecovery.leave({guest,diagnostics:()=>api(control,'/diagnostics'),survivors,abrupt});
      const started=Date.now();
      const evidence=guest.evidence.leave={action:'Hosted guest Hang up button',observations:[],promptCleanupPassed:false};
      await guest.page.evaluate(peerUuid=>{
        window.__guestLeaveEvidence=[];
        const rpc=window.session.rpcs[peerUuid];
        window.__guestLeavePeer=rpc;
        window.__guestLeaveChannels=[rpc?.sendChannel,rpc?.receiveChannel].filter(Boolean);
        window.__guestLeaveEnabled=true;
        for(const channel of window.__guestLeaveChannels)channel.addEventListener('close',()=>{
          window.__guestLeaveEvidence.push({time:Date.now(),event:'close',channel:channel.label,toPublisher:true,
            state:channel.readyState,bufferedAmount:channel.bufferedAmount});
        });
      },guest.peerUuid);
      const absent=async()=>{
        const diagnostics=await api(control,'/diagnostics');
        const peers=diagnostics.peers.filter(p=>p.room.role==='guest');
        evidence.observations.push({elapsedMs:Date.now()-started,peers:peers.map(p=>({uuid:p.uuid,
          state:p.last_connection_state,transport:p.transport,media:p.media})),peerCounts:diagnostics.peer_counts});
        if(peers.length)return false;
        evidence.elapsedMs=Date.now()-started;evidence.diagnostics=diagnostics;return true;
      };
      await guest.page.getByRole('button',{name:'Hang up',exact:true}).click();
      // Product QA target, not a VDO.Ninja acknowledgement/deadline contract.
      // VDO sends bye on the established data channel and immediately closes.
      try{await waitFor(absent,15000,'Guest peer retained after explicit Hang up');evidence.promptCleanupPassed=true;}
      catch(error){
        evidence.promptCleanupError=String(error);
        console.log(encoder+': prompt guest cleanup failed; observing bounded fallback without waiving failure');
        // Preserve the original failure. Diagnose the separately documented
        // 90-second transport-retention fallback without turning it into a pass.
        let cleanupDone=false;evidence.fallbackPlayback=[];
        const cleanup=waitFor(absent,110000,'Guest remained beyond transport cleanup window').finally(()=>{cleanupDone=true;});
        const playback=(async()=>{
          do{
            const [directorVideo,sceneVideo,directorAudio,sceneAudio]=await Promise.all([
              media(dir,640,360,'Director during guest cleanup',10,uuid),media(scene,1280,720,'Scene during guest cleanup',10),
              observeAudio(dir,uuid),observeAudio(scene)]);
            requireAudio(directorAudio);requireAudio(sceneAudio);
            evidence.fallbackPlayback.push({directorVideo,sceneVideo,directorAudio,sceneAudio});
          }while(!cleanupDone);
        })();
        const [cleaned,played]=await Promise.allSettled([cleanup,playback]);
        evidence.fallbackCleanupPassed=cleaned.status==='fulfilled';
        evidence.fallbackPlaybackPassed=played.status==='fulfilled';
        if(cleaned.status==='rejected')evidence.fallbackCleanupError=String(cleaned.reason);
        if(played.status==='rejected')evidence.fallbackPlaybackError=String(played.reason);
        throw error;
      }finally{
        evidence.browserCleanupSends=await guest.page.evaluate(()=>window.__guestLeaveEvidence||[]).catch(()=>[]);
        evidence.finalDiagnostics=await api(control,'/diagnostics');
      }
      if(expectClosedGuestCleanup){
        const suppressed=evidence.browserCleanupSends.filter(e=>e.toPublisher&&e.bye);
        assert(suppressed.length>0&&suppressed.every(e=>e.droppedByDiagnostic&&!e.returned),'BYE suppression was not established');
        const nativeGuest=guest.evidence.diagnostics.peers.find(p=>p.room.role==='guest');assert(nativeGuest);
        await waitFor(()=>fs.readFileSync(path.join(report,encoder+'-publisher.log'),'utf8').split('\n').some(line=>
          line.includes('Removed peer session '+nativeGuest.uuid+':')&&line.includes('reason=closed-room-guest ')),
          3000,'No terminal guest cleanup recorded');
        evidence.terminalCleanupVerified=true;
      }
      console.log(encoder+': '+guest.evidence.label+' cleanup '+evidence.elapsedMs+'ms');
      await guest.page.close();
    }
    const guest=await joinGuest('Guest UI initial');const viewer=guest.page,viewerUuid=guest.peerUuid;
    entry.guestUi={joins:[guest.evidence]};
    const rejectionStart=await viewer.evaluate(()=>window.__directorRoomE2EProbe.messages.length);
    check(await director.sendDirectorRequest(viewer,viewerUuid,{targetBitrate:1200}),'Unauthorized bitrate request');
    check(await director.waitForProbeMessage(viewer,"entry => entry.message.rejected === 'targetBitrate' && entry.message.reason === 'unauthorized'",10000,rejectionStart),'Unauthorized bitrate rejection');
    assert.equal((await api(control,'/diagnostics')).video.configured_bitrate_kbps,4000);
    const invalidStart=await viewer.evaluate(()=>window.__directorRoomE2EProbe.messages.length);
    check(await director.sendDirectorRequest(viewer,viewerUuid,{targetBitrate:1200,remote:remoteToken+'-invalid'}),'Invalid-token bitrate request');
    check(await director.waitForProbeMessage(viewer,"entry => entry.message.rejected === 'targetBitrate' && entry.message.reason === 'unauthorized'",10000,invalidStart),'Invalid-token rejection');
    assert.equal((await api(control,'/diagnostics')).video.configured_bitrate_kbps,4000);
    check(await director.sendDirectorRequest(viewer,viewerUuid,{targetBitrate:3000,remote:remoteToken}),'Authorized token bitrate request');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.video.configured_bitrate_kbps===3000;},10000,'Authorized token bitrate not committed');
    entry.phases.push({phase:'authorized-viewer',viewer:await media(viewer,640,360,'Authorized guest LQ',4,viewerUuid),scene:await media(scene,1280,720,'Scene after token bitrate change')});
    check(await director.sendDirectorRequest(viewer,viewerUuid,{targetBitrate:4000,remote:remoteToken}),'Restore bitrate');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.video.configured_bitrate_kbps===4000;},10000,'Bitrate not restored');
    let restoreSignaling,survivors;
    if(proxy){
      const sceneUuid=await scene.evaluate(stream=>Object.keys(window.session.rpcs).find(id=>window.session.rpcs[id].streamID===stream),stream);
      assert(sceneUuid,'Scene publisher peer not found');
      survivors=[{name:'director',page:dir,uuid,width:640,height:360},{name:'scene',page:scene,uuid:sceneUuid,width:1280,height:720}];
      entry.recovery={};
      restoreSignaling=await roomRecovery.begin({proxy,diagnostics:()=>api(control,'/diagnostics'),evidence:entry.recovery,
        participants:[...survivors,{name:'guest',page:viewer,uuid:viewerUuid,width:640,height:360}]});
    }
    if(guestRefresh){
      const before=(await api(control,'/diagnostics')).peers.find(p=>p.room.role==='guest');assert(before);
      check(await director.sendDirectorRequest(viewer,viewerUuid,{refreshConnection:true,remote:remoteToken}),'Existing VDO connection refresh');
      let after;
      await waitFor(async()=>{after=(await api(control,'/diagnostics')).peers.find(p=>p.uuid===before.uuid);
        return after&&after.active_wire_session!==before.active_wire_session&&after.last_connection_state==='connected'&&after.transport.data_channel_open;
      },30000,'Guest transport refresh did not reconnect');
      const scenePublisher=await scene.evaluate(stream=>Object.keys(window.session.rpcs).find(id=>window.session.rpcs[id].streamID===stream),stream);
      assert(scenePublisher,'Scene publisher not found after refresh');
      // Refresh can reorder scene videos; the synthetic guest is also present.
      // Observe the publisher by identity, never the first DOM video.
      const refreshed=entry.guestRefresh={before,after};
      fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
      refreshed.guest=await media(viewer,640,360,'Guest after transport refresh',4,viewerUuid);
      refreshed.director=await media(dir,640,360,'Director after transport refresh',4,uuid);
      refreshed.scene=await media(scene,1280,720,'Scene after transport refresh',4,scenePublisher);
      refreshed.audio=await observeAudio(viewer,viewerUuid);requireAudio(refreshed.audio);
      assert.equal(after.owner_session,before.owner_session,'Refresh replaced the logical owner');
      entry.guestRefresh=refreshed;
    }
    await leaveGuest(guest);
    entry.guestUi.afterLeave={director:await media(dir,640,360,'Director after guest leave'),scene:await media(scene,1280,720,'Scene after guest leave')};
    if(restoreSignaling)await restoreSignaling(survivors);
    for(let cycle=1;cycle<guestCycles;cycle++){
      const rejoined=await joinGuest('Guest UI rejoin'+(cycle>1?' '+cycle:''));entry.guestUi.joins.push(rejoined.evidence);await leaveGuest(rejoined,!!proxy);
    }
    // State transitions selected by a recorded seed, exercised through real
    // hosted controls. Every action is followed by decoded pixels and stereo
    // audio; diagnostic counters alone cannot qualify a transition.
    if(fuzzEnabled){
      entry.fuzz={seed:fuzzSeed,plan:fuzzPlan,actions:[],passed:false,
        initialPublisherRssKiB:Number(execFileSync('/bin/ps',['-o','rss=','-p',String(publisher.pid)],{encoding:'utf8'}).trim())};
      const checkpoint=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
      for(const action of fuzzPlan){
        const evidence={...action,startedAt:new Date().toISOString(),passed:false};
        entry.fuzz.actions.push(evidence);checkpoint();
        console.log(encoder+': fuzz '+fuzzSeed+' action '+action.index+' '+action.kind);
        await sleep(action.delayMs);
        if(action.kind==='guest'){
          const joined=await joinGuest('Fuzz guest '+action.index);
          evidence.guest=joined.evidence;
          await sleep(action.holdMs);await leaveGuest(joined);
        }else if(action.kind==='bitrate'){
          check(await director.sendDirectorRequest(dir,uuid,{targetBitrate:action.bitrateKbps}),'Fuzz bitrate');
          await waitFor(async()=>(await api(control,'/diagnostics')).video.configured_bitrate_kbps===action.bitrateKbps,10000,'Fuzz bitrate not committed');
        }else if(action.kind==='keyframe'){
          evidence.before=await videoCounters(dir);
          check(await director.requestVdoKeyframe(dir,uuid),'Fuzz keyframe');
          await waitFor(async()=>{evidence.after=await videoCounters(dir);return evidence.after.keyframes>evidence.before.keyframes;},2500,'Fuzz keyframe absent');
        }else{
          const audio=action.kind==='audio',button=audio?'mute-guest':'mute-video-guest',field=audio?'audio_enabled':'video_enabled';
          await toggle(button,field,false);await sleep(action.holdMs);
          if(audio){
            evidence.muted=await observeAudio(dir,uuid);
            assert(evidence.muted.spectra.filter(s=>s.rms<.0005).length>=25,'Fuzz director did not mute');
          }else{
            evidence.before=await videoCounters(dir);
            await sleep(1000);evidence.after=await videoCounters(dir);
            assert(evidence.after.frames-evidence.before.frames<=2,'Fuzz muted director kept decoding');
          }
          evidence.unaffectedScene=await media(scene,1280,720,'Fuzz scene while preview muted',2);
          evidence.unaffectedAudio=await observeAudio(scene);requireAudio(evidence.unaffectedAudio);
          await toggle(button,field,true);await sleep(800);
        }
        const [preview,high,audio]=await Promise.all([
          media(dir,640,360,'Fuzz preview restored',2,uuid),media(scene,1280,720,'Fuzz scene restored',2),observeAudio(scene)]);
        requireAudio(audio);evidence.output={preview,high,audio};
        evidence.previewAudio=await observeAudio(dir,uuid);requireAudio(evidence.previewAudio);
        evidence.diagnostics=await api(control,'/diagnostics');
        evidence.publisherRssKiB=Number(execFileSync('/bin/ps',['-o','rss=','-p',String(publisher.pid)],{encoding:'utf8'}).trim());
        assert.equal(evidence.diagnostics.peers.filter(p=>p.room.role==='guest').length,0,'Fuzz leaked guest session');
        assert.equal(publisher.exitCode,null,'Publisher exited during fuzz');
        evidence.finishedAt=new Date().toISOString();evidence.passed=true;checkpoint();
      }
      check(await director.sendDirectorRequest(dir,uuid,{targetBitrate:4000}),'Restore fuzz bitrate');
      await waitFor(async()=>(await api(control,'/diagnostics')).video.configured_bitrate_kbps===4000,10000,'Fuzz bitrate restoration failed');
      if(fuzzLocalControl){
        entry.fuzz.localControl={};checkpoint();
        await require('./macos-live-control-fuzz')(control,fuzzSeed,entry.fuzz.localControl);
        entry.fuzz.afterMalformedRequests={
          preview:await media(dir,640,360,'Preview after malformed control requests',3,uuid),
          high:await media(scene,1280,720,'Scene after malformed control requests',3),
          audio:await observeAudio(scene)};
        requireAudio(entry.fuzz.afterMalformedRequests.audio);
      }
      entry.fuzz.passed=true;checkpoint();
    }
    check(await director.changeDirectorResolutionThroughUi(dir,uuid,960,540),'Director resolution controls');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.video.configured_width===960&&d.video.configured_height===540;},20000,'Director resolution not committed');
    check(await director.closeDirectorVideoSettings(dir,uuid),'Close director settings');
    entry.phases.push({phase:'resized',director:await media(dir,640,360,'Director LQ after HQ resize'),scene:await media(scene,960,540,'Resized scene HQ')});
    // Real director controls: the shared HQ bitrate can change while preview
    // sizing stays fixed, and peer mute controls must not stop the scene.
    check(await director.clickSceneStatsButton(dir,uuid),'Open director stats');
    check(await director.waitForSceneStatsUi(dir,uuid,15000),'Director stats rendered');
    check(await director.clickStatsBitrateControl(dir,uuid,2500),'Director bitrate UI');
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.video.configured_bitrate_kbps===2500;},15000,'Bitrate not committed');
    entry.bitrateDiagnostics=await api(control,'/diagnostics');
    entry.phases.push({phase:'bitrate',director:await media(dir,640,360,'LQ after bitrate change'),scene:await media(scene,960,540,'HQ after bitrate change')});
    async function toggle(action,field,enabled){
      check(await director.clickDirectorQualityButton(dir,uuid,action),'Director '+action);
      check(await director.settleUnsupportedAlerts(dir,1500,/Per-peer Low\/High quality selection is not supported/i),'Known quality alert handling');
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.peers.some(p=>p.room.role==='director'&&p.media[field]===enabled);},10000,'Director media state did not change');
    }
    await toggle('mute-guest','audio_enabled',false);await sleep(800);entry.directorMutedAudio=await observeAudio(dir);
    assert(entry.directorMutedAudio.spectra.filter(s=>s.rms<.0005).length>=25,'Director audio did not mute');
    entry.sceneWhileDirectorMuted=await observeAudio(scene);requireAudio(entry.sceneWhileDirectorMuted);
    await toggle('mute-guest','audio_enabled',true);await sleep(800);entry.directorUnmutedAudio=await observeAudio(dir);requireAudio(entry.directorUnmutedAudio);
    await toggle('mute-video-guest','video_enabled',false);await sleep(800);const beforeMuted=await videoCounters(dir);
    entry.sceneWhileDirectorVideoMuted=await media(scene,960,540,'Scene while director video muted',3);
    const afterMuted=await videoCounters(dir);assert(afterMuted.frames-beforeMuted.frames<=2,'Director video kept decoding while muted');entry.mutedVideo={before:beforeMuted,after:afterMuted};
    await toggle('mute-video-guest','video_enabled',true);entry.directorVideoResumed=await media(dir,640,360,'Director video resumed');
    // Synchronize immediately after a natural keyframe, then request two more
    // inside the LQ encoder's one-second GOP. A periodic IDR alone cannot pass.
    const natural=await videoCounters(dir);let beforeKeyframe;
    await waitFor(async()=>{beforeKeyframe=await videoCounters(dir);return beforeKeyframe.keyframes>natural.keyframes;},2500,'No natural LQ keyframe');
    const keyframeStarted=Date.now();
    for(let request=1;request<=2;request++){
      check(await director.requestVdoKeyframe(dir,uuid),'Director keyframe request');
      await waitFor(async()=>{const after=await videoCounters(dir);entry.keyframe={before:beforeKeyframe,after,elapsedMs:Date.now()-keyframeStarted};return after.keyframes>=beforeKeyframe.keyframes+request;},500,'Requested keyframe did not arrive promptly');
    }
    assert(entry.keyframe.elapsedMs<800,'Requested keyframes took a full GOP');
    // Rejoin a scene while the director's independent preview keeps running.
    await scene.close();const late=await pageAt(`https://vdo.ninja/?scene=0&room=${room}&password=${password}&autostart&stereo=1&cleanoutput`);
    entry.phases.push({phase:'late-scene',scene:await media(late,960,540,'Late scene HQ'),director:await media(dir,640,360,'Director during scene churn')});
    entry.lateAudio=await observeAudio(late);requireAudio(entry.lateAudio);
    diag=await api(control,'/diagnostics');entry.finalDiagnostics=diag;
    assert(diag.room_quality.effective&&diag.video.lq_encoder_initialized&&diag.video.lq_encoder.includes('x264'));assert.equal(diag.video.hardware_encoder,encoder==='videotoolbox');
    assert(diag.system.cpu_percent>=0&&diag.system.cpu_percent<=100&&diag.system.memory_total_bytes>0,'Native system resource metrics unavailable');
    await dir.screenshot({path:path.join(report,encoder+'-director.png'),fullPage:true});await late.screenshot({path:path.join(report,encoder+'-scene.png')});
    await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery));
    assert(!fs.readFileSync(path.join(report,encoder+'-publisher.log'),'utf8').includes(remoteToken),'Remote token in logs');
    if(passwordProtected){assert(!fs.readFileSync(path.join(report,encoder+'-publisher.log'),'utf8').includes(password),'Password in logs');entry.passwordNotExposedInLog=true;}
    await dir.close();await late.close();entry.passed=true;console.log(encoder+': room workflow passed');fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
  }
  if(dropGuestBye&&!expectClosedGuestCleanup)throw Error('Guest bye negative control did not trigger the required prompt-cleanup rejection');
  result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
  if(browser)for(const [i,page] of browser.contexts().flatMap(c=>c.pages()).entries())try{await page.screenshot({path:path.join(report,'failure-'+i+'.png')});fs.writeFileSync(path.join(report,'failure-'+i+'.json'),JSON.stringify(await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(0,5000),rpc:Object.fromEntries(Object.entries(window.session?.rpcs||{}).map(([k,r])=>[k,{stream:r.streamID,info:r.stats?.info}]))})),null,2));}catch{}
}finally{for(const p of children)p.kill('SIGTERM');if(browser)await browser.close().catch(()=>{});await Promise.all([...children].map(async p=>{await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');await p.closed;}));
  for(const [proxy,entry] of proxies){entry.proxyFinal=proxy.snapshot();try{await proxy.close();entry.proxyClosed=proxy.snapshot();assert.equal(entry.proxyClosed.unexpectedErrors,0);}catch(error){result.passed=false;entry.passed=false;entry.proxyCleanupError=String(error);process.exitCode=1;}}
  fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));}})();
