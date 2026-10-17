#!/usr/bin/env node
'use strict';
// Signed Mac app -> real browser receiver, paired with the generated source.
// Record bounded first/last samples while the same publisher stays running.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const {receiver,sleep,waitFor}=require('./macos-media-receiver');
const recorder=require('./macos-continuous-audio');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
if(process.platform!=='darwin'||!opts.app||!opts.reports||!opts['source-ui-helper'])throw Error('Use --app, --reports and --source-ui-helper on macOS');
const seconds=Number(opts.seconds||60),hold=Number(opts['hold-seconds']||0),encoder=opts.encoder||'videotoolbox';
const width=Number(opts.width||640),height=Number(opts.height||360),fps=Number(opts.fps||30),bitrate=Number(opts['bitrate-kbps']||2000);
if(!Number.isInteger(seconds)||seconds<30||seconds>120||!Number.isInteger(hold)||hold<0||hold>7200||!['videotoolbox','x264'].includes(encoder))throw Error('Invalid A/V observation options');
if(![width,height,fps,bitrate].every(Number.isInteger)||width<320||width>3840||height<180||height>2160||width%2||height%2||fps<1||fps>120||bitrate<100||bitrate>100000)throw Error('Invalid A/V output configuration');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const exe=path.join(path.resolve(opts.app),'Contents/MacOS/game-capture');
if(!fs.existsSync(path.join(path.resolve(opts.app),'Contents/Frameworks')))throw Error('Use a deployed app bundle');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Recorded source/received-media A/V timing; software reference, not physical display/speaker latency or OBS output',
  encoder,seconds,holdSeconds:hold,requested:{width,height,fps,bitrateKbps:bitrate},executableSha256:hash(exe),harnessSha256:hash(__filename),phases:[],samples:[],passed:false};
for(const file of ['macos-av-sync.js','macos-av-source.html','macos-media-receiver.js','macos-continuous-audio.js','macos-analyze-av-sync.py'])
  fs.copyFileSync(path.join(__dirname,file),path.join(report,file));
