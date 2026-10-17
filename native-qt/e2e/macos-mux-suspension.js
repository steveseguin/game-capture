#!/usr/bin/env node
'use strict';
// Packaged window -> bundled mux helper -> local MediaMTX -> independent decode.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net'),dgram=require('dgram');
const assert=require('assert/strict'),{spawn,execFileSync}=require('child_process');
const {sleep,waitFor}=require('./macos-media-receiver');
const {analyzeBlackScene}=require('./macos-alpha-analyzer');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');for(const k of ['app','fixture','server','ffmpeg','reports'])assert(opts[k],'Missing --'+k);
const protocol=opts.protocol||'rtmp',encoder=opts.encoder||'videotoolbox';
assert(['rtmp','srt'].includes(protocol));assert(['videotoolbox','x264'].includes(encoder));
const withAudio=!!opts['microphone-device'];if(withAudio)assert(opts['tone-helper'],'Audio requires --tone-helper');
if(withAudio)assert.equal(opts['microphone-device'],'BlackHole2ch_UID','This workflow permits only the owned BlackHole virtual input');
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),helper=path.resolve(opts.app,'Contents/Helpers/ffmpeg');
const ffmpeg=path.resolve(opts.ffmpeg),ffprobe=path.join(path.dirname(ffmpeg),'ffprobe');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const result={scope:'Packaged window RTMP/SRT suspension and restoration, existing and late independent local receivers; opaque black background pixels; optional owned virtual stereo input; no GUI, remote network or physical devices',withAudio,
 protocol,encoder,executableSha256:hash(exe),helperSha256:hash(helper),fixtureSha256:hash(path.resolve(opts.fixture)),receiverSha256:hash(ffmpeg),
 serverSha256:hash(path.resolve(opts.server)),harnessSha256:hash(__filename),phases:[],passed:false};
