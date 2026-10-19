#!/usr/bin/env node
'use strict';
// Packaged Mac camera/input -> WHIP -> independent MediaMTX/browser receiver.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http'),net=require('net'),dgram=require('dgram');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiverAt,observe,observeDecoded,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
if(process.platform!=='darwin'||!opts.app||!opts.reports||!opts.server||!opts['camera-device']||!opts['camera-helper']||!opts['tone-helper']||!opts['microphone-device'])
  throw Error('Required: --app, --reports, --server, --camera-device, --camera-helper, --microphone-device and --tone-helper');
const turnDiscovery=opts['turn-discovery']||'none';
const unresponsiveStun=opts['unresponsive-stun']==='true';
const cadenceSeconds=Number(opts['cadence-seconds']||0);
if(!Number.isInteger(cadenceSeconds)||cadenceSeconds<0||cadenceSeconds>120||cadenceSeconds%10)throw Error('--cadence-seconds must be 0 or a multiple of 10 up to 120');
const restartCycles=opts['restart-cycles']===undefined?null:Number(opts['restart-cycles']);
if(restartCycles!==null&&(!Number.isInteger(restartCycles)||restartCycles<1||restartCycles>5))throw Error('--restart-cycles must be an integer from 1 to 5');
if(unresponsiveStun&&(turnDiscovery!=='none'||opts.gui))throw Error('Unresponsive STUN workflow requires headless publishing without TURN discovery');
if(!['none','options','post'].includes(turnDiscovery)||
   (turnDiscovery!=='none'&&(!opts['turn-server']||opts.gui)))
  throw Error('TURN workflow requires --turn-discovery=options|post and --turn-server without --gui');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
if(opts.gui&&!opts['ui-helper'])throw Error('GUI workflow requires --ui-helper');
if(opts['relaunch-app']&&!opts.gui)throw Error('--relaunch-app requires the GUI saved-profile workflow');
const guiEncoder=opts['gui-encoder']||'videotoolbox';
if(!['videotoolbox','x264'].includes(guiEncoder)||opts['gui-encoder']&&!opts.gui)throw Error('--gui-encoder requires GUI and videotoolbox or x264');
const settingsDirectory=path.join(report,'settings');
const exe=path.join(path.resolve(opts.app),'Contents/MacOS/game-capture');
if(!fs.existsSync(path.join(path.resolve(opts.app),'Contents/Frameworks')))throw Error('Use a deployed bundle');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const relaunchExe=opts['relaunch-app']?path.join(path.resolve(opts['relaunch-app']),'Contents/MacOS/game-capture'):exe;
if(opts['relaunch-app']&&(!fs.existsSync(path.join(path.resolve(opts['relaunch-app']),'Contents/Frameworks'))||hash(relaunchExe)===hash(exe)))throw Error('Use a different deployed application for profile migration');
const result={executableSha256:hash(exe),harnessSha256:hash(__filename),receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),
  helperSha256:opts.gui?hash(path.resolve(opts['ui-helper'])):null,serverSha256:hash(path.resolve(opts.server)),gui:!!opts.gui,scope:'Packaged WHIP with controlled virtual camera/input and local MediaMTX; release/remote TURN qualification excluded',cases:[],trace:[],passed:false};
