'use strict';
// Real packaged publisher -> native OBS, with recordings for each settings case.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
async function main() {
  const publisher=path.resolve(opts.publisher),sender=path.resolve(opts.sender),ffmpeg=path.join(path.dirname(publisher),'ffmpeg/bin/ffmpeg.exe');
  const publisherHash=hash(publisher);
  if(publisherHash!==opts['expected-publisher-sha256']?.toLowerCase())throw Error('Publisher hash mismatch');
  const cases=JSON.parse(fs.readFileSync(opts.cases,'utf8').replace(/^\uFEFF/,''));
  if(!Array.isArray(cases)||!cases.length||new Set(cases.map(c=>c.name)).size!==cases.length)throw Error('Unique settings cases required');
  for(const c of cases)if(!/^[a-z0-9_-]+$/i.test(c.name)||![c.width,c.height,c.fps,c.bitrate].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Invalid settings case');
  const output=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
  const review={publisher,publisherHash,senderHash:hash(sender),casesHash:hash(opts.cases),results:[]};
  const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(review,null,2));
  console.log('Artifacts:',output);
  const toneLog=fs.createWriteStream(path.join(output,'tone.log'));
  const tone=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'audio-test-tone.ps1'),
    '-DurationMs',String(cases.length*240000),'-Amplitude','0.08'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  tone.stdout.pipe(toneLog,{end:false});tone.stderr.pipe(toneLog,{end:false});
  let toneError;tone.on('error',e=>{toneError=e;});
  try {for(const c of cases) {
    const dir=path.join(output,c.name);fs.mkdirSync(dir);const stream='obssettings'+crypto.randomBytes(6).toString('hex');
    const room=c.room?stream+'room':'';
    const controlPath=path.join(dir,'control.json'),children=[],logs=[];
    const r={requested:c,startedAt:new Date().toISOString()};review.results.push(r);save();
    let capture,control,obs;
    const launch=(exe,args,name,env={})=>{
      const log=fs.createWriteStream(path.join(dir,name+'.log'));logs.push(log);
      const p=spawn(exe,args,{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
      children.push(p);p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});p.on('error',e=>{r.processError=String(e);});
      p.reviewClosed=new Promise(resolve=>p.once('close',resolve));return p;
    };
    const api=async(route,body)=>{
      const response=await fetch(control.base_url+route,{method:body?'POST':'GET',
        headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
        body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
      const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;
    };
    console.log('Starting',c.name);
    try {
      if(toneError)throw toneError;
      if(tone.exitCode!==null||tone.signalCode!==null)throw Error('Audio fixture exited before the workflow');
      launch(sender,[`--name=${stream}`,'--pattern=alpha-moving-edge',`--width=${c.width}`,`--height=${c.height}`,
        `--fps=${c.fps}`,'--duration-ms=180000'],'sender');await sleep(2000);
      r.publisherArgs=['--headless',`--stream=${stream}`,'--password=false','--source=spout',`--spout-sender=${stream}`,
        ...(room?[`--room=${room}`]:[]),
        `--video-codec=${c.codec}`,`--video-encoder=${c.encoder}`,`--resolution=${c.width}x${c.height}`,
        `--fps=${c.fps}`,`--bitrate-kbps=${c.bitrate}`,'--audio-source=default-output','--duration-ms=170000',
        ...(c.alpha?['--alpha-workflow']:[]),...(c.background?[`--alpha-background=${c.background}`]:[]),
        ...(c.backgroundColor?[`--alpha-background-color=${c.backgroundColor}`]:[]),
        ...(c.ffmpegOptions?[`--ffmpeg-options=${c.ffmpegOptions}`]:[]),
        '--local-control','--local-control-port=0',`--local-control-discovery=${controlPath}`];
      capture=launch(publisher,r.publisherArgs,'publisher',{LOCALAPPDATA:dir,
        QT_PLUGIN_PATH:path.dirname(publisher),QT_QPA_PLATFORM_PLUGIN_PATH:path.join(path.dirname(publisher),'platforms')});
      const deadline=Date.now()+30000;let ready=false;
      while(Date.now()<deadline) {
        if(r.processError)throw Error(r.processError);
        if(capture.exitCode!==null||capture.signalCode!==null)throw Error('Publisher exited during startup: '+capture.exitCode);
        if(fs.existsSync(controlPath)) {
          control=JSON.parse(fs.readFileSync(controlPath,'utf8'));r.startup=await api('/diagnostics');
          if(r.startup.app.live&&r.startup.source.has_frame){ready=true;break;}
        }
        await sleep(300);
      }
      if(!ready)throw Error('Publisher did not produce a live source');
      obs=await require('./obs-alpha-runtime').start({repo:opts['obs-plugin-repo'],stream,room,output:path.join(dir,'obs'),
        expectedPluginHash:opts['expected-plugin-sha256'],width:c.width,height:c.height,fps:c.fps,alpha:!!c.alpha});
      r.obs=obs.evidence;await obs.sample('initial');await sleep(3000);
      r.beforeRecording=await api('/diagnostics');
      await obs.recordCadence(ffmpeg);r.final=await api('/diagnostics');
      const v=r.final.video;
      if(v.configured_width!==c.width||v.configured_height!==c.height||v.configured_fps!==c.fps||
        v.configured_bitrate_kbps!==c.bitrate||v.last_sent_width!==c.width||v.last_sent_height!==c.height)
        throw Error('Publisher did not retain the requested video settings');
      const expectedCodec={h264:'H.264',vp9:'VP9'}[c.codec];
      if(expectedCodec&&v.active_codec!==expectedCodec)throw Error('Publisher used an unexpected codec');
      r.audio=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'analyze-recorded-tone.js'),ffmpeg,r.obs.cadence.file],
        {encoding:'utf8',windowsHide:true}));
      if(!r.audio.ok)throw Error('Recorded audio failed tone/continuity checks');
      const sample=r.obs.samples.at(-1).samples.at(-1),file=sample.outputPath||sample.screenshot.outputPath;
      const pixels=execFileSync(ffmpeg,['-v','error','-i',file,'-vf','scale=480:300','-frames:v','1',
        '-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,maxBuffer:1024*1024});
      if(pixels.length!==480*300*3)throw Error('Incomplete color image');
      const blue=[];
      for(let x=0;x<480;x++) {const p=(150*480+x)*3;
        if(pixels[p]<100&&pixels[p+1]>35&&pixels[p+1]<160&&pixels[p+2]>160)blue.push(x);}
      if(blue.length<20)throw Error('Missing fixture color region');
      const cx=Math.floor((blue[0]+blue.at(-1))/2),sum=[0,0,0];
      for(let y=145;y<155;y++)for(let x=cx-5;x<cx+5;x++)for(let ch=0;ch<3;ch++)sum[ch]+=pixels[(y*480+x)*3+ch];
      r.color={expected:[32,96,255],mean:sum.map(n=>n/100)};
      r.color.maxError=Math.max(...r.color.mean.map((n,i)=>Math.abs(n-r.color.expected[i])));
      if(r.color.maxError>8)throw Error('Fixture interior color error exceeds 8/255');
      if(c.expectedCornerRgb) {
        const rgb=execFileSync(ffmpeg,['-v','error','-i',file,'-vf','format=rgb24,crop=16:16:0:0','-frames:v','1',
          '-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true});
        if(rgb.length!==16*16*3)throw Error('Incomplete corner image');
        const sum=[0,0,0];for(let i=0;i<rgb.length;i++)sum[i%3]+=rgb[i];
        r.corner={expected:c.expectedCornerRgb,mean:sum.map(n=>n/256)};
        r.corner.maxError=Math.max(...r.corner.mean.map((n,i)=>Math.abs(n-c.expectedCornerRgb[i])));
        if(r.corner.maxError>4)throw Error('Background color differs from requested fill');
      }
      r.ok=true;
    } catch(e) {r.ok=false;r.error=String(e);process.exitCode=1;
      if(control)try{r.final=await api('/diagnostics');}catch{}
    } finally {
      if(obs)try{await obs.close();}catch(e){r.closeError=String(e);r.ok=false;process.exitCode=1;}
      const started=Date.now();
      if(capture&&capture.exitCode===null&&capture.signalCode===null&&control)try{await api('/commands',{command:'quit'});}catch{}
      while(capture&&capture.exitCode===null&&capture.signalCode===null&&Date.now()-started<10000)await sleep(100);
      r.shutdown={ms:Date.now()-started,exitCode:capture?.exitCode,signal:capture?.signalCode,
        forced:!!capture&&capture.exitCode===null&&capture.signalCode===null};
      if(r.shutdown.forced||(r.ok&&r.shutdown.exitCode!==0)){r.ok=false;process.exitCode=1;}
      for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill();
      await Promise.race([Promise.all(children.map(p=>p.reviewClosed)),sleep(5000)]);
      for(let i=0;i<children.length;i++){children[i].stdout.unpipe(logs[i]);children[i].stderr.unpipe(logs[i]);}
      for(const log of logs)log.end();r.finishedAt=new Date().toISOString();save();
      console.log(c.name,r.ok?'PASS':'FAIL',r.error||'',r.final?.video?.active_encoder||'',r.obs?.cadence?.edgeChangesPerSecond||'');
    }
  }} finally {
    const toneClosed=new Promise(resolve=>tone.once('close',resolve));
    if(tone.exitCode===null&&tone.signalCode===null){tone.kill();await Promise.race([toneClosed,sleep(5000)]);}
    tone.stdout.unpipe(toneLog);tone.stderr.unpipe(toneLog);toneLog.end();
    review.finalPublisherHash=hash(publisher);review.artifactUnchanged=review.finalPublisherHash===publisherHash;
    if(!review.artifactUnchanged)process.exitCode=1;save();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
