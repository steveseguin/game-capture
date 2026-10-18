'use strict';
// Packaged Linux A/V timing and sustained-media workflow. Reuses the Mac source,
// recorder, PCM observer and PTS-preserving analyzer; no physical latency claim.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{gzipSync}=require('zlib'),{chromium}=require('playwright');
const {receiver,sleep,waitFor}=require('./macos-media-receiver');
const audio=require('./macos-continuous-audio'),video=require('./linux-av-probe');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'linux');const backend=opts.backend||'x11';assert(['x11','wayland'].includes(backend));const wayland=backend==='wayland';
assert(wayland?process.env.GC_QA_WAYLAND_DESKTOP:process.env.GC_QA_PRIVATE_DESKTOP,'Use the matching owned desktop wrapper');
for(const k of ['publisher','manifest-sha256','reports'])assert(opts[k],k);
const seconds=Number(opts.seconds||60),hold=Number(opts['hold-seconds']||0),analysisPython=opts['analysis-python']||'python3';
const traceCapture=opts['trace-capture']==='true';if(traceCapture)assert(seconds*(hold?2:1)+hold<=240,'Keep the opt-in native trace below its 100,000-row bound');
assert(Number.isInteger(seconds)&&seconds>=30&&seconds<=120&&Number.isInteger(hold)&&hold>=0&&hold<=7200);
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const exe=path.resolve(opts.publisher),bundle=path.resolve(path.dirname(exe),'../..'),manifestFile=path.join(bundle,'release-artifact-manifest.json');
assert.equal(sha(manifestFile),opts['manifest-sha256']);const manifest=JSON.parse(fs.readFileSync(manifestFile));assert.equal(sha(exe),manifest.artifact.sha256);
for(const item of manifest.payload.files){const file=path.resolve(bundle,item.relativePath);assert(file.startsWith(bundle+path.sep));assert.equal(sha(file),item.sha256);assert.equal(fs.statSync(file).size,item.size);}
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
const harnesses={};for(const name of ['linux-av-sync.js','linux-av-probe.js','macos-av-source.html','macos-continuous-audio.js','macos-media-receiver.js','macos-analyze-av-sync.py','macos-calibrate-av-sync.py']){fs.copyFileSync(path.join(__dirname,name),path.join(report,name));harnesses[name]=sha(path.join(report,name));}
if(wayland)for(const name of ['linux-av-wayland.js','linux-source-monitor.py','linux-virtual-monitor.py','linux-portal-select.py']){fs.copyFileSync(path.join(__dirname,name),path.join(report,name));harnesses[name]=sha(path.join(report,name));}
if(traceCapture){const name='linux-av-trace-report.js';fs.copyFileSync(path.join(__dirname,name),path.join(report,name));harnesses[name]=sha(path.join(report,name));}
const result={backend,traceCapture,scope:`Exact Ubuntu DEB, owned ${wayland?'native GNOME Wayland':'X11'} window and selected Chrome-process Pulse audio to hosted VDO.Ninja browser. Default video 1280x720/60, software H264 4000 kbps, stereo Opus 128 kbps without RED. Paired software-reference/received-media recordings, decoded pulse identities, continuous PCM windows and resources. Excludes physical display/speaker latency, physical microphone and OBS.`,
  executableSha256:sha(exe),manifestSha256:sha(manifestFile),harnessSha256:sha(__filename),harnesses,seconds,holdSeconds:hold,requested:{width:1280,height:720,fps:60,bitrateKbps:4000},phases:[],samples:[],passed:false};
