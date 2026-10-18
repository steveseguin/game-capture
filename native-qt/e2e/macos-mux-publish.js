#!/usr/bin/env node
'use strict';
// Packaged app -> native H.264 -> bundled mux helper -> independent local
// MediaMTX/direct receiver -> decoded frame identities and stereo PCM.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net'),dgram=require('dgram');
const assert=require('assert/strict'),{spawn,execFileSync}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
for(const key of ['app','reports','server','ffmpeg','camera-device','camera-helper','tone-helper','microphone-device'])assert(opts[key],'Required --'+key);
assert.equal(process.platform,'darwin');
const defaultAac=opts['default-aac']==='true';
if(opts['default-aac'])assert(['true','false'].includes(opts['default-aac']),'--default-aac must be true or false');
if(defaultAac)assert(!opts.gui,'Default AAC workflow uses CLI publishing');
if(opts.gui)assert(opts['ui-helper'],'GUI workflow requires --ui-helper');
assert(['rtsp','rtmp'].includes(opts['receiver-protocol']||'rtsp'),'Receiver protocol must be rtsp or rtmp');
if(opts['receiver-protocol']==='rtmp')assert.equal(opts.protocols,'rtmp','Direct RTMP reception requires --protocols=rtmp');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
fs.copyFileSync(__filename,path.join(report,'harness.js'));
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture'),helper=path.join(app,'Contents/Helpers/ffmpeg');
const ffmpeg=path.resolve(opts.ffmpeg),ffprobe=path.join(path.dirname(ffmpeg),'ffprobe');
assert(fs.existsSync(path.join(app,'Contents/Frameworks'))&&fs.existsSync(helper),'Use the deployed bundle');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={started:new Date().toISOString(),executableSha256:hash(exe),helperSha256:hash(helper),harnessSha256:hash(__filename),
  receiverSha256:hash(ffmpeg),serverSha256:hash(path.resolve(opts.server)),gui:!!opts.gui,scope:'Local packaged camera/microphone mux workflows; WAN, physical devices and release qualification excluded',cases:[],passed:false};
