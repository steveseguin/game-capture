#!/usr/bin/env node
'use strict';
// Extracted Ubuntu DEB -> X11/software H264 + Pulse input -> shared mux helper.
// Independent local MediaMTX/direct receivers decode identities and stereo AAC.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net'),dgram=require('dgram');
const assert=require('assert/strict'),{spawn,execFileSync}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'linux');
for(const key of ['publisher','reports','server','manifest-sha256'])assert(opts[key],'Required --'+key);
const {chromium}=require('playwright');
const gui=opts.gui==='true';if(gui)assert(process.env.GC_QA_PRIVATE_DESKTOP,'GUI requires linux-private-desktop.py');
const exe=path.resolve(opts.publisher),bundle=path.resolve(path.dirname(exe),'../..');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifestFile=path.join(bundle,'release-artifact-manifest.json');
assert.equal(hash(manifestFile),opts['manifest-sha256']);
const manifest=JSON.parse(fs.readFileSync(manifestFile));assert.equal(hash(exe),manifest.artifact.sha256);
for(const item of manifest.payload.files){const file=path.resolve(bundle,item.relativePath);assert(file.startsWith(bundle+path.sep));assert.equal(fs.statSync(file).size,item.size);assert.equal(hash(file),item.sha256);}
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
fs.copyFileSync(__filename,path.join(report,'harness.js'));
fs.copyFileSync(path.join(__dirname,'macos-media-receiver.js'),path.join(report,'receiver-helper.js'));
const ffmpeg='/usr/bin/ffmpeg',ffprobe='/usr/bin/ffprobe',helper=ffmpeg;
const result={gui,executableSha256:hash(exe),manifestSha256:hash(manifestFile),harnessSha256:hash(__filename),
 requestedHelper:opts.helper||'distribution-default',requestedHelperSha256:opts.helper?hash(path.resolve(opts.helper)):null,
 receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),receiverSha256:hash(ffmpeg),probeSha256:hash(ffprobe),serverSha256:hash(path.resolve(opts.server)),
 scope:'Extracted Ubuntu DEB; X11 window, software H264 and owned virtual stereo microphone to local mux receivers. Moving/static video, AAC, late receivers, server restart and cleanup. Excludes GUI, Wayland, physical microphone, WAN/TLS, default 720p60, endurance and calibrated A/V synchronization.',cases:[],passed:false};
