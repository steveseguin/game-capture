'use strict';
// Hold one owned synthetic window/audio source while a hosted browser receives.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {waitFor,sleep}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');for(const key of ['app','reports','encoder','source-ui-helper'])assert(opts[key]);
assert(['videotoolbox','x264'].includes(opts.encoder));
const exe=path.resolve(opts.app,'Contents/MacOS/game-capture'),helper=path.resolve(opts['source-ui-helper']);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const expected='dc4311c7c648fdf8d5cf3a196e8bfd1ee9160e96c34420132ff83a3f39b36dc4';assert.equal(sha(fs.readFileSync(exe)),expected);
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const stream='gcwan'+crypto.randomBytes(16).toString('hex'),discovery=path.join(report,'private-control.json');
const result={scope:'Packaged Mac sender for an independently hosted receiver; join receiver evidence using the session binding hash',
  encoder:opts.encoder,executableSha256:expected,harnessSha256:sha(fs.readFileSync(__filename)),
  uiHelperSha256:sha(fs.readFileSync(helper)),sessionBindingSha256:sha(stream),
  host:{platform:os.platform(),release:os.release(),arch:os.arch()},
  requested:{width:1920,height:1080,fps:60,bitrateKbps:8000,audio:'selected-window'},samples:[],passed:false};
fs.copyFileSync(__filename,path.join(report,'harness.js'));
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
const clean=value=>String(value).replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi,'<url>').replaceAll(stream,'<owned-session>');
let browser,publisher,control,log,finish,timer,finished=false;
const completion=new Promise(resolve=>{finish=reason=>{if(!finished){finished=true;resolve(reason);}};});
process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',data=>{input+=data;let at;while((at=input.indexOf('\n'))>=0){const line=input.slice(0,at).trim();input=input.slice(at+1);if(line==='finish')finish('requested');}});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>finish(signal));
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}
const select=d=>({time:Date.now(),live:d.app.live,capturing:d.app.capturing,sourceWidth:d.source.width,sourceHeight:d.source.height,
  encoder:d.video.active_encoder,hardware:d.video.hardware_encoder,codec:d.video.active_codec,
  framesCaptured:d.video.frames_captured,framesSent:d.video.frames_sent,encodeFailures:d.video.encode_failures,
  encodeTimeouts:d.video.encode_timeouts,sendFailures:d.video.send_failures,audioPacketsSent:d.metrics.audio_packets_sent});
