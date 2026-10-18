'use strict';
// Linux transport adapter for the shared real director/scene/guest workflow.
// Owned X11/Wayland window and virtual stereo input; no physical-device qualification.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process');
const {chromium}=require('playwright');
const {waitFor,sleep}=require('./macos-media-receiver');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(opts){
  for(const key of ['publisher','manifest-sha256','reports'])assert(opts[key],'Required --'+key);
  assert.equal(process.platform,'linux');
  assert(['x11','wayland'].includes(opts.backend||'x11'));
  assert(opts.backend!=='wayland'||opts.gui==='true','Wayland room adapter requires GUI consent');
  assert(opts.gui!=='true'||opts['signaling-recovery']!=='true','GUI signaling proxy configuration is not yet qualified');
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
  const modules=[];let browser,tone,timer,source,error=null,blocked=false,frames=0,keyboard,keyboardDirectory,selector,portalOwner;
  const wayland=opts.backend==='wayland',gui=opts.gui==='true';
  const evidence={backend:wayland?'wayland':'x11',gui,portalSelections:[]};
  if(gui)assert(wayland?process.env.GC_QA_WAYLAND_DESKTOP:process.env.GC_QA_PRIVATE_DESKTOP,'Use the matching owned desktop wrapper');
  const defaultSink=pactl('get-default-sink');
  const suffix=crypto.randomBytes(8).toString('hex'),sink='gc_room_'+suffix,input=sink+'_input';
  const title='Owned Linux Capture Room '+suffix,inputLabel='GameCaptureOwnedRoomInput_'+suffix;
  const env={...process.env,QT_QPA_PLATFORM:wayland?'wayland':'xcb',XDG_SESSION_TYPE:wayland?'wayland':'x11',QT_LINUX_ACCESSIBILITY_ALWAYS_ON:'1'};
  if(wayland)env.WAYLAND_DISPLAY=process.env.WAYLAND_DISPLAY||'wayland-0';else delete env.WAYLAND_DISPLAY;
  const helper=path.join(report,'linux-ui-control.py'),portal=path.join(report,'linux-portal-select.py');
  for(const name of ['linux-ui-control.py','linux-portal-select.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
  function checkPortal(){
    const owner=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.impl.portal.desktop.gnome'],{env,encoding:'utf8',timeout:5000}).trim();
    if(portalOwner)assert.equal(owner,portalOwner,'GNOME portal restarted');else evidence.portalOwner=portalOwner=owner;
  }
  async function close(){
    clearInterval(timer);
    if(tone){tone.stdin.end();await Promise.race([tone.closed,sleep(2000)]);if(tone.exitCode===null&&!tone.signalCode)tone.kill();await tone.closed;}
    if(browser)await browser.close();
    if(selector&&selector.exitCode===null){selector.kill();await selector.closed;}
    if(keyboard){keyboard.stdin.end();await waitFor(()=>keyboard.exitCode!==null,8000,'Owned keyboard did not retire');await keyboard.closed;}
    if(keyboardDirectory)fs.rmdirSync(keyboardDirectory);
    for(const id of modules.reverse())pactl('unload-module',id);
    const remaining=JSON.parse(pactl('--format=json','list','modules')).filter(m=>modules.includes(String(m.index)));
    assert.equal(remaining.length,0,'Owned audio modules survived cleanup');
    assert.equal(pactl('get-default-sink'),defaultSink,'Fixture changed default audio output');
    if(wayland){await sleep(2500);checkPortal();evidence.portalSurvived=true;}
    fs.writeFileSync(path.join(report,'linux-room-desktop.json'),JSON.stringify(evidence,null,2));
    fs.writeFileSync(path.join(report,'linux-fixture-cleanup.json'),JSON.stringify({passed:true,modulesRetired:true,defaultSinkUnchanged:true},null,2));
  }
  try{
    if(wayland){
      checkPortal();keyboardDirectory=fs.mkdtempSync(path.join(require('os').tmpdir(),'gc-wayland-keys-'));
      fs.chmodSync(keyboardDirectory,0o700);env.GC_QA_KEYBOARD_SOCKET=path.join(keyboardDirectory,'input.sock');
      keyboard=spawn('sudo',['-n','python3',portal,'--keyboard-server='+env.GC_QA_KEYBOARD_SOCKET],{env,stdio:['pipe','pipe','pipe']});
      keyboard.closed=new Promise(resolve=>keyboard.once('close',resolve));let ready='';keyboard.stdout.on('data',d=>ready+=d);keyboard.stderr.on('data',d=>process.stderr.write(d));
      await waitFor(()=>{assert.equal(keyboard.exitCode,null);return ready.includes('ready');},10000,'Owned keyboard not ready');
    }
    modules.push(pactl('load-module','module-null-sink','sink_name='+sink,'rate=48000','channels=2'));
    modules.push(pactl('load-module','module-remap-source','master='+sink+'.monitor','source_name='+input,
      'source_properties=device.description='+inputLabel));
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
      args:[...(wayland?['--ozone-platform=wayland','--window-size=720,560']:['--window-size=1400,900']),'--window-position=0,0','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    source=await browser.newPage({viewport:wayland?null:{width:1280,height:720}});
    await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas width=1280 height=720></canvas><script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0,paused:false};
      function draw(){canvas.width=innerWidth;canvas.height=innerHeight;if(!fixture.paused)fixture.id=(fixture.id+1)%65536;const w=canvas.width,h=canvas.height;
        ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);
        ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
        for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
        requestAnimationFrame(draw);}draw();</script>`);
    await source.bringToFront();await sleep(1000);
    await waitFor(()=>{assert.equal(tone.exitCode,null,'Owned stereo source exited');assert(!error,error);return frames>4800;},5000,'Owned tone not ready');
    await source.screenshot({path:path.join(report,'linux-source.png')});
    async function startGui(publisher,control,api,config){
      const ui=(...args)=>execFileSync('python3',[helper,String(publisher.pid),...args],{env,encoding:'utf8',timeout:wayland?60000:12000,stdio:['ignore','pipe','pipe']});
      const rows=()=>JSON.parse(ui('dump'));
      await waitFor(()=>{try{return rows().some(r=>['Go live','Go live unavailable'].includes(r.name));}catch{return false;}},20000,'Room GUI not accessible');
      assert(!(await api(control,'/diagnostics')).app.capturing,'Room GUI launched with capture active');
      ui('press','Show advanced settings');ui('choose','Auto (Hardware, then Software)','Software (x264 / VP9 / AV1 / HEVC)');
      ui('choose','60','30');assert(rows().some(r=>r.role==='combo box'&&r.name==='1280x720'));
      const mic=rows().find(r=>r.role==='combo box'&&['No microphone','Linux default microphone/input'].includes(r.name));assert(mic);
      ui('choose-prefix',mic.name,inputLabel);ui('choose','Selected window/app audio','Selected microphone/input');
      ui('text','Stream ID or VDO.Ninja URL',config.stream);ui('text','Stream password',config.password);ui('text','Room',config.room);
      ui('press','Enable director control via data channel');ui('text','Control token',config.remoteToken);
      if(!config.remoteEnabled)ui('press','Enable director control via data channel');
      assert(rows().find(r=>r.name==='Use 640x360 for room guests/directors/viewers').states.includes('checked'));
      assert.equal(rows().find(r=>r.name==='Enable director control via data channel').states.includes('checked'),config.remoteEnabled);
      assert.equal(JSON.parse(ui('read-text','Room')),config.room);
      ui('source',wayland?'Choose a window':title);
      evidence.configuredThroughGui=true;evidence.controlTokenAccessible=true;evidence.remoteControlEnabled=config.remoteEnabled;
      async function goLive(){
        let selected;
        if(wayland){
          checkPortal();assert(title.startsWith('Owned Linux Capture '));selected=path.join(report,'room-portal-'+(evidence.portalSelections.length+1)+'.json');
          const log=fs.createWriteStream(selected+'.log');selector=spawn('python3',[portal,'--title='+title,'--output='+selected],{env,stdio:['ignore','pipe','pipe']});
          selector.stdout.pipe(log,{end:false});selector.stderr.pipe(log,{end:false});selector.closed=new Promise(resolve=>selector.once('close',()=>log.end(resolve)));
        }
        ui('press','Go live');await waitFor(async()=>{if(wayland)assert(selector.exitCode===null||selector.exitCode===0,'Portal selection failed');return (await api(control,'/diagnostics')).app.live;},30000,'Room GUI did not go live');
        if(wayland){await waitFor(()=>selector.exitCode!==null,10000,'Portal selector did not finish');await selector.closed;assert.equal(selector.exitCode,0);assert(JSON.parse(fs.readFileSync(selected)).passed);evidence.portalSelections.push({file:path.basename(selected),sha256:sha(selected)});checkPortal();}
      }
      await goLive();
      return {restart:async()=>{
        ui('press','Stop streaming');await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'Room Stop did not retire capture');
        const before=await api(control,'/diagnostics');await sleep(500);assert.equal((await api(control,'/diagnostics')).video.frames_captured,before.video.frames_captured);
        const resolution=JSON.parse(ui('read-text','Custom stream resolution')).match(/^(\d+)x(\d+)$/);assert(resolution);
        await goLive();evidence.stopRestartPassed=true;return {width:Number(resolution[1]),height:Number(resolution[2])};
      }};
    }
    return {environment:env,evidence,startGui,sourceArgs:['--source=window','--window='+title],audioArgs:['--audio-source=none','--include-microphone','--microphone-device=pulse:'+input],
      pause:()=>source.evaluate(()=>fixture.paused=true),resume:()=>source.evaluate(()=>fixture.paused=false),close};
  }catch(e){await close();throw e;}
}
module.exports={verify,create};
