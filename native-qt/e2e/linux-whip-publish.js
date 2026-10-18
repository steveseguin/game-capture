#!/usr/bin/env node
'use strict';
// Extracted Ubuntu DEB -> X11 or native Wayland GUI/software H264 + virtual input -> WHIP/browser.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http'),https=require('https'),net=require('net'),dgram=require('dgram');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiverAt,observe,requireMoving,observeAudio}=require('./macos-media-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const assert=require('assert/strict');
assert.equal(process.platform,'linux');for(const key of ['publisher','reports','server','manifest-sha256'])assert(opts[key]);
const turnDiscovery=opts['turn-discovery']||'none',unresponsiveStun=opts['unresponsive-stun']==='true';
assert(['none','options','post'].includes(turnDiscovery));assert(turnDiscovery==='none'||opts['turn-server']);
const failure=opts.failure||'';assert(['','unauthorized','invalid-tls','cancel','cancel-gathering','malformed','oversized'].includes(failure));
const tls=opts.tls==='true'||failure==='invalid-tls';assert(!(unresponsiveStun&&turnDiscovery!=='none'));
const wayland=opts.backend==='wayland';assert(!wayland||opts.gui==='true','Wayland output fixture requires actual GUI');
const gui=opts.gui==='true';if(gui){assert(wayland?process.env.GC_QA_WAYLAND_DESKTOP:process.env.GC_QA_PRIVATE_DESKTOP,'GUI requires the matching owned desktop fixture');assert(!tls&&!failure&&!unresponsiveStun&&turnDiscovery==='none','GUI fixture currently covers authenticated HTTP publishing');}
const exe=path.resolve(opts.publisher),bundle=path.resolve(path.dirname(exe),'../..');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifestFile=path.join(bundle,'release-artifact-manifest.json');assert.equal(hash(manifestFile),opts['manifest-sha256']);
const manifest=JSON.parse(fs.readFileSync(manifestFile));assert.equal(hash(exe),manifest.artifact.sha256);
for(const item of manifest.payload.files){const file=path.resolve(bundle,item.relativePath);assert(file.startsWith(bundle+path.sep));assert.equal(fs.statSync(file).size,item.size);assert.equal(hash(file),item.sha256);}
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
for(const name of ['linux-whip-publish.js','macos-media-receiver.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const result={gui,backend:wayland?'wayland':'x11',executableSha256:hash(exe),manifestSha256:hash(manifestFile),harnessSha256:hash(__filename),receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),
 serverSha256:hash(path.resolve(opts.server)),turnDiscovery,tls,failure,unresponsiveStun:unresponsiveStun?{requests:0}:null,
 scope:'Extracted Ubuntu DEB; X11 software H264 and owned virtual stereo microphone through local authenticated WHIP. Browser decoded media, late viewer, restart recovery and session cleanup. HTTPS uses an isolated publisher mount namespace with a private CA when requested. Excludes GUI, Wayland, physical microphone, public CA/WAN/TURN deployment, default 720p60 and endurance.',cases:[],trace:[],passed:false};
if(gui){for(const name of ['linux-output-gui.js','linux-ui-control.py',...(wayland?['linux-wayland-desktop.py','linux-portal-select.py']:['linux-private-desktop.py'])]){fs.copyFileSync(path.join(__dirname,name),path.join(report,name));result[name+'Sha256']=hash(path.join(report,name));}result.scope=result.scope.replace('Excludes GUI, Wayland','Actual Qt GUI, saved-profile relaunch and Stop/Go live cycles. Excludes Wayland');}
if(turnDiscovery!=='none')result.turnServerSha256=hash(path.resolve(opts['turn-server']));
if(wayland)result.scope=result.scope.replace('X11','Native GNOME Wayland').replace('Excludes Wayland,','Fresh portal consent on each Go live. Excludes');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_|GH_TOKEN|GITHUB_TOKEN|ACTIONS_.*TOKEN|SSL_CERT_)/.test(k)));
Object.assign(env,{QT_QPA_PLATFORM:wayland?'wayland':'xcb',XDG_SESSION_TYPE:wayland?'wayland':'x11',XDG_STATE_HOME:path.join(report,'private-state'),XDG_CONFIG_HOME:path.join(report,'private-config'),XDG_DATA_HOME:path.join(report,'private-data')});if(wayland)env.WAYLAND_DISPLAY=process.env.WAYLAND_DISPLAY||'wayland-0';else delete env.WAYLAND_DISPLAY;
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');save();
const pactl=(...args)=>execFileSync('pactl',args,{encoding:'utf8',timeout:5000}).trim();
const modules=[];let desktop,sourceBrowser,source,toneTimer,toneChild,toneSilent=false,lastControl,trustDirectory;
const hostTrustSha256=hash('/etc/ssl/certs/ca-certificates.crt');
const scheme=tls?'https':'http';
const children=new Set();let browser,proxy,server,stalledStun,serverRunning=false;
const token=crypto.randomBytes(24).toString('hex');let currentCase='',reject=failure==='unauthorized';
function launch(program,args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  let command=path.resolve(program);
  if(command===exe&&trustDirectory){args=['--die-with-parent','--unshare-user','--bind','/','/','--ro-bind',trustDirectory,'/etc/ssl/certs','--',command,...args];command='/usr/bin/bwrap';}
  const p=spawn(command,args,{env:{...env,...(path.resolve(program)===path.resolve(opts['turn-server']||'/nonexistent')&&opts['turn-libraries']?{LD_LIBRARY_PATH:path.resolve(opts['turn-libraries'])}:{})},cwd:report,stdio:['pipe','pipe','pipe']});children.add(p);
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
  const webPort=await port(),apiPort=await port(),udpPort=await port(true);
  let turnConfig='';
  if(turnDiscovery!=='none'){
    const turnPort=await port(true),turnPassword=crypto.randomBytes(24).toString('hex');
    const turn=launch(opts['turn-server'],['-n','--listening-ip=127.0.0.1','--relay-ip=127.0.0.1',`--listening-port=${turnPort}`,
      '--no-cli','--no-tcp','--no-tls','--no-dtls','--no-tcp-relay','--allow-loopback-peers','--no-multicast-peers',
      '--lt-cred-mech','--realm=game-capture-loopback-fixture',`--user=gcqa:${turnPassword}`,'--fingerprint','--relay-threads=1',
      `--userdb=${path.join(report,'turn.sqlite')}`,`--pidfile=${path.join(report,'turn.pid')}`,'--log-file=stdout','--simple-log'],'turn');
    await waitFor(()=>{if(turn.exitCode!==null)throw Error('Owned TURN server exited');return stunReady(turnPort);},10000,'TURN server did not answer local STUN probe');
    turnConfig=`webrtcICEServers2:\n  - url: turn:127.0.0.1:${turnPort}?transport=udp\n    username: gcqa\n    password: ${JSON.stringify(turnPassword)}\n    clientOnly: true\n`;
    result.turnListener={address:'127.0.0.1',port:turnPort};
  }
  const config=path.join(report,'mediamtx.yml');fs.writeFileSync(config,`logLevel: info\napi: true\napiAddress: 127.0.0.1:${apiPort}\nrtsp: false\nrtmp: false\nsrt: false\nhls: false\nmoq: false\nwebrtcAddress: 127.0.0.1:${webPort}\nwebrtcLocalUDPAddress: 127.0.0.1:${udpPort}\nwebrtcIPsFromInterfaces: false\nwebrtcAdditionalHosts: [127.0.0.1]\n${turnConfig}paths:\n  all_others:\n`);
  let generation=0;
  async function startServer(){server=launch(opts.server,[config],'server-'+generation++);await waitFor(async()=>{if(server.exitCode!==null)throw Error('Server exited');return fetch(`http://127.0.0.1:${apiPort}/v3/paths/list`).then(r=>r.ok).catch(()=>false);},10000,'MediaMTX did not start');serverRunning=true;}
  await startServer();
  if(unresponsiveStun){
    // Bind and deliberately discard only this fixture's requests; no firewall
    // changes and no dependence on an external host remaining unavailable.
    stalledStun=dgram.createSocket('udp4');result.unresponsiveStun={requests:0};
    stalledStun.on('message',()=>++result.unresponsiveStun.requests);
    await new Promise(resolve=>stalledStun.bind(0,'127.0.0.1',resolve));
  }
  const proxyHandler=(req,res)=>{
    const authorized=req.headers.authorization==='Bearer '+token;
    const trace={case:currentCase,method:req.method,authorized,path:req.url,duringServerOutage:!serverRunning};result.trace.push(trace);
    if(reject||!authorized){res.writeHead(401);res.end();return;}
    if(failure==='cancel'&&req.method==='POST')return;
    if(['malformed','oversized'].includes(failure)){
      if(req.method==='POST'){res.writeHead(201,{'Content-Type':'application/sdp',Location:'/owned-failure/session'});res.end(failure==='oversized'?'x'.repeat(2*1024*1024):'not an SDP');}
      else{res.writeHead(204);res.end();}return;
    }
    if(req.method==='POST'){
      const chunks=[];req.on('data',chunk=>chunks.push(chunk));
      req.on('end',()=>{trace.candidateTypes=[...Buffer.concat(chunks).toString().matchAll(/^a=candidate:.*? typ (\S+)/gm)].map(m=>m[1]);});
    }
    const upstream=http.request({hostname:'127.0.0.1',port:webPort,path:req.url,method:req.method,headers:{'content-type':req.headers['content-type']||'application/sdp'}},reply=>{
      const headers={...reply.headers};
      if(unresponsiveStun&&req.method==='OPTIONS')headers.link=`<stun:127.0.0.1:${stalledStun.address().port}>; rel="ice-server"`;
      if(turnDiscovery==='post'&&req.method==='OPTIONS')delete headers.link;
      trace.status=reply.statusCode;trace.advertisesTurn=/\bturns?:/.test(String(headers.link||''));
      if(headers.location){const url=new URL(headers.location,`http://127.0.0.1:${webPort}`);headers.location=`${scheme}://127.0.0.1:${proxy.address().port}`+url.pathname+url.search;}
      res.writeHead(reply.statusCode,headers);reply.pipe(res);
    });upstream.on('error',()=>{trace.status=502;if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
  };
  if(tls){
    const key=path.join(report,'private-tls.key'),cert=path.join(report,'private-tls.crt');
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Owned WHIP QA','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore',timeout:10000});
    proxy=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},proxyHandler);
    result.tlsEvents=[];proxy.on('secureConnection',()=>result.tlsEvents.push('accepted'));proxy.on('tlsClientError',()=>result.tlsEvents.push('rejected'));
    if(failure!=='invalid-tls'){
      trustDirectory=path.join(report,'private-trust');fs.mkdirSync(trustDirectory,{mode:0o700});
      fs.copyFileSync('/etc/ssl/certs/ca-certificates.crt',path.join(trustDirectory,'ca-certificates.crt'));
      fs.copyFileSync(cert,path.join(trustDirectory,'owned-ca.crt'));
      execFileSync('/usr/bin/openssl',['rehash',trustDirectory],{stdio:'pipe',timeout:5000});
      result.trustRootSha256=hash(cert);
    }
    result.trustScope=failure==='invalid-tls'?'No private trust root provided':'Owned CA mounted read-only at /etc/ssl/certs only in publisher user/mount namespace; host trust unchanged';
  }else proxy=http.createServer(proxyHandler);
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const suffix=crypto.randomBytes(6).toString('hex'),sink='gc_whip_'+suffix,input=sink+'_input';
  modules.push(pactl('load-module','module-null-sink','sink_name='+sink,'rate=48000','channels=2'));
  modules.push(pactl('load-module','module-remap-source','master='+sink+'.monitor','source_name='+input,'source_properties=device.description=GameCaptureOwnedWhipInput'));
  toneChild=launch('/usr/bin/paplay',['--raw','--format=float32le','--rate=48000','--channels=2','--latency-msec=20','--device='+sink],'owned-tone');
  let frames=0,blocked=false;toneChild.stdin.on('error',()=>{});toneChild.stdin.on('drain',()=>{blocked=false;});
  toneTimer=setInterval(()=>{if(blocked||toneChild.exitCode!==null)return;const b=Buffer.alloc(960*8);for(let i=0;i<960;i++)for(let c=0;c<2;c++)b.writeFloatLE(toneSilent?0:.15*Math.sin(2*Math.PI*[440,880][c]*(frames+i)/48000),i*8+c*4);frames+=960;blocked=!toneChild.stdin.write(b);},20);
  sourceBrowser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env,args:[...(wayland?['--ozone-platform=wayland','--window-size=720,560']:[]),'--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  source=await sourceBrowser.newPage(wayland?{viewport:null}:{viewport:{width:800,height:450}});const title='Owned Linux Capture WHIP '+suffix;
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden;cursor:none}canvas{display:block}</style><canvas></canvas><script>
  const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');window.fixture={id:0,paused:false};
  function draw(){canvas.width=innerWidth;canvas.height=innerHeight;const w=canvas.width,h=canvas.height;if(!fixture.paused)fixture.id=(fixture.id+1)%65536;
  ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);ctx.fillStyle='red';ctx.fillRect(0,0,w,.1*h);ctx.fillStyle='#00ff00';ctx.fillRect(0,.9*h,w,.1*h);
  ctx.fillStyle='cyan';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='magenta';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
  for(let i=0;i<16;i++){ctx.fillStyle=(fixture.id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}requestAnimationFrame(draw);}draw();</script>`);
  await source.bringToFront();await sleep(1000);result.sourceBrowserVersion=sourceBrowser.version();

  desktop=gui?require('./linux-output-gui')({exe,report,env,launch,api,title,inputLabel:'GameCaptureOwnedWhipInput'}):null;if(desktop)result.guiDesktop=desktop.evidence;
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,env,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});result.receiverBrowserVersion=browser.version();
  for(const encoder of ['software']){
    currentCase=encoder;const entry={encoder,passed:false};result.cases.push(entry);const stream='whip'+crypto.randomBytes(12).toString('hex');
    let discovery=path.join(report,encoder+'-control.json'),publisher,control,session;
    if(gui){session=await desktop.start('whip',`${scheme}://127.0.0.1:${proxy.address().port}/${stream}/whip`,token);({publisher,control,discovery}=session);entry.profileRestored=session.profileRestored;}else{
    publisher=launch(exe,['--headless','--source=window','--window='+title,'--output=whip',`--output-url=${scheme}://127.0.0.1:${proxy.address().port}/${stream}/whip`,`--output-token=${token}`,
      ...(turnDiscovery!=='none'?['--ice-mode=relay']:[]),'--audio-source=none','--include-microphone','--microphone-device=pulse:'+input,'--audio-channels=2',
      '--video-encoder=software','--video-codec=h264','--resolution=640x360','--fps=30','--bitrate-kbps=2000','--duration-ms=240000','--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`],encoder);
    await waitFor(()=>{if(publisher.exitCode!==null)throw Error('Publisher exited before discovery');return fs.existsSync(discovery);},10000,'No control discovery');
    control=JSON.parse(fs.readFileSync(discovery));}lastControl=control;
    if(failure){
      if(['cancel','cancel-gathering'].includes(failure)){
        if(failure==='cancel-gathering'){assert(unresponsiveStun);await waitFor(()=>result.unresponsiveStun.requests>0,10000,'No pending ICE gathering');}
        else await waitFor(()=>result.trace.some(t=>t.method==='POST'),20000,'No pending POST');const started=Date.now();
        await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,5000,'Pending POST blocked shutdown');entry.shutdownMs=Date.now()-started;assert.equal(publisher.exitCode,0);
      }else{await waitFor(()=>publisher.exitCode!==null,25000,'Failure was not bounded');assert.equal(publisher.exitCode,3);}
      await publisher.closed;assert(!fs.existsSync(discovery),'Discovery survived shutdown');
      if(['malformed','oversized'].includes(failure))assert(result.trace.some(t=>t.method==='DELETE'),'Failed resource was not deleted');
      if(failure==='invalid-tls'){assert(!result.trace.length,'Untrusted peer received HTTP');assert(result.tlsEvents.includes('rejected')&&!result.tlsEvents.includes('accepted'));}
      assert(!fs.readFileSync(path.join(report,encoder+'.log'),'utf8').includes(token),'Token leaked into log');entry.passed=true;continue;
    }
    const url=`http://127.0.0.1:${webPort}/${stream}/?muted=true`;
    let page=await receiverAt(browser,url,publisher);entry.moving=await observe(page,6000);entry.distinctFrames=requireMoving(entry.moving,encoder);assert.equal(entry.moving.width,gui?960:640);assert.equal(entry.moving.height,gui?540:360);entry.audio=await observeAudio(page);audioCheck(entry.audio);
    toneSilent=true;await sleep(700);entry.silence=await observeAudio(page);audioCheck(entry.silence,true);toneSilent=false;
    await source.evaluate(()=>fixture.paused=true);await sleep(700);entry.static=await observe(page,2500);if(new Set(entry.static.observations.map(f=>f.id)).size!==1||entry.static.observations.length<10)throw Error('Static video did not stay paced');await source.evaluate(()=>fixture.paused=false);
    const late=await receiverAt(browser,url,publisher);entry.late=await observe(late,3000);requireMoving(entry.late,'Late WHIP viewer');entry.lateAudio=await observeAudio(late);audioCheck(entry.lateAudio);await late.close();
    const diag=await api(control,'/diagnostics');entry.output=diag.output;if(diag.output.state!==2||diag.video.hardware_encoder)throw Error('Wrong output state/encoder');
    if(turnDiscovery!=='none'&&diag.output.ice_path!=='TURN/RELAY')throw Error('WHIP bypassed the required TURN relay');
    if(!diag.audio.active_microphone_source.includes('GameCaptureOwnedWhipInput'))throw Error('Source identity differs');
    if(JSON.stringify(diag).includes(token)||JSON.stringify(diag).includes(stream))throw Error('Token or private endpoint path leaked into diagnostics');fs.writeFileSync(path.join(report,encoder+'-diagnostics.json'),JSON.stringify(diag,null,2));
    await page.screenshot({path:path.join(report,encoder+'-receiver.png')});
    {
      entry.reconnectsBeforeServerRestart=diag.output.reconnects;
      await page.close();serverRunning=false;server.kill('SIGTERM');await server.closed;await sleep(1500);await startServer();
      await waitFor(async()=>{if(publisher.exitCode!==null)throw Error('Publisher exited during recovery');const d=await api(control,'/diagnostics');return d.output.reconnects>entry.reconnectsBeforeServerRestart&&d.output.state===2;},40000,'WHIP did not reconnect after the server restart');
      page=await receiverAt(browser,url,publisher);entry.reconnected=await observe(page,5000);requireMoving(entry.reconnected,'Recovered WHIP');entry.reconnectedAudio=await observeAudio(page);audioCheck(entry.reconnectedAudio);
      entry.recoveryOutput=(await api(control,'/diagnostics')).output;
      if(turnDiscovery!=='none'&&entry.recoveryOutput.ice_path!=='TURN/RELAY')throw Error('Recovered WHIP bypassed TURN');
    }
    const appLog=await api(control,'/logs/recent?lines=1');if(fs.readFileSync(appLog.path,'utf8').includes(token))throw Error('Token leaked into application log');
    if(gui){
      await page.close();
      const deletions=()=>result.trace.filter(t=>t.case===encoder&&t.method==='DELETE'&&t.status>=200&&t.status<300).length;
      let before=deletions();await desktop.stop(session);
      await waitFor(()=>deletions()>before,5000,'GUI Stop did not delete WHIP session');
      await desktop.restart(session);
      page=await receiverAt(browser,url,publisher);entry.guiRestarted=await observe(page,5000);requireMoving(entry.guiRestarted,'GUI restarted WHIP');entry.guiRestartedAudio=await observeAudio(page);audioCheck(entry.guiRestartedAudio);
      before=deletions();await desktop.stop(session);await waitFor(()=>deletions()>before,5000,'Second GUI Stop did not delete WHIP session');
      await desktop.quit(session);entry.guiStopRestartPassed=true;
    }else{
    await api(control,'/commands',{command:'quit'});await waitFor(()=>publisher.exitCode!==null,10000,'Publisher did not quit');if(publisher.exitCode!==0||fs.existsSync(discovery))throw Error('Publisher shutdown failed');await publisher.closed;
    }
    if(!result.trace.some(t=>t.case===encoder&&t.method==='DELETE'))throw Error('WHIP session not deleted');
    if(turnDiscovery!=='none'){
      const trace=result.trace.filter(t=>t.case===encoder),attempts=trace.filter(t=>t.method==='POST'),posts=attempts.filter(t=>t.status===201),options=trace.filter(t=>t.method==='OPTIONS'&&t.status===204);
      if(!options.length||posts.length<2||attempts.some(t=>t.status!==201&&!(t.duringServerOutage&&t.status===502)))throw Error('TURN workflow lacks successful WHIP negotiation');
      if(turnDiscovery==='post'){
        if(posts.length<2||posts[0].candidateTypes.length||!posts[0].advertisesTurn||options.some(t=>t.advertisesTurn))throw Error('Expected a candidate-free discovery POST with TURN omitted from OPTIONS');
        if(!trace.slice(trace.indexOf(posts[0])+1,trace.indexOf(posts[1])).some(t=>t.method==='DELETE'))throw Error('Discovery resource was not deleted before the relayed retry');
      }else if(options.some(t=>!t.advertisesTurn))throw Error('TURN was not advertised in OPTIONS');
      const relayed=turnDiscovery==='post'?posts.slice(1):posts;
      if(relayed.some(t=>!t.candidateTypes.length||t.candidateTypes.some(type=>type!=='relay')))throw Error('Publishing offer contains missing or non-relay candidates');
      entry.turn={discovery:turnDiscovery,relayedOffers:relayed.length,discoveryDeletedBeforeRetry:turnDiscovery==='post',allPublishingCandidatesRelay:true};
    }
    for(const file of gui?[]:[encoder+'.log'])
      if(fs.readFileSync(path.join(report,file),'utf8').includes(token))throw Error('Token leaked into publisher log');
    await page.close();entry.passed=true;console.log(encoder+': passed, distinct frames='+entry.distinctFrames);
  }
  if(unresponsiveStun&&!failure&&result.unresponsiveStun.requests<2)throw Error('Unresponsive STUN fixture did not receive retries');
  result.passed=true;
}catch(e){if(lastControl){try{result.failureDiagnostics=await api(lastControl,'/diagnostics');}catch{}}result.error=String(e.stack||e);console.error(result.error);process.exitCode=1;}
finally{clearInterval(toneTimer);if(sourceBrowser)await sourceBrowser.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});
  if(proxy){proxy.closeAllConnections();proxy.close();}if(stalledStun)stalledStun.close();
  for(const p of children)p.kill('SIGTERM');await Promise.all([...children].map(async p=>{await Promise.race([p.closed,sleep(3000)]);if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');await p.closed;}));
  if(desktop){try{await desktop.close();}catch(error){result.passed=false;result.cleanupError=String(error);process.exitCode=1;}}
  for(const module of modules.reverse())pactl('unload-module',module);
  result.hostTrustUnchanged=hash('/etc/ssl/certs/ca-certificates.crt')===hostTrustSha256;if(!result.hostTrustUnchanged){result.passed=false;process.exitCode=1;}
  save();console.log(JSON.stringify({report,passed:result.passed}));}})();
