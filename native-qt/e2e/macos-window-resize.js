#!/usr/bin/env node
'use strict';
// Packaged window publishing: a larger encoder output must recover native
// source detail, with one aspect fit through landscape/portrait transitions.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{chromium}=require('playwright');
const {sleep,waitFor,receiver,installReceiverProbe,observeDecoded,requireMoving:requireCodecMoving}=require('./macos-media-receiver');
const director=require('./director-room-e2e');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert.equal(process.platform,'darwin');assert(opts.app&&opts.reports,'Use --app and --reports');
assert(!opts.room||['true','false'].includes(opts.room),'--room must be true or false');
const roomMode=opts.room==='true';
const codec=opts.codec||'h264';assert(['h264','h265'].includes(codec));
assert(codec!=='h265'||opts.encoder==='videotoolbox','HEVC resize requires explicit VideoToolbox');
const requireMoving=(observation,label)=>requireCodecMoving(observation,label,'video/'+codec);
const cycles=Number(opts.cycles||1);
assert(Number.isInteger(cycles)&&cycles>=1&&cycles<=20,'--cycles must be an integer from 1 to 20');
const app=path.resolve(opts.app),exe=path.join(app,'Contents/MacOS/game-capture');
assert(fs.existsSync(path.join(app,'Contents/Frameworks')),'Use the deployed app');
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={scope:'Packaged native window detail and aspect through live output/source resizing; other platforms and release qualification excluded',
  roomMode,codec,cycles,executableSha256:hash(exe),harnessSha256:hash(__filename),receiverHarnessSha256:hash(path.join(__dirname,'macos-media-receiver.js')),
  directorHarnessSha256:hash(path.join(__dirname,'director-room-e2e.js')),cases:[],passed:false};