const save=()=>{fs.writeFileSync(path.join(report,'results.pending.json'),JSON.stringify(result,null,2)+'\n');fs.renameSync(path.join(report,'results.pending.json'),path.join(report,'results.json'));};
const pactl=(...a)=>execFileSync('pactl',a,{encoding:'utf8',timeout:5000}).trim();
const modules=[],browsers=[],recordings=new Set();let server,child,log,control,discovery,page,continuous=false,launchError,logError,waylandFixture;
const defaultSink=pactl('get-default-sink');result.defaultSink=defaultSink;
const api=async(route,body)=>{const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();};
async function quit(){if(child&&child.exitCode===null){await api('/commands',{command:'quit'});await waitFor(()=>child.exitCode!==null,10000,'Publisher did not quit');}if(child){await child.closed;assert.equal(child.exitCode,0);assert(!fs.existsSync(discovery));}}
(async()=>{
  console.log('Reports: '+report);save();
  try {
    result.analysisEnvironment=JSON.parse(execFileSync(analysisPython,['-c','import sys,json,numpy;print(json.dumps({"executable":sys.executable,"version":sys.version,"numpy":numpy.__version__}))'],{encoding:'utf8',timeout:10000}));
    const disk=fs.statfsSync(report);assert(disk.bavail*disk.bsize>1024**3,'Need 1 GiB evidence space');
    const env={...process.env};for(const k of Object.keys(env))if(/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k))delete env[k];
    Object.assign(env,{QT_QPA_PLATFORM:wayland?'wayland':'xcb',XDG_SESSION_TYPE:backend,XDG_STATE_HOME:path.join(report,'private-state'),XDG_CONFIG_HOME:path.join(report,'private-config'),XDG_DATA_HOME:path.join(report,'private-data')});if(wayland)env.WAYLAND_DISPLAY=process.env.WAYLAND_DISPLAY||'wayland-0';else delete env.WAYLAND_DISPLAY;
    if(wayland){waylandFixture=await require('./linux-av-wayland').create(env,report);result.waylandFixture=waylandFixture.evidence;}
    if(traceCapture){env.VERSUS_FRAME_TRACE=path.join(report,'capture-frame-trace.csv');result.frameTrace={path:'capture-frame-trace.csv',scope:'Opt-in native capture/submit identity trace, bounded diagnostic only; disabled for endurance qualification.'};}
    const suffix=crypto.randomBytes(8).toString('hex'),sink='gc_av_'+suffix,title='Owned Linux Capture AV '+suffix;
    modules.push(pactl('load-module','module-null-sink','sink_name='+sink,'rate=48000','channels=2'));
    // Generate a larger Linux source from the unchanged shared clocked fixture.
    let fixture=fs.readFileSync(path.join(report,'macos-av-source.html'),'utf8').replace('Owned Mac A/V Fixture',title).replace('width="960" height="540"','width="1280" height="720"').replace('frames:0,events:[]','frames:0,trace:[],events:[]').replace('fixture.frames++;requestAnimationFrame(draw);','fixture.trace.push({stamp,wall:performance.timeOrigin+performance.now()});if(fixture.trace.length>12000)fixture.trace.shift();fixture.frames++;requestAnimationFrame(draw);');
    if(traceCapture){
      // The existing native trace reads twelve bits and their adjacent inverse.
      // These dim sentinels satisfy that reader without entering the brighter
      // cyan/magenta mask used by the independent 24-bit A/V observer.
      const marker=`const frameId=fixture.frames%4096;
        for(let cell=0;cell<28;cell++){
          g.fillStyle=cell===0||cell===27?'rgb(180,90,180)':cell===1||cell===26?'rgb(90,180,180)':(((frameId>>(cell<14?cell-2:cell-14))&1)^(cell>=14?1:0))?'white':'black';
          g.fillRect((.08+cell*.84/28)*w,.9*h,.84/28*w,.07*h);
        }
        fixture.trace.push({frameId,stamp,wall:performance.timeOrigin+performance.now()});`;
      fixture=fixture.replace('fixture.trace.push({stamp,wall:performance.timeOrigin+performance.now()});',marker);
    }
    assert(fixture.includes('width="1280" height="720"')&&fixture.includes('trace:[]')&&fixture.includes('fixture.trace.push'),'Shared fixture layout changed');
    const fixtureFile=path.join(report,'linux-av-source.html');fs.writeFileSync(fixtureFile,fixture);result.sourceFixtureSha256=sha(fixtureFile);
    server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(fixture);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browserPath=opts.browser||'/usr/bin/google-chrome';
    const sourceBrowser=await chromium.launch({executablePath:browserPath,headless:false,env:{...env,...(wayland?{ACCESSIBILITY_ENABLED:'1'}:{}),PULSE_SINK:sink},args:[...(wayland?['--ozone-platform=wayland','--force-renderer-accessibility','--password-store=basic']:[]),'--window-size=1400,900','--window-position=0,0','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});browsers.push(sourceBrowser);
    const source=await sourceBrowser.newPage({viewport:wayland?null:{width:1280,height:720}});await source.goto('http://127.0.0.1:'+server.address().port);await source.bringToFront();await waitFor(()=>source.evaluate(()=>window.fixture?.frames>60),10000,'Source did not render');
    const cdp=await sourceBrowser.newBrowserCDPSession(),info=await cdp.send('SystemInfo.getProcessInfo');const sourcePid=info.processInfo.find(p=>p.type==='browser').id;await cdp.detach();
    if(wayland)await waylandFixture.placeSource(source,sourcePid,title);
    result.sourcePid=sourcePid;result.sourceSize=await source.evaluate(()=>({width:innerWidth,height:innerHeight}));await source.screenshot({path:path.join(report,'source.png')});
    const viewer=await chromium.launch({executablePath:browserPath,headless:true,env,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});browsers.push(viewer);result.browserVersion=viewer.version();
    const stream='gclinuxav'+crypto.randomBytes(12).toString('hex');discovery=path.join(report,'private-control.json');
    child=spawn(exe,['--headless','--source=window','--window='+(wayland?'Choose a window':title),'--stream='+stream,'--password=false','--video-encoder=software','--video-codec=h264','--resolution=1280x720','--fps=60','--bitrate-kbps=4000','--audio-source=selected-window','--audio-process='+sourcePid,'--audio-codec=opus','--no-audio-red','--audio-channels=2','--audio-bitrate-kbps=128','--duration-ms='+((seconds*(hold?2:1)+hold+180)*1000),'--local-control','--local-control-port=0','--local-control-discovery='+discovery],{cwd:bundle,env,stdio:['ignore','pipe','pipe']});
    child.on('error',e=>launchError=String(e));log=fs.createWriteStream(path.join(report,'private-publisher.log'));log.on('error',e=>logError=String(e));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.closed=new Promise(resolve=>child.once('close',()=>log.end(resolve)));
    if(wayland)waylandFixture.selectPortal(title);
    await waitFor(()=>{assert(!launchError,launchError);assert.equal(child.exitCode,null);return fs.existsSync(discovery);},15000,'No publisher discovery');control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,child.pid);
    if(wayland)await waylandFixture.selectedPortal();
    page=await receiver(viewer,stream,child);await sleep(3000);result.continuousAudio=await audio.start(page);continuous=true;
    let previous=null,index=0;
    async function sample(duration=5000){
      assert(!logError,logError);assert.equal(child.exitCode,null);await source.evaluate(()=>{fixture.trace=[];});
      const observed=await video.observe(page,duration),trace=await source.evaluate(()=>fixture.trace),pcm=await audio.drain(page),diagnostics=await api('/diagnostics');
      const audioCheck=audio.analyze(pcm,duration/1000-.35),elapsed=(observed.ended-observed.started)/1000;
      const stamps=observed.observations.filter(f=>f.stamp!==null).map(f=>f.stamp),distinct=new Set(stamps).size,sourceDistinct=new Set(trace.map(f=>f.stamp)).size;
      const gaps=observed.observations.slice(1).map((f,i)=>(f.mediaTime-observed.observations[i].mediaTime)*1000).sort((a,b)=>a-b);
      const reverse=stamps.slice(1).filter((s,i)=>s<stamps[i]).length;
      const rssKiB=Number(execFileSync('ps',['-p',String(child.pid),'-o','rss='],{encoding:'utf8'}).trim());
      const inbound=await page.evaluate(async()=>{const rows=[];for(const pc of reviewPCs)if(pc.connectionState==='connected'){const stats=await pc.getStats();for(const row of stats.values())if(row.type==='inbound-rtp')rows.push({...row,codec:stats.get(row.codecId)?.mimeType});}return rows;});
      const raw={observed,trace,pcm,diagnostics,inbound};const file=path.join(report,'sample-'+String(index++).padStart(4,'0')+'.json.gz');fs.writeFileSync(file,gzipSync(JSON.stringify(raw)),{flag:'wx'});
      const summary={wall:Date.now(),seconds:elapsed,rssKiB,sourceFps:sourceDistinct/elapsed,receivedFps:distinct/elapsed,deliveryRatio:distinct/Math.min(sourceDistinct,60*elapsed),p95MediaGapMs:gaps[Math.floor(gaps.length*.95)],invalid:observed.invalid,reverse,audio:audioCheck,observationGapMs:previous?observed.started-previous:0,file:path.basename(file),sha256:sha(file)};previous=observed.ended;
      summary.passed=observed.width===1280&&observed.height===720&&observed.invalid===0&&reverse===0&&summary.sourceFps>=57&&summary.deliveryRatio>=.95&&summary.p95MediaGapMs<=2000/60+2&&summary.observationGapMs<=250&&audioCheck.passed;
      result.samples.push(summary);save();
      assert(diagnostics.app.live&&diagnostics.app.capturing);assert.equal(diagnostics.video.configured_width,1280);assert.equal(diagnostics.video.configured_height,720);assert.equal(diagnostics.video.configured_fps,60);assert.equal(diagnostics.video.hardware_encoder,false);assert.equal(diagnostics.audio.source_mode,'selected-window');
      for(const k of ['encode_failures','encode_timeouts','send_failures'])assert.equal(diagnostics.video[k],0,k);assert.equal(diagnostics.audio.send_failures,0);
      console.log(JSON.stringify({sample:index,...summary}));
      // Preserve all observations when a performance target fails; continue the
      // bounded capture so paired timing evidence can distinguish the cause.
    }
    async function phase(name){
      const entry={name,started:Date.now()};result.phases.push(entry);save();const pair=[];
      for(const [kind,target,settings] of [['source',source,{includeVideo:true,sourceStreamKey:'fixtureReference'}],['receiver',page,{includeVideo:true}]]){const r=await audio.record(target,path.join(report,name+'-'+kind+'.webm'),settings);pair.push(r);recordings.add(r);entry[kind]=r.metadata;save();}
      for(let n=0;n<seconds;n+=5)await sample(Math.min(5,seconds-n)*1000);
      for(const r of pair){await r.stop();recordings.delete(r);}entry.ended=Date.now();save();
    }
    await phase('initial');if(hold){for(let n=0;n<hold;n+=5)await sample(Math.min(5,hold-n)*1000);await phase('final');}
    result.sourceFixture=await source.evaluate(()=>({frames:fixture.frames,epoch:fixture.epoch,events:fixture.events}));await page.screenshot({path:path.join(report,'receiver.png')});
    await audio.stop(page);continuous=false;await quit();result.recordingWorkflowPassed=true;save();
    const analyzer=spawn(analysisPython,[path.join(report,'macos-analyze-av-sync.py'),report,'--ffmpeg','/usr/bin/ffmpeg'],{stdio:['ignore','ignore','pipe']});let errors='';analyzer.stderr.on('data',d=>errors+=d);result.analysisExitCode=await new Promise(resolve=>analyzer.once('close',resolve));
    result.analysisErrors=errors;result.analysis=JSON.parse(fs.readFileSync(path.join(report,'av-analysis.json')));
    result.passed=result.analysisExitCode===0&&result.analysis.passed&&result.samples.every(s=>s.passed);
  }catch(error){result.error=String(error.stack||error);}
  finally{
    const errors=[];
    for(const r of recordings)try{await r.stop();}catch(e){errors.push(String(e));}
    if(continuous)try{await audio.stop(page);}catch(e){errors.push(String(e));}
    if(waylandFixture)try{await waylandFixture.cancelPendingPortal();}catch(e){errors.push(String(e));}
    if(child&&child.exitCode===null)try{await quit();}catch(e){errors.push(String(e));child.kill();await child.closed;}
    for(const browser of browsers.reverse())try{await browser.close();}catch(e){errors.push(String(e));}
    if(server)await new Promise(resolve=>server.close(resolve));
    for(const id of modules.reverse())try{pactl('unload-module',id);}catch(e){errors.push(String(e));}
    try{assert.equal(pactl('get-default-sink'),defaultSink);assert(!JSON.parse(pactl('--format=json','list','modules')).some(m=>modules.includes(String(m.index))));result.audioCleanupPassed=true;}catch(e){errors.push(String(e));}
    if(traceCapture&&fs.existsSync(path.join(report,'capture-frame-trace.csv'))){
      const f=path.join(report,'capture-frame-trace.csv');result.frameTrace.sha256=sha(f);result.frameTrace.bytes=fs.statSync(f).size;save();
      try{execFileSync(process.execPath,[path.join(report,'linux-av-trace-report.js'),report],{encoding:'utf8',timeout:30000});const analysis=path.join(report,'frame-trace-analysis.json');result.frameTrace.analysisSha256=sha(analysis);assert(JSON.parse(fs.readFileSync(analysis)).traceComplete,'Native identity trace is incomplete');}catch(e){errors.push(String(e));}
    }else if(traceCapture&&child)errors.push('Requested native identity trace is missing');
    if(waylandFixture)try{await waylandFixture.close();}catch(e){errors.push(String(e));}
    if(errors.length){result.cleanupErrors=errors;result.passed=false;}save();process.exitCode=result.passed?0:1;console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
  }
})();