result.turnDiscovery=turnDiscovery;
result.restartCycles=restartCycles;
result.cadenceSeconds=cadenceSeconds;
result.cameraFixtureSha256=hash(path.resolve(opts['camera-helper']));
result.toneFixtureSha256=hash(path.resolve(opts['tone-helper']));
if(opts['browser-executable'])result.browserExecutableSha256=hash(path.resolve(opts['browser-executable']));
if(opts['relaunch-app'])result.profileMigration={initialExecutableSha256:hash(exe),relaunchExecutableSha256:hash(relaunchExe),scope:'Same private preferences and Keychain profile across two retained packaged binaries; no credentials re-entered. Not an installation replacement or fresh-machine workflow.'};
if(turnDiscovery!=='none')result.turnServerSha256=hash(path.resolve(opts['turn-server']));
for(const name of ['macos-whip-publish.js','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const children=new Set();let browser,proxy,server,stalledStun;
const token=crypto.randomBytes(24).toString('hex');let currentCase='',reject=false;
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_)/.test(k)));
  const p=spawn(path.resolve(program),args,{env,cwd:report,stdio:['pipe','pipe','pipe']});children.add(p);
  p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});let output='';p.stdout.on('data',d=>output+=d);p.output=()=>output;
  p.closed=new Promise(resolve=>p.once('close',code=>{children.delete(p);log.end();resolve(code);}));p.once('error',e=>{result.launchError=String(e);});return p;
}
async function port(udp=false){const s=udp?dgram.createSocket('udp4'):net.createServer();await new Promise(r=>udp?s.bind(0,'127.0.0.1',r):s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function stunReady(port){
  const socket=dgram.createSocket('udp4'),request=Buffer.alloc(20);
  request.writeUInt16BE(1);request.writeUInt32BE(0x2112a442,4);crypto.randomFillSync(request,8,12);
  return new Promise(resolve=>{
    let settled=false;
    const done=value=>{if(settled)return;settled=true;clearTimeout(timer);socket.close();resolve(value);};
    const timer=setTimeout(()=>done(false),300);
    socket.on('error',()=>done(false));
    socket.on('message',reply=>done(reply.length>=20&&reply.readUInt16BE(0)===0x101&&reply.subarray(8,20).equals(request.subarray(8,20))));
    socket.send(request,port,'127.0.0.1',error=>{if(error)done(false);});
  });
}
async function api(control,route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Control request failed '+r.status);return r.json();}
function audioCheck(value,silent=false){
  if(!value.tracks.some(t=>t.codec==='audio/opus'&&t.packetsReceived>20))throw Error('Receiver has no Opus packets');
  if(value.spectra.filter(s=>silent?s.rms<.0005:s.rms>.001&&s.tone440>-65&&s.tone880>-65&&s.channels[0].tone440>s.channels[0].tone880+20&&s.channels[1].tone880>s.channels[1].tone440+20).length<25)
    throw Error('Received microphone stereo/silence does not match the controlled input');
}
(async()=>{console.log('Reports: '+report);try{
  if(opts.gui){result.sessionState=JSON.parse(execFileSync(path.resolve(opts['ui-helper']),[String(process.pid),'session-state'],{encoding:'utf8',timeout:5000}));if(result.sessionState.screenLocked)throw Error('Unlock the Mac before running GUI workflows');}
  const webPort=await port(),apiPort=await port(),udpPort=await port(true);
  let turnConfig='';
  if(turnDiscovery!=='none'){
    const turnPort=await port(true),turnPassword=crypto.randomBytes(24).toString('hex');
    const turn=launch(opts['turn-server'],['-n','--listening-ip=127.0.0.1','--relay-ip=127.0.0.1',`--listening-port=${turnPort}`,
      '--no-tcp','--no-tls','--no-dtls','--no-tcp-relay','--allow-loopback-peers','--no-multicast-peers',
      '--lt-cred-mech','--realm=game-capture-loopback-fixture',`--user=gcqa:${turnPassword}`,'--fingerprint','--relay-threads=1',
      `--userdb=${path.join(report,'turn.sqlite')}`,`--pidfile=${path.join(report,'turn.pid')}`,'--log-file=stdout','--simple-log'],'turn');
    await waitFor(()=>{if(turn.exitCode!==null)throw Error('Owned TURN server exited');return stunReady(turnPort);},10000,'TURN server did not answer local STUN probe');
    turnConfig=`webrtcICEServers2:\n  - url: turn:127.0.0.1:${turnPort}?transport=udp\n    username: gcqa\n    password: ${JSON.stringify(turnPassword)}\n    clientOnly: true\n`;
    result.turnListener={address:'127.0.0.1',port:turnPort};
  }
  const config=path.join(report,'mediamtx.yml');fs.writeFileSync(config,`logLevel: info\napi: true\napiAddress: 127.0.0.1:${apiPort}\nrtsp: false\nrtmp: false\nsrt: false\nhls: false\nmoq: false\nwebrtcAddress: 127.0.0.1:${webPort}\nwebrtcLocalUDPAddress: 127.0.0.1:${udpPort}\nwebrtcIPsFromInterfaces: false\nwebrtcAdditionalHosts: [127.0.0.1]\n${turnConfig}paths:\n  all_others:\n`);
  let generation=0;
  async function startServer(){server=launch(opts.server,[config],'server-'+generation++);await waitFor(async()=>{if(server.exitCode!==null)throw Error('Server exited');return fetch(`http://127.0.0.1:${apiPort}/v3/paths/list`).then(r=>r.ok).catch(()=>false);},10000,'MediaMTX did not start');}
  await startServer();
  if(unresponsiveStun){
    // Bind and deliberately discard only this fixture's requests; no firewall
    // changes and no dependence on an external host remaining unavailable.
    stalledStun=dgram.createSocket('udp4');result.unresponsiveStun={requests:0};
    stalledStun.on('message',()=>++result.unresponsiveStun.requests);
    await new Promise(resolve=>stalledStun.bind(0,'127.0.0.1',resolve));
  }
  proxy=http.createServer((req,res)=>{
    const authorized=req.headers.authorization==='Bearer '+token;
    const trace={case:currentCase,method:req.method,authorized,path:req.url};result.trace.push(trace);
    if(reject||!authorized){res.writeHead(401);res.end();return;}
    if(req.method==='POST'){
      const chunks=[];req.on('data',chunk=>chunks.push(chunk));
      req.on('end',()=>{trace.candidateTypes=[...Buffer.concat(chunks).toString().matchAll(/^a=candidate:.*? typ (\S+)/gm)].map(m=>m[1]);});
    }
    const upstream=http.request({hostname:'127.0.0.1',port:webPort,path:req.url,method:req.method,headers:{'content-type':req.headers['content-type']||'application/sdp'}},reply=>{
      const headers={...reply.headers};
      if(unresponsiveStun&&req.method==='OPTIONS')headers.link=`<stun:127.0.0.1:${stalledStun.address().port}>; rel="ice-server"`;
      if(turnDiscovery==='post'&&req.method==='OPTIONS')delete headers.link;
      trace.status=reply.statusCode;trace.advertisesTurn=/\bturns?:/.test(String(headers.link||''));
      if(headers.location){const url=new URL(headers.location,`http://127.0.0.1:${webPort}`);headers.location=`http://127.0.0.1:${proxy.address().port}`+url.pathname+url.search;}
      res.writeHead(reply.statusCode,headers);reply.pipe(res);
    });upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
  });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const fixture=launch(opts['camera-helper'],[opts['camera-device']],'camera');
  const tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');
  for(const p of [fixture,tone])await waitFor(()=>{if(p.exitCode!==null)throw Error('Fixture exited');return p.output().includes('READY');},5000,'Fixture did not start');
  browser=await chromium.launch({headless:true,...(opts['browser-executable']?{executablePath:path.resolve(opts['browser-executable'])}:{}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  result.browserVersion=browser.version();
  for(const encoder of (opts.gui?[guiEncoder]:['videotoolbox','x264'])){
    currentCase=encoder;const entry={encoder,passed:false};result.cases.push(entry);const stream='whip'+crypto.randomBytes(12).toString('hex');
    const discovery=path.join(report,encoder+'-control.json');
    const guiArgs=[`--settings-dir=${settingsDirectory}`,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`];
    let publisher=launch(exe,opts.gui?guiArgs:['--headless','--source=camera',`--camera-id=${opts['camera-device']}`,'--output=whip',`--output-url=http://127.0.0.1:${proxy.address().port}/${stream}/whip`,`--output-token=${token}`,
      ...(turnDiscovery!=='none'?['--ice-mode=relay']:[]),
      '--audio-source=none','--include-microphone',`--microphone-device=${opts['microphone-device']}`,`--video-encoder=${encoder}`,'--video-codec=h264','--width=640','--height=360','--fps=30','--bitrate-kbps=2000',`--duration-ms=${180000+(restartCycles||0)*60000+cadenceSeconds*1000}`,'--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],encoder);
    async function ready(){await waitFor(()=>{if(publisher.exitCode!==null)throw Error('Publisher exited before ready');return fs.existsSync(discovery);},10000,'No control discovery');return JSON.parse(fs.readFileSync(discovery));}
    let control=await ready();
    const ui=(action,name,value)=>execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),action,...(name?[name]:[]),...(value!==undefined?[value]:[])],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
    const waitUiRead=async(action,name,phase)=>{
      const began=Date.now();let attempts=0;
      await waitFor(()=>{
        if(publisher.exitCode!==null||publisher.signalCode)throw Error('Publisher exited before GUI readiness');
        attempts++;
        try {const value=ui(action,name);return action==='actions'?JSON.parse(value).includes('AXPress'):true;}
        catch(error){if((action==='actions'&&error.status===3)||(action==='source-ready'&&error.status===4))return false;throw error;}
      },10000,`GUI readiness timed out: ${phase}`);
      (entry.guiReadiness??=[]).push({phase,action,name,attempts,elapsedMs:Date.now()-began});
    };
    if(opts.gui){
      await waitUiRead('actions','sourceModeSelect','initial window');ui('press','sourceModeSelect');await sleep(250);ui('press','Camera / Webcam');await waitUiRead('source-ready','OBS Virtual Camera','initial camera discovery');ui('select-source','OBS Virtual Camera');
      ui('press','microphoneDeviceSelect');await sleep(250);ui('press','BlackHole 2ch');await sleep(300);
      ui('press','advancedToggle');await sleep(250);
      ui('press','encoderSelect');await sleep(250);ui('press',encoder==='videotoolbox'?'Apple VideoToolbox':'Software (x264 / VP9 / AV1)');await sleep(250);
      ui('press','outputSelect');await sleep(250);ui('press','WHIP');await sleep(250);
      ui('set','outputUrlInput',`http://127.0.0.1:${proxy.address().port}/${stream}/whip`);ui('set','outputSecretInput',token);await sleep(500);
      const ini=fs.readFileSync(path.join(settingsDirectory,'VDO.Ninja/Game Capture.ini'),'utf8');
      if(ini.includes(token)||ini.includes(stream)||!ini.includes('profilesEncrypted='))throw Error('Output profile was not stored as an opaque Keychain reference');
      await api(control,'/commands',{command:'quit'});await publisher.closed;if(publisher.exitCode!==0)throw Error('Profile-save shutdown failed');
      await waitFor(()=>!fs.existsSync(discovery),5000,'Old discovery survived profile-save shutdown');
      publisher=launch(relaunchExe,guiArgs,encoder+'-relaunch');control=await ready();await waitUiRead('actions','sourceModeSelect','relaunched window');
      const restoredIni=fs.readFileSync(path.join(settingsDirectory,'VDO.Ninja/Game Capture.ini'),'utf8');
      const profileReference=text=>text.match(/^profilesEncrypted=.*$/m)?.[0];
      if(!profileReference(ini)||profileReference(ini)!==profileReference(restoredIni)||restoredIni.includes(token)||restoredIni.includes(stream))throw Error('Saved Keychain profile reference changed or leaked on relaunch');
      entry.sameKeychainReference=true;
      // No endpoint/token command-line arguments and no credential re-entry:
      // successful authenticated publishing proves the persisted profile loaded.
      await waitUiRead('source-ready','OBS Virtual Camera','relaunched camera discovery');ui('select-source','OBS Virtual Camera');ui('verify-selected','OBS Virtual Camera');ui('press','goLiveButton');entry.profileRelaunched=true;entry.publishingExecutableSha256=hash(relaunchExe);
    }
    const url=`http://127.0.0.1:${webPort}/${stream}/?muted=true`;
    let page=await receiverAt(browser,url,publisher);entry.moving=await observe(page,6000);entry.distinctFrames=requireMoving(entry.moving,encoder);entry.audio=await observeAudio(page);audioCheck(entry.audio);
    if(cadenceSeconds){
      entry.cadence=[];
      const fixtureState=async()=>{
        const offset=fixture.output().length;fixture.stdin.write('state\n');
        return waitFor(()=>{
          for(const line of fixture.output().slice(offset).split('\n'))if(line.startsWith('{')&&line.endsWith('}')){
            const state=JSON.parse(line);if(Number.isInteger(state.publishedFrames)&&Number.isFinite(state.time))return state;
          }
          if(fixture.exitCode!==null)throw Error('Camera fixture exited during cadence observation');
          return false;
        },5000,'Camera fixture did not report its source counter');
      };
      const browserState=()=>page.evaluate(async()=>{
        const tracks=[];
        for(const pc of window.reviewPCs)if(pc.connectionState==='connected'){
          const stats=await pc.getStats();
          for(const item of stats.values())if(item.type==='inbound-rtp'&&item.kind==='video')tracks.push({...item,codec:stats.get(item.codecId)?.mimeType,codecFmtpLine:stats.get(item.codecId)?.sdpFmtpLine});
        }
        const video=[...document.querySelectorAll('video')].find(v=>v.videoWidth&&!v.paused);
        if(!video)throw Error('No playing cadence receiver');
        const q=video.getVideoPlaybackQuality();
        return {epochMs:performance.timeOrigin+performance.now(),visibility:document.visibilityState,
          playbackRate:video.playbackRate,currentTime:video.currentTime,
          playback:{creationTime:q.creationTime,totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames},tracks};
      });
      const appState=async()=>{const d=await api(control,'/diagnostics');return {epochMs:Date.now(),video:d.video,output:d.output};};
      for(let index=0;index<cadenceSeconds/10;index++){
        const before=await Promise.all([fixtureState(),appState(),browserState()]);
        const row={index,sourceBefore:before[0],publisherBefore:before[1],receiverBefore:before[2]};entry.cadence.push(row);
        const measured=await Promise.all([observe(page,10000),observeDecoded(page,10000,null,'camera',true)]);
        row.presentation=measured[0];row.decoded=measured[1];
        requireMoving(row.presentation,'Cadence presentation');requireMoving(row.decoded,'Cadence decoded track');
        const after=await Promise.all([fixtureState(),appState(),browserState()]);
        Object.assign(row,{sourceAfter:after[0],publisherAfter:after[1],receiverAfter:after[2]});
        const rate=observation=>new Set(observation.observations.map(f=>f.id)).size/((observation.ended-observation.started)/1000);
        console.log(JSON.stringify({encoder,cadenceInterval:index,decodedDistinctFps:rate(row.decoded),presentationDistinctFps:rate(row.presentation)}));
        fs.writeFileSync(path.join(report,encoder+'-cadence.json'),JSON.stringify({scope:'Paired decoded-track and presentation observations with separate source/publisher/receiver bookends; not physical display or latency measurement',intervals:entry.cadence},null,2));
      }
    }
    tone.stdin.write('silence\n');await sleep(700);entry.silence=await observeAudio(page);audioCheck(entry.silence,true);tone.stdin.write('sound\n');
    fixture.stdin.write('pause\n');await sleep(700);entry.static=await observe(page,2500);if(new Set(entry.static.observations.map(f=>f.id)).size!==1||entry.static.observations.length<10)throw Error('Static video did not stay paced');fixture.stdin.write('resume\n');
    const late=await receiverAt(browser,url,publisher);entry.late=await observe(late,3000);requireMoving(entry.late,'Late WHIP viewer');entry.lateAudio=await observeAudio(late);audioCheck(entry.lateAudio);await late.close();
    const diag=await api(control,'/diagnostics');entry.output=diag.output;if(diag.output.state!==2||diag.video.hardware_encoder!==(encoder==='videotoolbox'))throw Error('Wrong output state/encoder');
    if(turnDiscovery!=='none'&&diag.output.ice_path!=='TURN/RELAY')throw Error('WHIP bypassed the required TURN relay');
    if(diag.source.source_id!==opts['camera-device']||!diag.audio.active_microphone_source.includes('BlackHole'))throw Error('Source identity differs');
    if(JSON.stringify(diag).includes(token)||JSON.stringify(diag).includes(stream))throw Error('Token or private endpoint path leaked into diagnostics');fs.writeFileSync(path.join(report,encoder+'-diagnostics.json'),JSON.stringify(diag,null,2));
    await page.screenshot({path:path.join(report,encoder+'-receiver.png')});
    const recoveryCount=restartCycles??((encoder==='videotoolbox'||turnDiscovery!=='none'||opts['relaunch-app'])?1:0);
    entry.serverRestarts=[];
    for(let cycle=0;cycle<recoveryCount;cycle++){
      const beforeRestart=await api(control,'/diagnostics');
      entry.reconnectsBeforeServerRestart=beforeRestart.output.reconnects;
      const recovery={cycle:cycle+1,reconnectsBefore:entry.reconnectsBeforeServerRestart,started:Date.now(),passed:false};entry.serverRestarts.push(recovery);
      await page.close();server.kill('SIGTERM');await server.closed;await sleep(1500);await startServer();
      await waitFor(async()=>{if(publisher.exitCode!==null)throw Error('Publisher exited during recovery');const d=await api(control,'/diagnostics');return d.output.reconnects>entry.reconnectsBeforeServerRestart&&d.output.state===2;},40000,'WHIP did not reconnect after the server restart');
      page=await receiverAt(browser,url,publisher);entry.reconnected=await observe(page,5000);requireMoving(entry.reconnected,'Recovered WHIP');entry.reconnectedAudio=await observeAudio(page);audioCheck(entry.reconnectedAudio);
      entry.recoveryOutput=(await api(control,'/diagnostics')).output;
      if(turnDiscovery!=='none'&&entry.recoveryOutput.ice_path!=='TURN/RELAY')throw Error('Recovered WHIP bypassed TURN');
      Object.assign(recovery,{reconnected:entry.reconnected,audio:entry.reconnectedAudio,output:entry.recoveryOutput,completed:Date.now(),passed:true});
    }
    const appLog=await api(control,'/logs/recent?lines=1');if(fs.readFileSync(appLog.path,'utf8').includes(token))throw Error('Token leaked into application log');
    await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');if(publisher.exitCode!==0||fs.existsSync(discovery))throw Error('Publisher shutdown failed');await publisher.closed;
    const finalDelete=result.trace.filter(t=>t.case===encoder&&t.method==='DELETE').at(-1);
    if(!finalDelete||!finalDelete.authorized||![200,204].includes(finalDelete.status))throw Error('Final WHIP session deletion was not acknowledged');
    const pathsResponse=await fetch(`http://127.0.0.1:${apiPort}/v3/paths/list`,{signal:AbortSignal.timeout(5000)});
    if(!pathsResponse.ok)throw Error('Cannot verify stopped publisher at receiver server');
    const stoppedPaths=await pathsResponse.json();if(!Array.isArray(stoppedPaths.items))throw Error('Invalid receiver-server path inventory');
    const stoppedPath=stoppedPaths.items.find(item=>item.name===stream);
    entry.serverAfterQuit={pathPresent:!!stoppedPath,ready:stoppedPath?.ready??false,sourcePresent:!!stoppedPath?.source};
    if(stoppedPath&&(stoppedPath.ready!==false||stoppedPath.source!==null))throw Error('Receiver server retains a live publisher after Quit');
    if(turnDiscovery!=='none'){
      const trace=result.trace.filter(t=>t.case===encoder),posts=trace.filter(t=>t.method==='POST'),options=trace.filter(t=>t.method==='OPTIONS'&&t.status===204);
      if(!options.length||!posts.length||posts.some(t=>t.status!==201))throw Error('TURN workflow lacks successful WHIP negotiation');
      if(turnDiscovery==='post'){
        if(posts.length<2||posts[0].candidateTypes.length||!posts[0].advertisesTurn||options.some(t=>t.advertisesTurn))throw Error('Expected a candidate-free discovery POST with TURN omitted from OPTIONS');
        if(!trace.slice(trace.indexOf(posts[0])+1,trace.indexOf(posts[1])).some(t=>t.method==='DELETE'))throw Error('Discovery resource was not deleted before the relayed retry');
      }else if(options.some(t=>!t.advertisesTurn))throw Error('TURN was not advertised in OPTIONS');
      const relayed=turnDiscovery==='post'?posts.slice(1):posts;
      if(relayed.some(t=>!t.candidateTypes.length||t.candidateTypes.some(type=>type!=='relay')))throw Error('Publishing offer contains missing or non-relay candidates');
      entry.turn={discovery:turnDiscovery,relayedOffers:relayed.length,discoveryDeletedBeforeRetry:turnDiscovery==='post',allPublishingCandidatesRelay:true};
    }
    for(const file of [encoder+'.log',...(opts.gui?[encoder+'-relaunch.log']:[])])
      if(fs.readFileSync(path.join(report,file),'utf8').includes(token))throw Error('Token leaked into publisher log');
    await page.close();entry.passed=true;console.log(encoder+': passed, distinct frames='+entry.distinctFrames);
  }
  if(unresponsiveStun&&result.unresponsiveStun.requests<2)throw Error('Unresponsive STUN fixture did not receive retries');
  result.passed=true;
}catch(e){result.error=String(e.stack||e).split(token).join('<redacted>');console.error(result.error);process.exitCode=1;}
finally{
  // Preserve the observation even if a failed GUI action leaves a child unable
  // to handle graceful shutdown. Escalate only the children owned by this run.
  fs.writeFileSync(path.join(report,'results-before-cleanup.json'),JSON.stringify(result,null,2));
  const pending=[...children];for(const p of pending)p.kill('SIGTERM');
  const reap=setTimeout(()=>{for(const p of pending)if(children.has(p)){
    (result.forcedCleanup??=[]).push({pid:p.pid,signal:'SIGKILL'});p.kill('SIGKILL');
  }},5000);
  try{if(browser)await browser.close().catch(()=>{});if(proxy){proxy.closeAllConnections();proxy.close();}if(stalledStun)stalledStun.close();await Promise.all(pending.map(p=>p.closed));}
  finally{clearTimeout(reap);}
  if(opts.gui){const ini=path.join(settingsDirectory,'VDO.Ninja/Game Capture.ini');if(fs.existsSync(ini)){
    const encoded=fs.readFileSync(ini,'utf8').match(/^profilesEncrypted="?@ByteArray\(([A-Za-z0-9+/=]+)\)"?$/m)?.[1];const reference=encoded?Buffer.from(encoded,'base64').toString():'';
    if(/^mac-keychain-v1:[0-9a-f-]{36}$/.test(reference))try{execFileSync('/usr/bin/security',['delete-generic-password','-s','ninja.vdo.game-capture.output-profiles','-a',reference],{stdio:'pipe'});result.ownedProfileRemoved=true;}catch(e){result.cleanupError=String(e);result.passed=false;process.exitCode=1;}
    else if(fs.readFileSync(ini,'utf8').includes('profilesEncrypted=')){result.cleanupError='Could not parse the owned QA Keychain reference';result.passed=false;process.exitCode=1;}
  }}
  fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));}})();