(async()=>{console.log('Reports: '+report);save();try{
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_|GITHUB_|ACTIONS_|GH_)/.test(k)));
  browser=await chromium.launch({headless:false,env,args:['--autoplay-policy=no-user-gesture-required','--window-position=80,80','--window-size=1000,700','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const source=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1}),title='Owned Independent Mac Source '+crypto.randomBytes(8).toString('hex');
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0};
    function draw(){canvas.width=innerWidth;canvas.height=innerHeight;fixture.id=(fixture.id+1)%65536;const w=canvas.width,h=canvas.height;
      ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);const shift=fixture.id*3%64;
      for(let y=-32;y<h+32;y+=32)for(let x=-64;x<w+64;x+=32){ctx.fillStyle=((x/32+y/32)%2+2)%2?'#908060':'#304050';ctx.fillRect(x+shift,y+fixture.id%32,30,30);}
      ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
      ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('Owned independent fixture '+fixture.id,30,.9*h);requestAnimationFrame(draw);
    }draw();</script>`);
  await source.evaluate(async()=>{const context=window.fixtureAudio=new AudioContext({sampleRate:48000}),merger=context.createChannelMerger(2);merger.connect(context.destination);
    for(const [channel,hz] of [440,880].entries()){const tone=context.createOscillator(),gain=context.createGain();tone.frequency.value=hz;gain.gain.value=.04;tone.connect(gain);gain.connect(merger,0,channel);tone.start();}await context.resume();});
  const session=await browser.newBrowserCDPSession(),processes=await session.send('SystemInfo.getProcessInfo'),owned=processes.processInfo.find(p=>p.type==='browser');assert(Number.isInteger(owned?.id));
  const command=execFileSync('/bin/ps',['-p',String(owned.id),'-o','command='],{encoding:'utf8'}),profile=command.match(/--user-data-dir=(\S+)/)?.[1];
  const browserExe=chromium.executablePath(),bundleAt=browserExe.indexOf('.app/Contents/MacOS/');assert(profile?.includes('/playwright_chromiumdev_profile-')&&bundleAt>0);
  execFileSync('/usr/bin/open',['-a',browserExe.slice(0,bundleAt+4),'--args','--user-data-dir='+profile],{timeout:5000});await sleep(500);await source.bringToFront();
  execFileSync(helper,[String(owned.id),'activate'],{timeout:5000});await session.detach();await sleep(1000);
  result.browserVersion=browser.version();result.sourceViewport=await source.evaluate(()=>({width:innerWidth,height:innerHeight}));
  log=fs.createWriteStream(path.join(report,'private-publisher.log'));
  publisher=spawn(exe,['--headless','--window='+title,'--stream='+stream,'--password=false','--video-codec=h264','--video-encoder='+opts.encoder,
    '--width=1920','--height=1080','--fps=60','--bitrate-kbps=8000','--audio-source=selected-window','--duration-ms=1200000',
    '--local-control','--local-control-port=0','--local-control-discovery='+discovery],{cwd:report,env,stdio:['ignore','pipe','pipe']});
  publisher.stdout.pipe(log,{end:false});publisher.stderr.pipe(log,{end:false});publisher.closed=new Promise(resolve=>publisher.once('close',resolve));
  publisher.on('error',error=>{result.launchError=clean(error);finish('launch-error');});publisher.once('exit',()=>finish('publisher-exit'));
  await waitFor(()=>{assert.equal(publisher.exitCode,null);assert(!result.launchError);return fs.existsSync(discovery);},15000,'Publisher control discovery unavailable');
  control=JSON.parse(fs.readFileSync(discovery));assert.equal(control.pid,publisher.pid);
  await waitFor(async()=>{const d=await api('/diagnostics');return d.app.live&&d.app.capturing&&d.source.has_frame;},15000,'Owned capture did not start');
  result.initial=select(await api('/diagnostics'));save();
  fs.writeFileSync(path.join(report,'private-receiver-request.json'),JSON.stringify({ref:'macos-independent-receiver',inputs:{stream,encoder:opts.encoder}},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({ready:true,report,sessionBindingSha256:result.sessionBindingSha256}));
  timer=setTimeout(()=>finish('deadline'),18*60*1000);
  while(!finished){const reason=await Promise.race([completion,sleep(10000).then(()=>null)]);if(reason)break;result.samples.push(select(await api('/diagnostics')));save();}
  result.finishReason=await completion;assert.equal(result.finishReason,'requested','Sender did not finish normally');
  result.final=select(await api('/diagnostics'));assert(result.final.framesSent>0&&result.final.audioPacketsSent>0);
  assert.equal(result.final.codec,'H.264');assert.equal(result.final.hardware,opts.encoder==='videotoolbox');
  await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Sender did not quit');await publisher.closed;
  assert.equal(publisher.exitCode,0);assert(!fs.existsSync(discovery));result.passed=true;
}catch(error){result.error=clean(error.stack||error);process.exitCode=1;}
finally{
  clearTimeout(timer);
  if(publisher&&publisher.exitCode===null){try{if(control)await api('/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,5000,'Cleanup quit timed out');}catch{publisher.kill('SIGTERM');await publisher.closed;}}
  if(browser)await browser.close();if(log)await new Promise(resolve=>log.end(resolve));
  if(publisher){result.exitCode=publisher.exitCode;result.exitSignal=publisher.signalCode;}
  process.stdin.pause();save();console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
}})();