for(const n of ['macos-mux-suspension.js','macos-media-receiver.js','macos-alpha-analyzer.js','macos-alpha-fixture.mm'])fs.copyFileSync(path.join(__dirname,n),path.join(report,n));
const children=new Set();let control;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
function launch(program,args,label,raw=false){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|VERSUS_|GAME_CAPTURE_|FFMPEG_)/.test(k)));
 const child=spawn(path.resolve(program),args,{cwd:report,env,stdio:['pipe','pipe','pipe']});children.add(child);child.output='';
 const log=fs.createWriteStream(path.join(report,label+'.log'));child.stderr.pipe(log,{end:false});
 if(!raw){child.stdout.pipe(log,{end:false});child.stdout.on('data',b=>child.output=(child.output+b.toString()).slice(-65536));}
 child.closed=new Promise(resolve=>child.once('close',(code,signal)=>{children.delete(child);log.end();resolve({code,signal});}));
 child.once('error',e=>{result.launchError=String(e);});return child;
}
async function freePort(udp=false){const s=udp?dgram.createSocket('udp4'):net.createServer();await new Promise(r=>udp?s.bind(0,'127.0.0.1',r):s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok,'HTTP '+r.status);return r.json();}
function receiver(url,label){
 const file=path.join(report,label+'.mkv'),samples=[],bytesPerFrame=640*360*4;
 const child=launch(ffmpeg,['-hide_banner','-y','-rtsp_transport','tcp','-i',url,
  // Audio packets from older FFmpeg RTSP demuxers may lack the key flag.
  // Preserve them in the recording; retain the video keyframe requirement.
  '-map','0','-c','copy','-copyinkf:a',file,'-map','0:v:0','-vf','scale=640:360','-fps_mode','passthrough','-pix_fmt','rgba','-f','rawvideo','pipe:1'],label,true);
 let pending=Buffer.alloc(0);
 child.stdout.on('data',b=>{pending=Buffer.concat([pending,b]);while(pending.length>=bytesPerFrame){
  const frame=pending.subarray(0,bytesPerFrame);pending=pending.subarray(bytesPerFrame);
  const pixel=(x,y)=>Array.from(frame.subarray((y*640+x)*4,(y*640+x)*4+4));let identity=0;
  for(let bit=0;bit<16;bit++)if(pixel(bit*40+20,20)[0]>127)identity|=1<<bit;
  samples.push({identity,receivedAtMs:performance.now(),bands:[0,1,2,3].map(i=>pixel(i*160+80,120)),edge:Array.from({length:80},(_,i)=>pixel(4+i*8,270))});
 }});
 return {child,file,samples,label};
}
async function phase(r,label,seconds,heldId){
 const start=r.samples.length,startedAtMs=performance.now();await sleep(seconds*1000);const endedAtMs=performance.now();assert(r.child.exitCode===null&&!r.child.signalCode,'Receiver exited during '+label);
 const frames=r.samples.slice(start),summary={label,receiver:r.label,seconds,frames:frames.length};result.phases.push(summary);
 fs.writeFileSync(path.join(report,label+'.json'),JSON.stringify(frames));save();
 summary.pixels=analyzeBlackScene(frames,{minSamples:Math.floor(seconds*30*.85),minIdentities:heldId===undefined?30:1});
 const arrivals=[startedAtMs,...frames.map(f=>f.receivedAtMs),endedAtMs];
 summary.maxArrivalGapMs=Math.max(...arrivals.slice(1).map((t,i)=>t-arrivals[i]));assert(summary.maxArrivalGapMs<500,'Decoded playback stalled');
 if(heldId!==undefined)assert(frames.every(f=>f.identity===heldId),'Held image changed');
 else for(let i=1;i<frames.length;i++)assert((frames[i].identity-frames[i-1].identity+65536)%65536<90,'Moving identity reversed/corrupted');
 summary.firstIdentity=frames[0].identity;summary.lastIdentity=frames.at(-1).identity;save();return frames;
}
async function stopReceiver(r){
 r.child.kill('SIGINT');await waitFor(()=>r.child.exitCode!==null||r.child.signalCode,10000,'Receiver did not stop');
 const ended=await r.child.closed;assert([0,255].includes(ended.code)||ended.signal==='SIGINT');
 const m=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_packets','-of','json',r.file],{maxBuffer:8*1024*1024,timeout:15000}));
 assert.equal(m.streams.length,withAudio?2:1);const video=m.streams.find(s=>s.codec_type==='video');assert.equal(video.codec_name,'h264');assert.equal(video.width,640);assert.equal(video.height,360);
 const timelines=m.streams.map(s=>{
  const times=m.packets.filter(p=>p.stream_index===s.index).map(p=>Number(p.dts_time));assert(times.length>60&&times.every(Number.isFinite));let maxGap=0;
  for(let i=1;i<times.length;i++){assert(times[i]>times[i-1],'Non-advancing mux timestamps');maxGap=Math.max(maxGap,times[i]-times[i-1]);}
  assert(maxGap<(s.codec_type==='video'?.2:.1),'Mux timeline stalled');
  assert(times[0]>=0&&times[0]<3,'Receiver took over three seconds to join');
  const steady=times.filter(t=>t>=3);assert(steady.length>60);
  return {type:s.codec_type,packets:times.length,start:times[0],end:times.at(-1),duration:times.at(-1)-times[0],steadyDuration:steady.at(-1)-steady[0],maxGap};
 });
 let audio;
 if(withAudio){
  const stream=m.streams.find(s=>s.codec_type==='audio');assert.equal(stream.codec_name,'aac');assert.equal(stream.channels,2);assert.equal(Number(stream.sample_rate),48000);
  // Audio can join immediately while a late video receiver waits for the
  // two-second IDR. Preserve that delay, then compare the common steady span.
  assert(Math.abs(timelines[0].steadyDuration-timelines[1].steadyDuration)<.3,'Steady audio/video duration diverged');
  assert(Math.abs(timelines[0].end-timelines[1].end)<.3,'Audio/video end timestamps diverged');
  const pcm=execFileSync(ffmpeg,['-v','error','-i',r.file,'-ss','0.5','-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'],{maxBuffer:32*1024*1024,timeout:15000});
  const samples=pcm.length/8;assert(Number.isInteger(samples)&&samples>48000*8);let blocks=0,lowBlocks=0,clipped=0,minRms=Infinity;
  for(let offset=0;offset+4800<=samples;offset+=4800){++blocks;for(let c=0;c<2;c++){
   let square=0;for(let i=0;i<4800;i++){const v=pcm.readFloatLE((offset+i)*8+c*4);assert(Number.isFinite(v));square+=v*v;if(Math.abs(v)>=.99)++clipped;}
   const rms=Math.sqrt(square/4800);minRms=Math.min(minRms,rms);if(rms<.001)++lowBlocks;
  }}
  assert.equal(lowBlocks,0,'Decoded stereo contains a silent 100 ms block');assert.equal(clipped,0,'Audio clipped');
  const probes=[0,Math.floor(samples/2),samples-48000].map(offset=>[0,1].map(c=>{
   const tones=[440,880].map(f=>{let real=0,imag=0;for(let i=0;i<48000;i++){const v=pcm.readFloatLE((offset+i)*8+c*4),angle=2*Math.PI*f*i/48000;real+=v*Math.cos(angle);imag+=v*Math.sin(angle);}return 20*Math.log10(Math.max(1e-12,2*Math.hypot(real,imag)/48000));});
   assert(tones[c]>-65&&tones[c]>tones[1-c]+20,'Stereo tones crossed/mixed');return tones;
  }));
  audio={samples,seconds:samples/48000,blocks,lowBlocks,clipped,minRms,probes};
 }
 return {file:path.basename(r.file),sha256:hash(r.file),timelines,audio,exit:ended};
}
(async()=>{console.log('Reports: '+report);try{
 const ports={api:await freePort(),rtsp:await freePort(),rtmp:await freePort(),srt:await freePort(true)};
 const config=path.join(report,'mediamtx.yml');fs.writeFileSync(config,`logLevel: info\napi: true\napiAddress: 127.0.0.1:${ports.api}\nrtspAddress: 127.0.0.1:${ports.rtsp}\nrtspTransports: [tcp]\nrtmpAddress: 127.0.0.1:${ports.rtmp}\nsrtAddress: 127.0.0.1:${ports.srt}\nwebrtc: false\nhls: false\nmoq: false\npaths:\n  all_others:\n`);
 const server=launch(opts.server,[config],'server');await waitFor(async()=>{assert(server.exitCode===null);return fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.ok).catch(()=>false);},10000,'Server unavailable');
 let tone;if(withAudio){result.toneHelperSha256=hash(path.resolve(opts['tone-helper']));tone=launch(opts['tone-helper'],[opts['microphone-device'],'440','880'],'tone');await waitFor(()=>{assert(tone.exitCode===null);return tone.output.includes('READY');},5000,'Owned tone unavailable');}
 const title='Owned mux suspension '+crypto.randomBytes(10).toString('hex'),stream='mux'+crypto.randomBytes(10).toString('hex');
 const source=launch(opts.fixture,[title],'fixture');await waitFor(()=>source.output.includes('windowId'),10000,'Fixture unavailable');
 result.fixture=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));const id=String(result.fixture.windowId);
 const discovery=path.join(report,'control.json'),url=protocol==='rtmp'?`rtmp://127.0.0.1:${ports.rtmp}/live`:`srt://127.0.0.1:${ports.srt}`;
 const publisher=launch(exe,['--headless',`--window=${title}`,`--output=${protocol}`,`--output-url=${url}`,
  ...(protocol==='rtmp'?[`--output-key=${stream}`]:[`--srt-stream-id=publish:${stream}`]),'--audio-source=none',
  ...(withAudio?['--include-microphone',`--microphone-device=${opts['microphone-device']}`,'--audio-channels=2','--aac-bitrate-kbps=192']:['--microphone-device=none']),
  `--video-encoder=${encoder}`,'--video-codec=h264','--resolution=640x360','--fps=30','--bitrate-kbps=4000','--alpha-background=opaque','--alpha-background-color=#000000',
  '--duration-ms=180000','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],'publisher');
 await waitFor(()=>{assert(publisher.exitCode===null&&!publisher.signalCode);return fs.existsSync(discovery);},15000,'Publisher unavailable');control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
 await waitFor(async()=>{const d=await api('/diagnostics');return d.app.live&&d.source.has_frame;},15000,'Capture unavailable');
 const mediaPath=(protocol==='rtmp'?'live/':'')+stream,receiveUrl=`rtsp://127.0.0.1:${ports.rtsp}/${mediaPath}`;
 await waitFor(async()=>{const d=await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`).then(r=>r.json());return d.items.some(p=>p.name===mediaPath&&p.ready);},15000,'No published media');
 const existing=receiver(receiveUrl,'existing');await waitFor(()=>{assert(existing.child.exitCode===null);return existing.samples.length>=30;},15000,'No decoded video');
 await phase(existing,'moving',5);
 const before=await api('/diagnostics');result.before=before;const muxPid=before.output.muxer_pid;
 assert.equal(before.source.source_id,id);assert.equal(before.video.hardware_encoder,encoder==='videotoolbox');
 if(withAudio)assert(before.audio.active_microphone_source.includes('BlackHole'),'Expected owned virtual input');
 assert.equal(execFileSync('/bin/ps',['-p',String(muxPid),'-o','comm='],{encoding:'utf8'}).trim(),helper);
 source.stdin.write('minimize\n');await waitFor(async()=>(await api('/diagnostics')).source.suspended,10000,'Source did not suspend');await sleep(1000);
 source.output='';source.stdin.write('state\n');await waitFor(()=>source.output.includes('miniaturized'),5000,'No native source state');
 result.minimized=JSON.parse(source.output.split('\n').find(s=>s.startsWith('{')));assert(result.minimized.miniaturized);
 const heldId=existing.samples.at(-1).identity;result.heldIdentity=heldId;const suspended=await api('/diagnostics');result.suspended=suspended;
 await phase(existing,'held-existing',6,heldId);
 const late=receiver(receiveUrl,'late');await waitFor(()=>{assert(late.child.exitCode===null);return late.samples.length>=30;},15000,'Late receiver has no held image');
 await Promise.all([phase(existing,'held-existing-late',3,heldId),phase(late,'held-late',3,heldId)]);
 const afterHold=await api('/diagnostics');result.afterHold=afterHold;assert(afterHold.source.suspended);assert.equal(afterHold.video.frames_captured,suspended.video.frames_captured);assert(afterHold.video.frames_sent>suspended.video.frames_sent+200);
 assert.equal(afterHold.output.muxer_pid,muxPid);
 source.stdin.write('restore\n');await waitFor(async()=>!(await api('/diagnostics')).source.suspended,10000,'Capture did not restore');
 await waitFor(()=>[existing,late].every(r=>r.samples.at(-1)?.identity!==heldId),10000,'Receivers did not restore');
 const restored=await Promise.all([phase(existing,'restored-existing',6),phase(late,'restored-late',6)]);
 assert(restored.every(frames=>frames.every(f=>f.identity!==heldId)),'Old held image returned');
 const final=await api('/diagnostics');result.final=final;assert.equal(final.source.source_id,id);assert.equal(final.output.muxer_pid,muxPid);
 for(const k of ['encode_failures','encode_timeouts','send_failures'])assert.equal(final.video[k],0,k);
 result.recordings=[];for(const r of [existing,late]){result.recordings.push(await stopReceiver(r));save();}
 await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');assert.equal((await publisher.closed).code,0);assert(!fs.existsSync(discovery));
 assert.throws(()=>process.kill(muxPid,0),e=>e.code==='ESRCH','Mux helper survived shutdown');
 source.stdin.write('quit\n');await waitFor(()=>source.exitCode!==null,5000,'Source did not quit');assert.equal((await source.closed).code,0);result.passed=true;
}catch(e){result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;
}finally{for(const p of children)p.kill('SIGTERM');await Promise.all([...children].map(async p=>{await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');await p.closed;}));save();console.log(JSON.stringify({report,passed:result.passed}));}})();