if(gui){for(const name of ['linux-output-gui.js','linux-ui-control.py','linux-private-desktop.py']){fs.copyFileSync(path.join(__dirname,name),path.join(report,name));result[name+'Sha256']=hash(path.join(report,name));}result.scope=result.scope.replace('Excludes GUI, Wayland','Actual Qt GUI, saved-profile relaunch and Stop/Go live cycles. Excludes Wayland');}
result.receiverVersion=execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0];
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_|FFMPEG_|GH_TOKEN|GITHUB_TOKEN|ACTIONS_.*TOKEN)/.test(k)));
Object.assign(env,{QT_QPA_PLATFORM:'xcb',XDG_SESSION_TYPE:'x11',XDG_STATE_HOME:path.join(report,'private-state'),XDG_CONFIG_HOME:path.join(report,'private-config'),XDG_DATA_HOME:path.join(report,'private-data')});delete env.WAYLAND_DISPLAY;
const pactl=(...args)=>execFileSync('pactl',args,{encoding:'utf8',timeout:5000}).trim();
const stalledHelpers=new Map();
const processStart=pid=>{try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').pop().split(' ')[19];}catch{return null;}};
const modules=[];let browser,source,toneTimer,toneChild,toneSilent=false;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
save();
const children=new Set();let server,currentControl,currentEntry;
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
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
  assert.equal(video?.codec_name,'h264');assert.equal(video.width,gui?960:640);assert.equal(video.height,gui?540:360);
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
  const points=[];for(let y=0;y<90;y++)for(let x=0;x<80;x++){const at=(y*160+x)*3;if(pixels[at]<70&&pixels[at+1]>170&&pixels[at+2]>170)points.push([x,y]);}
  assert(points.length>10,'No cyan fixture geometry');
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const magenta=[];for(let y=0;y<90;y++)for(let x=80;x<160;x++){const at=(y*160+x)*3;if(pixels[at]>170&&pixels[at+1]<70&&pixels[at+2]>170)magenta.push(x);}
  assert(magenta.length>10,'No magenta fixture geometry');
  // Marker centers tolerate rounding of their narrow widths after scaling.
  const cyanCenter=(Math.max(...xs)+Math.min(...xs))/2,magentaCenter=(Math.max(...magenta)+Math.min(...magenta))/2;
  const w=(magentaCenter-cyanCenter)/.75,h=(Math.max(...ys)-Math.min(...ys)+1)/.5;
  const left=cyanCenter-.125*w,topEdge=Math.min(...ys)-.25*h;
  const geometry={left,top:topEdge,width:w,height:h};
  for(let offset=0;offset<pixels.length;offset+=stride){
    const rgb=(x,y)=>{const at=offset+(Math.max(0,Math.min(89,Math.round(topEdge+y/90*h)))*160+Math.max(0,Math.min(159,Math.round(left+x/160*w))))*3;return [...pixels.subarray(at,at+3)];};
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
    geometry,videoProfile:video.profile,bFrames:decoded.filter(frame=>frame.pict_type==='B').length,
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
  const suffix=crypto.randomBytes(6).toString('hex'),sink='gc_mux_'+suffix,input=sink+'_input';
  modules.push(pactl('load-module','module-null-sink','sink_name='+sink,'rate=48000','channels=2'));
  modules.push(pactl('load-module','module-remap-source','master='+sink+'.monitor','source_name='+input,'source_properties=device.description=GameCaptureOwnedMuxInput'));
  toneChild=launch('/usr/bin/paplay',['--raw','--format=float32le','--rate=48000','--channels=2','--latency-msec=20','--device='+sink],'owned-tone');
  let frames=0,blocked=false;toneChild.stdin.on('error',()=>{});toneChild.stdin.on('drain',()=>{blocked=false;});
  toneTimer=setInterval(()=>{if(blocked||toneChild.exitCode!==null)return;const b=Buffer.alloc(960*8);for(let i=0;i<960;i++)for(let c=0;c<2;c++)b.writeFloatLE(toneSilent?0:.15*Math.sin(2*Math.PI*[440,880][c]*(frames+i)/48000),i*8+c*4);frames+=960;blocked=!toneChild.stdin.write(b);},20);
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  source=await browser.newPage({viewport:{width:800,height:450}});const title='Owned Linux Mux '+suffix;
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
  const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0,paused:false};
  function draw(){canvas.width=innerWidth;canvas.height=innerHeight;const w=canvas.width,h=canvas.height;if(!fixture.paused)fixture.id=(fixture.id+1)%65536;
  ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);ctx.fillStyle='red';ctx.fillRect(0,0,w,.1*h);ctx.fillStyle='#00ff00';ctx.fillRect(0,.9*h,w,.1*h);
  ctx.fillStyle='cyan';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='magenta';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
  for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}requestAnimationFrame(draw);}draw();</script>`);
  await source.bringToFront();await sleep(1000);result.browserVersion=browser.version();
  const desktop=gui?require('./linux-output-gui')({exe,report,env,launch,api,title,inputLabel:'GameCaptureOwnedMuxInput'}):null;
  for(const protocol of (opts.protocols||'rtmp,srt,rtsp,rtsp-udp,udp,rist').split(',')){
    assert(['rtmp','srt','rtsp','rtsp-udp','udp','rist'].includes(protocol));const encoder='software';
    const id=protocol+'-'+encoder,entry={protocol,encoder,phases:[],passed:false};result.cases.push(entry);currentEntry=entry;save();
    const stream=(protocol==='srt'?'encrypted':'stream')+crypto.randomBytes(8).toString('hex'),direct=['udp','rist'].includes(protocol),directPort=await port(true);
    const url=protocol==='rtmp'?`rtmp://127.0.0.1:${ports.rtmp}/live`:protocol==='srt'?`srt://127.0.0.1:${ports.srt}${gui?'':'?passphrase='+encodeURIComponent(passphrase)}`:protocol.startsWith('rtsp')?`rtsp://127.0.0.1:${ports.rtsp}/${stream}`:`${protocol}://127.0.0.1:${directPort}`;
    const rtmpReceiver=protocol==='rtmp';
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
    let discovery=path.join(report,id+'-control.json'),publisher,control,session;
    if(gui){session=await desktop.start(protocol,url,protocol==='srt'?passphrase:protocol==='rtmp'?stream:'',protocol==='srt'?'publish:'+stream:'');({publisher,control,discovery}=session);entry.profileRestored=session.profileRestored;}else{
    publisher=launch(exe,['--headless','--source=window','--window='+title,`--output=${protocol}`,`--output-url=${url}`,
      ...(protocol==='rtmp'?[`--output-key=${stream}`]:protocol==='srt'?[`--srt-stream-id=publish:${stream}`]:[]),
      '--audio-source=none','--include-microphone','--microphone-device=pulse:'+input,'--audio-channels=2','--aac-bitrate-kbps=192',
      ...(opts.helper?['--ffmpeg-path='+path.resolve(opts.helper)]:[]),'--video-encoder=software','--video-codec=h264','--resolution=640x360','--fps=30','--bitrate-kbps=2000','--duration-ms=180000',
      '--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],id+'-publisher');
    await waitFor(()=>{assert.equal(publisher.exitCode,null,'Publisher exited');return fs.existsSync(discovery);},15000,'No control discovery');control=JSON.parse(fs.readFileSync(discovery));}
    currentControl=control;
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
    await source.evaluate(()=>fixture.paused=true);toneSilent=true;await sleep(2000);
    await finishRecording(record(3,'static-silence'),3,'static-silence',true);
    await source.evaluate(()=>fixture.paused=false);toneSilent=false;await sleep(1000);
    if(!direct){
      server.kill('SIGTERM');await server.closed;await sleep(1500);await startServer();
      await waitFor(async()=>{assert.equal(publisher.exitCode,null,'Publisher exited during recovery');const d=await api(control,'/diagnostics');return d.output.reconnects>0&&d.output.state===2;},45000,'Output did not reconnect');
      await waitFor(async()=>{const paths=await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json());return paths.items.some(p=>p.name===(protocol==='rtmp'?'live/':'')+stream&&p.ready);},15000,'Recovered server has no media');
      await finishRecording(record(4,'reconnected'),4,'reconnected');
    }else await finishRecording(record(4,'late-receiver'),4,'late-receiver');
    if(opts['helper-stall']==='true'&&protocol==='rtmp'){
      const before=(await api(control,'/diagnostics')).output,stalledPid=before.muxer_pid;
      const previousSource=(await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json())).items.find(p=>p.name==='live/'+stream)?.source?.id;
      assert.equal(fs.realpathSync('/proc/'+stalledPid+'/exe'),helper);
      stalledHelpers.set(stalledPid,processStart(stalledPid));
      process.kill(stalledPid,'SIGSTOP');
      // Only stop the mux child owned by this publisher. The app must retire it
      // through its bounded watchdog and create a healthy replacement.
      await waitFor(async()=>{const output=(await api(control,'/diagnostics')).output;return output.reconnects>before.reconnects&&output.state===2&&output.muxer_pid!==stalledPid;},30000,'Stalled mux helper did not recover');
      assert(!fs.existsSync('/proc/'+stalledPid),'Stalled helper survived recovery');stalledHelpers.delete(stalledPid);
      await waitFor(async()=>{const paths=await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json());return paths.items.some(p=>p.name==='live/'+stream&&p.ready&&p.source?.id!==previousSource);},15000,'Server has no replacement publisher');
      await finishRecording(record(4,'helper-stall-recovered'),4,'helper-stall-recovered');
    }
    const diag=await api(control,'/diagnostics');entry.output=diag.output;
    assert.equal(diag.output.configured_aac_bitrate_kbps,192);assert.equal(diag.video.hardware_encoder,false);
    assert(diag.output.muxer_pid>1,'No mux helper');
    assert.equal(fs.realpathSync('/proc/'+diag.output.muxer_pid+'/exe'),opts.helper?fs.realpathSync(opts.helper):helper,'Wrong mux helper');
    assert(!JSON.stringify(diag).includes(passphrase)&&!JSON.stringify(diag).includes(stream),'Private output data in diagnostics');
    fs.writeFileSync(path.join(report,id+'-diagnostics.json'),JSON.stringify(diag,null,2));
    const appLog=await api(control,'/logs/recent?lines=1');assert(!fs.readFileSync(appLog.path,'utf8').includes(passphrase),'Passphrase in application log');