result.receiverProtocol=opts['receiver-protocol']||'rtsp';
result.audioBitratePolicy=defaultAac?'Omit CLI bitrate; require configured AAC default 128 kbps':'Existing explicit 192 kbps CLI / GUI selected value';
result.receiverVersion=execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0];
result.probeSha256=hash(ffprobe);
if(opts.gui){
  result.uiHelperSha256=hash(path.resolve(opts['ui-helper']));
  result.uiHelperSourceSha256=hash(path.join(__dirname,'macos-ui-control.mm'));
  fs.copyFileSync(path.join(__dirname,'macos-ui-control.mm'),path.join(report,'macos-ui-control.mm'));
}
const children=new Set();let server;
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_|FFMPEG_)/.test(k)));
  const p=spawn(path.resolve(program),args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(p);
  p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});let output='';p.stdout.on('data',d=>output+=d);p.output=()=>output;
  p.closed=new Promise(resolve=>{p.once('close',code=>{children.delete(p);log.end();resolve(code);});p.once('error',e=>{result.launchError=String(e);});});return p;
}
async function port(udp=false){const s=udp?dgram.createSocket('udp4'):net.createServer();await new Promise(r=>udp?s.bind(0,'127.0.0.1',r):s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function rtpPorts(){for(let attempt=0;attempt<100;attempt++){const first=await port(true);if(first%2||first===65535)continue;
  const s=dgram.createSocket('udp4');const available=await new Promise(resolve=>{s.once('error',()=>resolve(false));s.bind(first+1,'127.0.0.1',()=>resolve(true));});try{s.close();}catch(e){if(e.code!=='ERR_SOCKET_DGRAM_NOT_RUNNING')throw e;}if(available)return {rtp:first,rtcp:first+1};}throw Error('No available RTP/RTCP port pair');}
async function api(control,route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'Control HTTP '+r.status);return r.json();}
function decode(file,seconds,staticAndSilent=false){
  const run=(program,args)=>execFileSync(program,args,{timeout:20000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
  const metadata=JSON.parse(run(ffprobe,['-v','error','-show_streams','-show_packets','-of','json',file]));
  const video=metadata.streams.find(s=>s.codec_type==='video'),audio=metadata.streams.find(s=>s.codec_type==='audio');
  assert.equal(video?.codec_name,'h264');assert.equal(video.width,opts.gui?960:640);assert.equal(video.height,opts.gui?540:360);
  assert.equal(audio?.codec_name,'aac');assert.equal(audio.channels,2);assert.equal(Number(audio.sample_rate),48000);
  const decoded=JSON.parse(run(ffprobe,['-v','error','-select_streams','v:0','-show_frames',
    '-show_entries','frame=key_frame,pict_type','-of','json',file])).frames;
  assert(decoded.length>0,'No independently decoded video frames');
  assert(['Baseline','Constrained Baseline'].includes(video.profile),'Unexpected live H.264 profile');
  assert(decoded.every(frame=>frame.pict_type!=='B'),'Live output contains B-frames');
  const keys=decoded.map((frame,index)=>frame.key_frame?index:-1).filter(index=>index>=0);
  const keyframeGaps=keys.slice(1).map((index,i)=>index-keys[i]);
  // Retain the late join, then measure the common steady interval. The join
  // allowance is not a claim about exact wall-clock keyframe cadence.
  const timelines=metadata.streams.map(s=>{
    const packets=metadata.packets.filter(p=>p.stream_index===s.index),allTimes=packets.map(p=>Number(p.dts_time)).filter(Number.isFinite);
    assert(packets.length>0,'Receiver recording has no '+s.codec_name+' packets');
    assert(allTimes[0]<3,'Receiver needed over three seconds to join');
    const times=allTimes.filter(t=>t>=3&&t<seconds+3);
    assert(times.length>20,'Too few timestamped packets');for(let i=1;i<times.length;i++)assert(times[i]>times[i-1],'Nonmonotonic media timestamps');
    return {codec:s.codec_name,packets:packets.length,joinTimestamp:allTimes[0],first:times[0],last:times.at(-1),duration:times.at(-1)-times[0]};
  });
  for(const t of timelines)assert(t.duration>seconds-.6&&t.duration<seconds+.6,'Unexpected media duration '+JSON.stringify(t));
  assert(Math.abs(timelines[0].duration-timelines[1].duration)<.3,'Audio/video durations diverge');
  const pixels=run(ffmpeg,['-v','error','-i',file,'-ss','3','-t',String(seconds),'-map','0:v:0','-vf','scale=160:90','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  const stride=160*90*3,identities=[];assert.equal(pixels.length%stride,0);
  for(let offset=0;offset<pixels.length;offset+=stride){
    const rgb=(x,y)=>[...pixels.subarray(offset+(y*160+x)*3,offset+(y*160+x)*3+3)];
    const top=rgb(80,4),bottom=rgb(80,85),cyan=rgb(20,45),magenta=rgb(140,45);
    assert(top[0]>150&&top[1]<80&&bottom[1]>150&&bottom[0]<80,'Video orientation/colors differ');
    assert(cyan[0]<70&&cyan[1]>170&&cyan[2]>170&&magenta[0]>170&&magenta[1]<70&&magenta[2]>170,'Fixture marker missing');
    let id=0;for(let bit=0;bit<16;bit++)if(rgb(Math.floor(160*(.2+(bit+.5)*.6/16)),45)[0]>127)id|=1<<bit;
    identities.push(id);
  }
  assert(identities.length>seconds*24,'Too few decoded frames');
  const distinct=new Set(identities).size;
  if(staticAndSilent)assert.equal(distinct,1,'Static source changed');else{
    assert(distinct>seconds*18,'Moving source froze');
    for(let i=1;i<identities.length;i++)assert((identities[i]-identities[i-1]+65536)%65536<90,'Reversed/corrupt frames');
  }
  const pcm=run(ffmpeg,['-v','error','-i',file,'-map','0:a:0','-ss','3.5','-t','1','-f','f32le','-acodec','pcm_f32le','pipe:1']);
  const samples=pcm.length/8;assert(samples>40000,'Too little decoded audio');
  const levels=[0,1].map(channel=>{
    let square=0;const sums=[440,880].map(()=>[0,0]);
    for(let i=0;i<samples;i++){const v=pcm.readFloatLE(i*8+channel*4);square+=v*v;
      for(let f=0;f<2;f++){const phase=2*Math.PI*[440,880][f]*i/48000;sums[f][0]+=v*Math.cos(phase);sums[f][1]+=v*Math.sin(phase);}}
    return {rms:Math.sqrt(square/samples),tones:sums.map(([x,y])=>20*Math.log10(Math.max(1e-12,2*Math.hypot(x,y)/samples)))};
  });
  if(staticAndSilent)for(const level of levels)assert(level.rms<.0005,'Expected received silence');
  else for(let channel=0;channel<2;channel++){assert(levels[channel].rms>.001,'Audio silent');assert(levels[channel].tones[channel]>-65&&levels[channel].tones[channel]>levels[channel].tones[1-channel]+20,'Stereo channels crossed or mixed');}
  return {file:path.basename(file),sha256:hash(file),frames:identities.length,distinctFrames:distinct,firstIdentity:identities[0],lastIdentity:identities.at(-1),timelines,audio:levels,
    videoProfile:video.profile,bFrames:decoded.filter(frame=>frame.pict_type==='B').length,
    keyframes:keys.length,maxKeyframeGapFrames:keyframeGaps.length?Math.max(...keyframeGaps):null};
}
(async()=>{console.log('Reports: '+report);try{
  const ports={api:await port(),rtsp:await port(),rtmp:await port(),srt:await port(true),...await rtpPorts()};
  const passphrase='qa:+%2B?&= '+crypto.randomBytes(10).toString('hex');
  const config=path.join(report,'mediamtx.yml');
  fs.writeFileSync(config,`logLevel: info\napi: true\napiAddress: 127.0.0.1:${ports.api}\nrtspAddress: 127.0.0.1:${ports.rtsp}\nrtspTransports: [tcp, udp]\nrtpAddress: 127.0.0.1:${ports.rtp}\nrtcpAddress: 127.0.0.1:${ports.rtcp}\nrtmpAddress: 127.0.0.1:${ports.rtmp}\nsrtAddress: 127.0.0.1:${ports.srt}\nwebrtc: false\nhls: false\nmoq: false\npaths:\n  '~^encrypted':\n    srtPublishPassphrase: ${JSON.stringify(passphrase)}\n  all_others:\n`);
  let generation=0;
  async function startServer(){server=launch(opts.server,[config],'server-'+generation++);await waitFor(async()=>{assert.equal(server.exitCode,null,'MediaMTX exited');return fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.ok).catch(()=>false);},10000,'No MediaMTX API');}
  await startServer();
  const fixture=launch(opts['camera-helper'],[opts['camera-device']],'camera'),tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');
  for(const p of [fixture,tone])await waitFor(()=>{assert.equal(p.exitCode,null,'Fixture exited');return p.output().includes('READY');},5000,'Fixture not ready');
  for(const protocol of (opts.protocols||(opts.gui?'rtmp':'rtmp,srt,rtsp,rtsp-udp,udp,rist')).split(','))for(const encoder of (opts.gui?'videotoolbox':opts.encoders||'videotoolbox,x264').split(',')){
    const id=protocol+'-'+encoder,entry={protocol,encoder,phases:[],passed:false};result.cases.push(entry);
    const stream=(protocol==='srt'?'encrypted':'stream')+crypto.randomBytes(8).toString('hex'),direct=['udp','rist'].includes(protocol),directPort=await port(true);
    const url=protocol==='rtmp'?`rtmp://127.0.0.1:${ports.rtmp}/live`:protocol==='srt'?`srt://127.0.0.1:${ports.srt}?passphrase=${encodeURIComponent(passphrase)}`:protocol.startsWith('rtsp')?`rtsp://127.0.0.1:${ports.rtsp}/${stream}`:`${protocol}://127.0.0.1:${directPort}`;
    const rtmpReceiver=opts['receiver-protocol']==='rtmp';
    entry.receiverProtocol=direct?protocol:rtmpReceiver?'rtmp':'rtsp';
    const receiverInput=direct?['-i',protocol==='udp'?`udp://127.0.0.1:${directPort}?fifo_size=8192&overrun_nonfatal=1`:`rist://@127.0.0.1:${directPort}`]:rtmpReceiver?['-i',`rtmp://127.0.0.1:${ports.rtmp}/live/${stream}`]:['-rtsp_transport','tcp','-i',`rtsp://127.0.0.1:${ports.rtsp}/${protocol==='rtmp'?'live/':''}${stream}`];
    let sequence=0;
    // Unlike RTSP's SDP, direct TS/RTMP inputs must discover SPS/PPS in-band.
    // Leave analysis headroom for the keyframe interval and late joining.
    // FFmpeg 7.1 RTSP AAC packets can lack the key flag. Its stream-copy
    // startup then discards every audio packet despite receiving valid AAC.
    // Copy initial AUDIO packets only; video must still wait for an IDR.
    // Keep packet/timestamp/stereo/silence assertions in decode() unchanged.
    function record(seconds,phase){const file=path.join(report,id+'-'+phase+'.mkv');return {file,process:launch(ffmpeg,['-hide_banner','-y','-analyzeduration',direct||rtmpReceiver?'3000000':'1000000','-probesize','1000000',...receiverInput,'-map','0','-c','copy','-copyinkf:a','-t',String(seconds+3),file],id+'-receiver-'+sequence++)};}
    let recording=direct?record(6,'moving'):null;if(direct)await sleep(500);
    const discovery=path.join(report,id+'-control.json');
    const publisher=launch(exe,opts.gui?['--temporary-settings','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`]:['--headless','--source=camera',`--camera-id=${opts['camera-device']}`,`--output=${protocol}`,`--output-url=${url}`,
      ...(protocol==='rtmp'?[`--output-key=${stream}`]:protocol==='srt'?[`--srt-stream-id=publish:${stream}`]:[]),
      '--audio-source=none','--include-microphone',`--microphone-device=${opts['microphone-device']}`,'--audio-channels=2',...(defaultAac?[]:['--aac-bitrate-kbps=192']),
      `--video-encoder=${encoder}`,'--video-codec=h264','--resolution=640x360','--fps=30','--bitrate-kbps=2000','--duration-ms=180000',
      '--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],id+'-publisher');
    await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited');return fs.existsSync(discovery);},10000,'No control discovery');const control=JSON.parse(fs.readFileSync(discovery));
    if(opts.gui){
      const ui=(action,name,value)=>execFileSync(path.resolve(opts['ui-helper']),[String(publisher.pid),action,...(name?[name]:[]),...(value!==undefined?[value]:[])],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
      await waitFor(()=>{assert.equal(publisher.exitCode,null,'GUI exited');const tree=ui('dump');fs.writeFileSync(path.join(report,id+'-startup-ui.txt'),tree);return tree.includes('sourceModeSelect');},15000,'Source controls did not become accessible');
      async function click(name){try{await waitFor(()=>{try{ui('bounds',name);return true;}catch{return false;}},8000,'Control not visible/frontmost: '+name);const audit=ui('click',name);entry.mouseEvents??=[];entry.mouseEvents.push({query:name,audit});fs.writeFileSync(path.join(report,id+'-mouse-events.json'),JSON.stringify(entry.mouseEvents,null,2));await sleep(250);return JSON.parse(audit);}catch(error){
        fs.writeFileSync(path.join(report,id+'-failed-click-audit.json'),JSON.stringify({status:error.status,stdout:String(error.stdout||''),stderr:String(error.stderr||'')}));
        // An obstructing system dialog may itself be a screen-permission request.
        // Preserve the AX/driver evidence without causing another screen capture prompt.
        fs.writeFileSync(path.join(report,id+'-failed-ui.txt'),ui('dump'));throw error;}}
      async function choose(name,value){
        // Exercise the normal mouse opening path as well as row selection.
        // A selection is attempted once, only after the popup bounds settle.
        await click(name);await sleep(600);
        const before=JSON.parse(ui('bounds',value));await sleep(100);
        const after=JSON.parse(ui('bounds',value));assert.deepEqual(after,before,'Popup bounds moved before selection');
        entry.uiSelections??=[];entry.uiSelections.push({control:name,value,bounds:after,input:'native mouse open and row click'});
        fs.writeFileSync(path.join(report,id+'-mouse-selections.json'),JSON.stringify(entry.uiSelections,null,2));
        const selected=await click(value);
        // Device rows append default-device and format details to the search
        // label. Require the committed control to match the exact clicked row.
        assert.equal(typeof selected.targetTitle,'string');
        assert(selected.targetTitle.includes(value),'Clicked row did not match requested selection');
        entry.uiSelections.at(-1).expectedTitle=selected.targetTitle;
        fs.writeFileSync(path.join(report,id+'-mouse-selections.json'),JSON.stringify(entry.uiSelections,null,2));
        try { await waitFor(()=>JSON.parse(ui('dump')).some(row=>row.AXIdentifier?.endsWith('.'+name)&&row.AXTitle===selected.targetTitle),
          5000,'Popup selection did not commit: '+name); }
        catch(error){fs.writeFileSync(path.join(report,id+'-selection-failure-ui.txt'),ui('dump'));throw error;}
      }
      await waitFor(()=>{try{return !!ui('window').trim();}catch{return false;}},10000,'No visible app window');
      // A direct executable launch can leave Terminal frontmost even when the
      // AX activation request succeeds. Ask Launch Services to open this exact
      // bundle, then require the owned publisher PID to become frontmost.
      execFileSync('/usr/bin/open',['-a',app,'--args','--temporary-settings','--local-control',
        '--local-control-port=0',`--local-control-discovery=${discovery}`],{timeout:10000,stdio:'pipe'});
      ui('activate');await sleep(700);await choose('sourceModeSelect','Camera / Webcam');await click('OBS Virtual Camera');
      await choose('cameraResolutionSelect','960x540');
      await choose('microphoneDeviceSelect','BlackHole 2ch');
      ui('press','advancedToggle');await sleep(250);
      // Expanded settings can extend below the viewport on shorter displays.
      // Move the app's own scrollbar before the guarded native pointer click.
      ui('scroll-to','outputSelect');await sleep(250);
      await choose('outputSelect',({rtmp:'RTMP / RTMPS',srt:'SRT (caller)',rtsp:'RTSP / VRChat (TCP)','rtsp-udp':'RTSP (UDP)',udp:'UDP / MPEG-TS (LAN)',rist:'RIST'})[protocol]);
      ui('set','outputUrlInput',url);if(protocol==='rtmp')ui('set','outputSecretInput',stream);if(protocol==='srt')ui('set','outputStreamIdInput','publish:'+stream);
      await sleep(700);fs.writeFileSync(path.join(report,id+'-ui.txt'),ui('dump'));ui('verify-selected','OBS Virtual Camera');ui('press','goLiveButton');
    }
    await waitFor(async()=>{assert.equal(publisher.exitCode,null,'Publisher exited');return(await api(control,'/diagnostics')).output?.state===2;},30000,'Output did not publish');
    if(!direct)await waitFor(async()=>{const paths=await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json());return paths.items.some(p=>p.name===(protocol==='rtmp'?'live/':'')+stream&&p.ready);},15000,'Server has no media');
    async function finishRecording(recording,seconds,phase,silent=false){
      await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited during reception');return recording.process.exitCode!==null;},25000,'Receiver timed out');
      assert.equal(await recording.process.closed,0,'Receiver failed');
      try { entry.phases.push({phase,...decode(recording.file,seconds,silent)}); }
      catch(error) {
        // Preserve sender counters when receive/decode fails before the final
        // diagnostics snapshot. Logs alone cannot distinguish a silent input
        // from missing transport packets.
        entry.failedPhase=phase;entry.failureDiagnostics=await api(control,'/diagnostics');throw error;
      }
    }
    await finishRecording(recording||record(6,'moving'),6,'moving');
    fixture.stdin.write('pause\n');tone.stdin.write('silence\n');await sleep(2000);
    await finishRecording(record(3,'static-silence'),3,'static-silence',true);
    fixture.stdin.write('resume\n');tone.stdin.write('sound\n');await sleep(1000);
    if(!direct&&encoder==='videotoolbox'){
      server.kill('SIGTERM');await server.closed;await sleep(1500);await startServer();
      await waitFor(async()=>{assert.equal(publisher.exitCode,null,'Publisher exited during recovery');const d=await api(control,'/diagnostics');return d.output.reconnects>0&&d.output.state===2;},45000,'Output did not reconnect');
      await waitFor(async()=>{const paths=await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json());return paths.items.some(p=>p.name===(protocol==='rtmp'?'live/':'')+stream&&p.ready);},15000,'Recovered server has no media');
      await finishRecording(record(4,'reconnected'),4,'reconnected');
    }else await finishRecording(record(4,'late-receiver'),4,'late-receiver');
    const diag=await api(control,'/diagnostics');entry.output=diag.output;
    if(defaultAac)assert.equal(diag.output.configured_aac_bitrate_kbps,128,'CLI AAC default changed');
    assert.equal(diag.video.hardware_encoder,encoder==='videotoolbox');assert.equal(diag.source.source_id,opts['camera-device']);
    if(opts.gui){assert(diag.video.ffmpeg_resolved&&diag.video.ffmpeg_is_bundled,'GUI did not probe bundled helper');assert(!diag.video.ffmpeg_is_user_override&&!diag.video.ffmpeg_gpl_enabled&&!diag.video.ffmpeg_nonfree_enabled,'Unexpected helper metadata');}
    assert(diag.audio.active_microphone_source.includes('BlackHole'));assert(diag.output.muxer_pid>1,'No mux helper');
    const command=execFileSync('/bin/ps',['-p',String(diag.output.muxer_pid),'-o','comm='],{encoding:'utf8'}).trim();assert.equal(command,helper,'Publisher used an external FFmpeg');
    assert(!JSON.stringify(diag).includes(passphrase)&&!JSON.stringify(diag).includes(stream),'Private output data in diagnostics');
    fs.writeFileSync(path.join(report,id+'-diagnostics.json'),JSON.stringify(diag,null,2));
    const appLog=await api(control,'/logs/recent?lines=1');assert(!fs.readFileSync(appLog.path,'utf8').includes(passphrase),'Passphrase in application log');
    await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'App did not quit');assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery),'Discovery not removed');
    let helperAlive=true;try{process.kill(diag.output.muxer_pid,0);}catch(e){if(e.code==='ESRCH')helperAlive=false;else throw e;}assert(!helperAlive,'Mux helper survived app shutdown');
    assert(!fs.readFileSync(path.join(report,id+'-publisher.log'),'utf8').includes(passphrase),'Passphrase in publisher log');
    entry.passed=true;console.log(id+': passed');fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
  }
  result.passed=true;
}catch(e){result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;}
finally{for(const p of children)p.kill('SIGTERM');await Promise.all([...children].map(async p=>{await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');await p.closed;}));
  fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));}})();