for(const name of ['macos-window-resize.js','macos-media-receiver.js','director-room-e2e.js'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
const bits=[];let random=0x5a31d2f1;
for(let i=0;i<1024;i++){random^=random<<13;random^=random>>>17;random^=random<<5;bits.push(random&1);}
const children=new Set(),browsers=new Set();let source;
function publisher(args,name){
  const log=fs.createWriteStream(path.join(report,name+'.log'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
  const child=spawn(exe,args,{cwd:report,env,stdio:['ignore','pipe','pipe']});children.add(child);
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>{child.once('close',code=>{children.delete(child);log.end();resolve(code);});child.once('error',e=>{result.launchError=String(e);});});return child;
}
async function api(control,route,body){
  const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  assert(r.ok,'Local control HTTP '+r.status);return r.json();
}
async function dimensions(page,width,height){await waitFor(()=>page.evaluate(({width,height})=>[...document.querySelectorAll('video')].some(v=>!v.paused&&v.videoWidth===width&&v.videoHeight===height),{width,height}),20000,'No decoded '+width+'x'+height);}

async function observeDetail(page,sourceWidth,sourceHeight,barWidth=2){
  return page.evaluate(({sourceWidth,sourceHeight,bits,barWidth})=>{
    const video=[...document.querySelectorAll('video')].find(v=>!v.paused&&v.videoWidth);
    if(!video)throw Error('No playing video for detail observation');
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(video,0,0);
    const width=canvas.width,height=canvas.height,data=ctx.getImageData(0,0,width,height).data;
    const yellow=(x,y)=>{const i=(y*width+x)*4;return data[i]>180&&data[i+1]>180&&data[i+2]<70;};
    const rows=[];
    for(let y=Math.floor(height*.5);y<height;y++){
      if(!yellow(Math.floor(width/2),y))continue;
      let left=Math.floor(width/2),right=left;
      while(left>0&&yellow(left-1,y))left--;while(right+1<width&&yellow(right+1,y))right++;
      if(right-left>width*.15)rows.push({y,left,right,span:right-left+1});
    }
    if(!rows.length)throw Error('Yellow detail locator missing');
    const best=rows.reduce((a,b)=>a.span>b.span?a:b),matching=rows.filter(r=>r.span>=best.span*.95);
    const scale=best.span/(sourceWidth*.6),bottom=Math.max(...matching.map(r=>r.y));
    const sampleY=Math.round(bottom+sourceHeight*.03*scale);
    if(sampleY>=height)throw Error('Detail row outside the image');
    const count=Math.floor(sourceWidth*.6/barWidth);
    let winner={agreement:-1};
    // Bounded subpixel alignment accounts for raster/codec edge rounding. The
    // random bit pattern cannot be recovered by enlarging a low-res capture.
    for(let offset=-1.5;offset<=1.5;offset+=.25){
      let matches=0,n=0,white=0,black=0,whites=0,blacks=0;
      for(let i=2;i<count-2;i++){
        const x=Math.round(best.left+(i+.5)*barWidth*scale+offset);if(x<0||x>=width)continue;
        const at=(sampleY*width+x)*4,luma=(data[at]+data[at+1]+data[at+2])/3;
        matches+=Number(Number(luma>=127)===bits[i]);n++;
        if(bits[i]){white+=luma;whites++;}else{black+=luma;blacks++;}
      }
      const candidate={agreement:matches/n,contrast:white/whites-black/blacks,samples:n,offset};
      if(candidate.agreement>winner.agreement)winner=candidate;
    }
    let minX=width,minY=height,maxX=-1,maxY=-1;
    for(let y=0;y<height*.4;y++)for(let x=Math.floor(width*.3);x<width*.7;x++){
      const i=(y*width+x)*4;
      if(data[i]<80&&data[i+1]<80&&data[i+2]>180){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    if(maxX<minX||maxY<minY)throw Error('Blue aspect fixture missing');
    const circle={width:maxX-minX+1,height:maxY-minY+1};circle.ratio=circle.width/circle.height;
    return {...winner,scale,sampleY,locator:{...best,bottom},circle,expectedCircleDiameter:.15*Math.min(sourceWidth,sourceHeight)*scale,width,height};
  },{sourceWidth,sourceHeight,bits,barWidth});
}

(async()=>{console.log('Reports: '+report);try{
  const sourceBrowser=await chromium.launch({headless:false,args:['--window-position=80,80','--disable-background-timer-throttling','--disable-renderer-backgrounding']});browsers.add(sourceBrowser);
  source=await sourceBrowser.newPage({viewport:{width:960,height:540},deviceScaleFactor:1});
  const title='Mac Native Detail '+crypto.randomBytes(8).toString('hex');
  await source.setContent(`<title>${title}</title><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><canvas></canvas><script>
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),bits=${JSON.stringify(bits)};let id=0;window.detailBarWidth=2;
    function draw(){canvas.width=innerWidth;canvas.height=innerHeight;const w=canvas.width,h=canvas.height;id=(id+1)%65536;
      ctx.fillStyle='#183042';ctx.fillRect(0,0,w,h);
      ctx.fillStyle='#00ffff';ctx.fillRect(.1*w,.25*h,.05*w,.5*h);ctx.fillStyle='#ff00ff';ctx.fillRect(.85*w,.25*h,.05*w,.5*h);
      for(let i=0;i<16;i++){ctx.fillStyle=(id>>i)&1?'white':'black';ctx.fillRect((.2+i*.6/16)*w,.25*h,.6/16*w,.5*h);}
      ctx.fillStyle='#0000ff';ctx.beginPath();ctx.arc(.5*w,.125*h,.075*Math.min(w,h),0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#ffff00';ctx.fillRect(.2*w,.78*h,.6*w,.02*h);
      const bar=window.detailBarWidth;
      for(let i=0;i<Math.floor(.6*w/bar);i++){ctx.fillStyle=bits[i]?'white':'black';ctx.fillRect(.2*w+i*bar,.80*h,bar,.08*h);}
      requestAnimationFrame(draw);
    }draw();</script>`);
  await source.bringToFront();await sleep(1000);
  const viewerBrowser=await chromium.launch({headless:true,...(opts['receiver-executable']?{executablePath:path.resolve(opts['receiver-executable'])}:{}),args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});browsers.add(viewerBrowser);
  result.browserVersions={source:sourceBrowser.version(),receiver:viewerBrowser.version()};
  const encoders=opts.encoder?[opts.encoder]:['videotoolbox','x264'];
  for(const {encoder,cycle} of Array.from({length:cycles},(_,cycle)=>encoders.map(encoder=>({encoder,cycle:cycle+1}))).flat()){
    assert(['videotoolbox','x264'].includes(encoder));
    const caseName=cycles===1?encoder:encoder+'-cycle-'+cycle;
    await source.setViewportSize({width:960,height:540});await sleep(500);
    const entry={encoder,cycle,startedAt:Date.now(),phases:[],passed:false};result.cases.push(entry);
    const stream='macdetail'+crypto.randomBytes(12).toString('hex'),remoteToken=crypto.randomBytes(24).toString('hex');
    const room=roomMode?'macdetailroom'+crypto.randomBytes(12).toString('hex'):null;
    const discovery=path.join(report,caseName+'-control.json');
    const child=publisher(['--headless',`--window=${title}`,`--stream=${stream}`,...(room?[`--room=${room}`]:[]),'--password=false','--audio-source=none',`--video-encoder=${encoder}`,
      `--video-codec=${codec}`,'--width=320','--height=180','--fps=30','--bitrate-kbps=4000','--remote-control',`--remote-token=${remoteToken}`,
      '--local-control','--local-control-port=0',`--local-control-discovery=${discovery}`,'--duration-ms=180000'],caseName);
    await waitFor(()=>{assert.equal(child.exitCode,null,'Publisher exited');return fs.existsSync(discovery);},15000,'No local control');
    const control=JSON.parse(fs.readFileSync(discovery));let page,lqPage;
    if(room){
      const config={baseUrl:'https://vdo.ninja/',streamId:stream,room,password:'false',timeoutMs:30000};
      lqPage=await viewerBrowser.newPage({viewport:{width:1600,height:1000}});await installReceiverProbe(lqPage);
      await lqPage.goto(director.buildDirectorUrl(config),{waitUntil:'domcontentloaded',timeout:45000});
      assert((await director.waitForDirectorPeer(lqPage,config)).ok,'Director did not discover publisher');
      await dimensions(lqPage,640,360);
      await source.evaluate(()=>window.detailBarWidth=4);await sleep(1000);
      entry.smallHqLq={observation:await observeDecoded(lqPage,3000),detail:await observeDetail(lqPage,960,540,4),diagnostics:await api(control,'/diagnostics')};
      await lqPage.screenshot({path:path.join(report,caseName+'-small-hq-lq.png')});
      requireMoving(entry.smallHqLq.observation,'LQ while HQ starts small');
      assert(entry.smallHqLq.detail.agreement>=.9&&entry.smallHqLq.detail.contrast>=100,'LQ did not acquire native source detail');
      // The HQ adaptation counters remain zero with only an LQ receiver.
      // Source health records delivered capture dimensions for either tier.
      assert(entry.smallHqLq.diagnostics.source.width>500,'Small HQ limited native LQ capture');
      assert(entry.smallHqLq.diagnostics.video.lq_encoder_initialized&&entry.smallHqLq.diagnostics.video.lq_encoder.includes('x264'));
      await source.evaluate(()=>window.detailBarWidth=2);
      page=await viewerBrowser.newPage();await installReceiverProbe(page);
      await page.goto(`https://vdo.ninja/?scene=0&room=${room}&password=false&autostart&cleanoutput`,{waitUntil:'domcontentloaded',timeout:45000});
    }else page=await receiver(viewerBrowser,stream,child);
    await dimensions(page,320,180);entry.initial=await api(control,'/diagnostics');
    const initial=await observeDecoded(page,3000);requireMoving(initial,'Initial small output');entry.initialVideo=initial;
    async function change(width,height){
      for(const [keyname,value] of Object.entries({width,height})){
        const sent=await page.evaluate(({keyname,value,remoteToken,stream})=>{
          const peers=window.session?.rpcs||{};
          const peer=Object.keys(peers).find(id=>peers[id]?.streamID===stream);
          return !!peer&&window.session.sendRequest({requestVideoHack:true,keyname,value,remote:remoteToken},peer)!==false;
        },{keyname,value,remoteToken,stream});assert(sent,'Cannot send resize control to the selected publisher');
        await waitFor(async()=>(await api(control,'/diagnostics')).video['configured_'+keyname]===value,15000,'Resize control not committed');
      }
      await dimensions(page,width,height);await sleep(1000);
    }
    async function phase(name,width,height,sourceWidth,sourceHeight){
      await change(width,height);
      const observation=await observeDecoded(page,3000);requireMoving(observation,name);
      const detail=await observeDetail(page,sourceWidth,sourceHeight),diagnostics=await api(control,'/diagnostics');
      let window;
      await waitFor(async()=>{
        window=(await api(control,'/sources/windows')).sources.find(w=>w.name.includes(title));
        return window&&window.width>0&&window.height>0&&((window.width>window.height)===(sourceWidth>sourceHeight));
      },5000,'Source window geometry did not update');
      const expectedScale=Math.min(width/window.width,height/window.height);
      entry.phases.push({name,detail,observation,diagnostics,window,expectedScale});
      await page.screenshot({path:path.join(report,caseName+'-'+name+'.png')});
      await source.screenshot({path:path.join(report,caseName+'-'+name+'-source.png')});
      assert(detail.agreement>=.9,'Native fine detail missing: '+JSON.stringify(detail));
      assert(detail.contrast>=100,'Native detail contrast too low: '+JSON.stringify(detail));
      assert(detail.circle.ratio>.9&&detail.circle.ratio<1.1,'Circular fixture was stretched or cropped');
      assert(Math.abs(detail.circle.width-detail.expectedCircleDiameter)<5,'Fixture scale differs across the captured image');
      assert(Math.abs(detail.scale-expectedScale)/expectedScale<.06,'Capture contains extra padding: '+JSON.stringify({actualScale:detail.scale,expectedScale,window}));
      assert.equal(diagnostics.video.hardware_encoder,encoder==='videotoolbox');
      fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));
    }
    await phase('landscape',960,540,960,540);
    assert(entry.phases[0].diagnostics.video.last_capture_width>700,'Native capture width stayed at startup size');
    await change(320,180);requireMoving(await observeDecoded(page,2000),'Downsize remains live');
    await phase('landscape-restored',960,540,960,540);
    await source.setViewportSize({width:540,height:960});await sleep(1000);
    await phase('portrait',540,960,540,960);
    await source.setViewportSize({width:960,height:540});await sleep(1000);
    await phase('landscape-after-portrait',960,540,960,540);
    if(lqPage){await dimensions(lqPage,640,360);entry.finalLq=await observeDecoded(lqPage,3000);requireMoving(entry.finalLq,'LQ remains independent after HQ/source changes');}
    const stopStarted=Date.now();
    await api(control,'/commands',{command:'stop'});
    await waitFor(async()=>{const d=await api(control,'/diagnostics');return !d.app.live&&!d.app.capturing;},10000,'Publisher did not stop');
    entry.stopMs=Date.now()-stopStarted;
    const stopped=await api(control,'/diagnostics');await sleep(500);const settled=await api(control,'/diagnostics');
    for(const key of ['frames_captured','frames_sent']){
      assert(Number.isFinite(stopped.video[key]),'Missing video counter: '+key);
      assert.equal(settled.video[key],stopped.video[key],'Video counter advanced after stop: '+key);
    }
    assert(Number.isFinite(stopped.metrics.audio_packets_sent),'Missing audio packet counter');
    assert.equal(settled.metrics.audio_packets_sent,stopped.metrics.audio_packets_sent,'Audio counter advanced after stop');
    entry.stoppedDiagnostics=settled;
    assert(entry.stopMs<5000,'Normal stop exceeded five seconds');
    const quitStarted=Date.now();
    await api(control,'/commands',{command:'quit'});await waitFor(()=>child.exitCode!==null,10000,'Publisher did not quit');
    assert.equal(await child.closed,0);assert(!fs.existsSync(discovery));
    entry.quitMs=Date.now()-quitStarted;assert(entry.quitMs<5000,'Normal quit exceeded five seconds');
    assert(!fs.readFileSync(path.join(report,caseName+'.log'),'utf8').includes(remoteToken),'Remote token in logs');
    await page.close();if(lqPage)await lqPage.close();entry.finishedAt=Date.now();entry.passed=true;console.log(caseName+': native resize detail and lifecycle passed');
  }
  result.passed=true;
}catch(error){result.error=String(error.stack||error);console.error(result.error);process.exitCode=1;
}finally{
  for(const child of children)child.kill('SIGTERM');
  for(const browser of browsers)await browser.close().catch(()=>{});
  await Promise.all([...children].map(async child=>{await Promise.race([child.closed,sleep(3000)]);if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await child.closed;}));
  fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({report,passed:result.passed}));
}})();