if(gui){
      await desktop.stop(session);assert(!fs.existsSync('/proc/'+diag.output.muxer_pid),'Mux helper survived GUI Stop');
      const nextRecording=direct?record(4,'gui-restarted'):null;
      await desktop.restart(session);
      await waitFor(async()=>{const d=await api(control,'/diagnostics');return d.output?.state===2;},20000,'GUI output did not resume');
      if(!direct)await waitFor(async()=>{const paths=await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json());return paths.items.some(p=>p.name===(protocol==='rtmp'?'live/':'')+stream&&p.ready);},15000,'Server has no GUI restarted media');
      await finishRecording(nextRecording||record(4,'gui-restarted'),4,'gui-restarted');
      const last=(await api(control,'/diagnostics')).output;await desktop.stop(session);assert(!fs.existsSync('/proc/'+last.muxer_pid),'Restarted helper survived GUI Stop');
      await desktop.quit(session);entry.guiStopRestartPassed=true;
    }else{await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'App did not quit');assert.equal(await publisher.closed,0);assert(!fs.existsSync(discovery),'Discovery not removed');}
    let helperAlive=true;try{process.kill(diag.output.muxer_pid,0);}catch(e){if(e.code==='ESRCH')helperAlive=false;else throw e;}assert(!helperAlive,'Mux helper survived app shutdown');
    assert(gui||!fs.readFileSync(path.join(report,id+'-publisher.log'),'utf8').includes(passphrase),'Passphrase in publisher log');
    entry.passed=true;console.log(id+': passed');fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
  }
  result.passed=true;
}catch(e){if(currentControl&&currentEntry){try{currentEntry.failureDiagnostics=await api(currentControl,'/diagnostics');}catch{}}result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;}
finally{for(const [pid,start] of stalledHelpers)if(start&&processStart(pid)===start)process.kill(pid,'SIGCONT');clearInterval(toneTimer);if(browser)await browser.close();for(const p of children)p.kill('SIGTERM');await Promise.all([...children].map(async p=>{await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');await p.closed;}));
  for(const module of modules.reverse())pactl('unload-module',module);
  fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));}})();
