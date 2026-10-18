'use strict';
// Linux transport adapter for the shared real director/scene/guest workflow.
// Owned X11 window and virtual stereo input; no physical-device qualification.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {chromium}=require('playwright');
const {waitFor,sleep}=require('./macos-media-receiver');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(opts){
  for(const key of ['publisher','manifest-sha256','reports'])assert(opts[key],'Required --'+key);
  assert.equal(process.platform,'linux');
  assert.equal(opts.backend||'x11','x11','This adapter qualifies X11; Wayland room consent remains open');
  assert.equal(Number(opts['performance-seconds']||0),0,'Timed room qualification needs a calibrated Linux source');
  const exe=path.resolve(opts.publisher),bundle=path.resolve(path.dirname(exe),'../..');
  const file=path.join(bundle,'release-artifact-manifest.json');
  assert.equal(sha(file),opts['manifest-sha256']);
  const manifest=JSON.parse(fs.readFileSync(file));assert.equal(sha(exe),manifest.artifact.sha256);
  assert.equal(manifest.payload.fileCount,manifest.payload.files.length);
  for(const item of manifest.payload.files){
    const target=path.resolve(bundle,item.relativePath);assert(target.startsWith(bundle+path.sep));
    assert.equal(fs.statSync(target).size,item.size);assert.equal(sha(target),item.sha256);
  }
  return {exe,manifestSha256:sha(file),fixtureSha256:sha(__filename)};
}

async function create(opts,report){
  const pactl=(...args)=>execFileSync('pactl',args,{encoding:'utf8',timeout:5000}).trim();
  const modules=[];let browser,tone,timer,source,error=null,blocked=false,frames=0;
  const defaultSink=pactl('get-default-sink');
  const suffix=crypto.randomBytes(8).toString('hex'),sink='gc_room_'+suffix,input=sink+'_input';
  const title='Owned Linux Capture Room '+suffix;
  const env={...process.env,QT_QPA_PLATFORM:'xcb',XDG_SESSION_TYPE:'x11'};delete env.WAYLAND_DISPLAY;
  async function close(){
    clearInterval(timer);
    if(tone){tone.stdin.end();await Promise.race([tone.closed,sleep(2000)]);if(tone.exitCode===null&&!tone.signalCode)tone.kill();await tone.closed;}
    if(browser)await browser.close();
    for(const id of modules.reverse())pactl('unload-module',id);
    const remaining=JSON.parse(pactl('--format=json','list','modules')).filter(m=>modules.includes(String(m.index)));
    assert.equal(remaining.length,0,'Owned audio modules survived cleanup');
    assert.equal(pactl('get-default-sink'),defaultSink,'Fixture changed default audio output');
    fs.writeFileSync(path.join(report,'linux-fixture-cleanup.json'),JSON.stringify({passed:true,modulesRetired:true,defaultSinkUnchanged:true},null,2));
  }
  try{
    modules.push(pactl('load-module','module-null-sink','sink_name='+sink,'rate=48000','channels=2'));
    modules.push(pactl('load-module','module-remap-source','master='+sink+'.monitor','source_name='+input,
      'source_properties=device.description=GameCaptureOwnedRoomInput'));
    tone=spawn('paplay',['--raw','--format=float32le','--rate=48000','--channels=2','--latency-msec=20',
      '--device='+sink,'--property=application.name=Game Capture owned room QA'],{stdio:['pipe','ignore','pipe']});
    tone.closed=new Promise(resolve=>tone.once('close',resolve));
    tone.on('error',e=>error=String(e));tone.stderr.on('data',d=>error=String(d));tone.stdin.on('error',e=>error=String(e));
    tone.stdin.on('drain',()=>blocked=false);
    timer=setInterval(()=>{
      if(blocked||tone.exitCode!==null)return;
      const block=Buffer.alloc(960*2*4);
      for(let i=0;i<960;i++)for(let c=0;c<2;c++)block.writeFloatLE(.15*Math.sin(2*Math.PI*[440,880][c]*(frames+i)/48000),(i*2+c)*4);
      frames+=960;blocked=!tone.stdin.write(block);
    },20);
    browser=await chromium.launch({executablePath:opts.browser||'/usr/bin/google-chrome',headless:false,env,
      args:['--window-size=1400,900','--window-position=0,0','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    source=await browser.newPage({viewport:{width:1280,height:720}});
    await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas width=1280 height=720></canvas><script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0,paused:false};
      function draw(){if(!fixture.paused)fixture.id=(fixture.id+1)%65536;const w=canvas.width,h=canvas.height;
        ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);
        ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
        for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
        requestAnimationFrame(draw);}draw();</script>`);
    await source.bringToFront();await sleep(1000);
    await waitFor(()=>{assert.equal(tone.exitCode,null,'Owned stereo source exited');assert(!error,error);return frames>4800;},5000,'Owned tone not ready');
    await source.screenshot({path:path.join(report,'linux-source.png')});
    return {sourceArgs:['--source=window','--window='+title],audioArgs:['--audio-source=none','--include-microphone','--microphone-device=pulse:'+input],
      pause:()=>source.evaluate(()=>fixture.paused=true),resume:()=>source.evaluate(()=>fixture.paused=false),close};
  }catch(e){await close();throw e;}
}
module.exports={verify,create};