const browsers=[],recordings=new Set();let server,child,log,control;
const save=()=>{fs.writeFileSync(path.join(report,'results.pending.json'),JSON.stringify(result,null,2));fs.renameSync(path.join(report,'results.pending.json'),path.join(report,'results.json'));};
const api=async(route,body)=>{
  const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('Local control failed '+route);return r.json();
};
(async()=>{
  console.log('Reports: '+report);
  try {
    const disk=fs.statfsSync(report);if(disk.bavail*disk.bsize<256*1024*1024)throw Error('A/V recordings require 256 MiB free');
    const fixture=fs.readFileSync(path.join(__dirname,'macos-av-source.html'));
    server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(fixture);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const sourceBrowser=await chromium.launch({headless:false,args:['--window-size=1000,700','--window-position=80,80',
      '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});browsers.push(sourceBrowser);
    const source=await sourceBrowser.newPage({viewport:{width:960,height:540}});
    await source.goto('http://127.0.0.1:'+server.address().port);
    const title='Mac AV Fixture '+crypto.randomBytes(8).toString('hex');await source.evaluate(t=>document.title=t,title);
    await waitFor(()=>source.evaluate(()=>window.fixture?.frames>60),10000,'Source fixture did not render');
    const cdp=await sourceBrowser.newBrowserCDPSession(),processes=await cdp.send('SystemInfo.getProcessInfo');
    const sourcePid=processes.processInfo.find(p=>p.type==='browser').id;
    const command=execFileSync('/bin/ps',['-p',String(sourcePid),'-o','command='],{encoding:'utf8'}),profile=command.match(/--user-data-dir=(\S+)/)?.[1];
    const browserExe=chromium.executablePath(),bundleAt=browserExe.indexOf('.app/Contents/MacOS/');
    if(!profile?.includes('/playwright_chromiumdev_profile-')||bundleAt<0)throw Error('Cannot bind activation to owned source browser');
    execFileSync('/usr/bin/open',['-a',browserExe.slice(0,bundleAt+4),'--args','--user-data-dir='+profile],{timeout:5000});
    await sleep(500);await source.bringToFront();
    execFileSync(path.resolve(opts['source-ui-helper']),[String(sourcePid),'activate'],{timeout:5000});await cdp.detach();
    result.sourceActivation={pid:sourcePid,helperSha256:hash(path.resolve(opts['source-ui-helper']))};
    await source.screenshot({path:path.join(report,'source.png')});
    const viewerBrowser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});browsers.push(viewerBrowser);
    result.browserVersions={source:sourceBrowser.version(),receiver:viewerBrowser.version()};
    const stream='macsync'+crypto.randomBytes(12).toString('hex'),discovery=path.join(report,'control.json');
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
    child=spawn(exe,['--headless','--window='+title,'--stream='+stream,'--password=false','--video-encoder='+encoder,
      '--width='+width,'--height='+height,'--fps='+fps,'--bitrate-kbps='+bitrate,'--audio-source=selected-window',
      '--duration-ms='+((seconds*2+hold+180)*1000),'--local-control','--local-control-port=0','--local-control-discovery='+discovery],
      {cwd:report,env,stdio:['ignore','pipe','pipe']});
    log=fs.createWriteStream(path.join(report,'publisher.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    let logError;log.on('error',e=>{logError=e;child.kill('SIGTERM');});
    child.once('exit',(code,signal)=>{result.exitCode=code;result.exitSignal=signal;log.end();});
    await waitFor(()=>{if(child.exitCode!==null)throw Error('Publisher exited');return fs.existsSync(discovery);},15000,'No local-control discovery');
    control=JSON.parse(fs.readFileSync(discovery));
    const page=await receiver(viewerBrowser,stream,child);
    await sleep(3000);
    const sample=async()=>{
      if(logError)throw logError;
      const diagnostics=await api('/diagnostics');
      const inbound=await page.evaluate(async()=>{const r=[];for(const p of window.reviewPCs)if(p.connectionState==='connected')
        for(const v of (await p.getStats()).values())if(v.type==='inbound-rtp')r.push({...v});return r;});
      const previous=result.samples.at(-1);
      result.samples.push({wall:Date.now(),rssKiB:Number(execFileSync('/bin/ps',['-p',String(child.pid),'-o','rss='],{encoding:'utf8'}).trim()),
        app:diagnostics.app,video:diagnostics.video,audio:diagnostics.audio,system:diagnostics.system,inbound});save();
      if(!diagnostics.app.live||!diagnostics.app.capturing||diagnostics.video.hardware_encoder!==(encoder==='videotoolbox')||
        diagnostics.video.active_codec!=='H.264'||diagnostics.video.encode_failures!==0||diagnostics.video.encode_timeouts!==0||
        diagnostics.video.send_failures!==0||diagnostics.audio.send_failures!==0)throw Error('Publisher health/encoder assertion failed during A/V observation');
      if(diagnostics.video.configured_width!==width||diagnostics.video.configured_height!==height||diagnostics.video.configured_fps!==fps)
        throw Error('Publisher A/V output configuration differs from the requested format');
      for(const [kind,counter] of [['video','framesDecoded'],['audio','packetsReceived']]) {
        const current=inbound.filter(item=>item.kind===kind).reduce((n,item)=>n+(item[counter]||0),0);
        const before=previous?.inbound.filter(item=>item.kind===kind).reduce((n,item)=>n+(item[counter]||0),0)||0;
        if(current<=before)throw Error('Received '+kind+' stopped advancing during A/V observation');
      }
    };
    async function phase(name) {
      const entry={name,started:Date.now()};result.phases.push(entry);save();
      // Register each recorder immediately, so a failed second start still
      // preserves and closes the first recording during cleanup.
      const pair=[];
      for(const [kind,target,options] of [
        ['source',source,{includeVideo:true,sourceStreamKey:'fixtureReference'}],
        ['receiver',page,{includeVideo:true}]]) {
        const recording=await recorder.record(target,path.join(report,name+'-'+kind+'.webm'),options);
        pair.push(recording);recordings.add(recording);entry[kind]=recording.metadata;save();
      }
      for(let elapsed=0;elapsed<seconds;elapsed+=5) {await sleep(Math.min(5,seconds-elapsed)*1000);await sample();}
      for(const r of pair){await r.stop();recordings.delete(r);}
      entry.ended=Date.now();save();
      console.log(name+': paired recordings complete');
    }
    await phase('initial');
    if(hold) {
      for(let elapsed=0;elapsed<hold;elapsed+=5) {
        await sleep(Math.min(5,hold-elapsed)*1000);await sample();
        const disk=fs.statfsSync(report);if(disk.bavail*disk.bsize<128*1024*1024)throw Error('Insufficient space for final A/V evidence');
        if((elapsed+5)%60===0)console.log('Same publisher held live for '+(elapsed+5)+' seconds');
      }
      await phase('final');
    }
    result.sourceFixture=await source.evaluate(()=>window.fixture);
    await page.screenshot({path:path.join(report,'receiver.png')});
    await api('/commands',{command:'quit'});await waitFor(()=>child.exitCode!==null,10000,'Publisher did not quit');
    if(child.exitCode!==0||fs.existsSync(discovery))throw Error('Publisher shutdown/discovery cleanup failed');
    result.recordingWorkflowPassed=true;save();
    // Analyze only after capture ends, so offline decoding cannot change its cadence.
    execFileSync('python3',[path.join(__dirname,'macos-analyze-av-sync.py'),report,'--ffmpeg',opts.ffmpeg||'/opt/homebrew/bin/ffmpeg'],{stdio:'inherit',timeout:180000});
    result.analysis=JSON.parse(fs.readFileSync(path.join(report,'av-analysis.json')));
    result.passed=result.analysis.passed;
    if(!result.passed)process.exitCode=1;
  } catch(error) {result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;}
  finally {
    for(const recording of recordings)try{await recording.stop();}catch(error){result.recordingError=String(error);result.passed=false;process.exitCode=1;}
    if(child&&child.exitCode===null)child.kill('SIGTERM');
    for(const browser of browsers)await browser.close().catch(()=>{});
    if(server)await new Promise(resolve=>server.close(resolve));save();
    console.log(JSON.stringify({report,passed:result.passed}));
  }
})();
