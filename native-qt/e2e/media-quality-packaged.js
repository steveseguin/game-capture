/* Real packaged publisher -> VDO.Ninja -> browser quality capture.
 * Stores decoded stereo float PCM, timestamped video barcodes, RTP counters,
 * source clock calibration, screenshots, process memory and sound API events.
 * Nothing in this harness replaces the app's capture, encoding or transport.
 */
const fs=require('fs'), path=require('path'), http=require('http'), crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');
const {chromium,firefox}=require('playwright');
const assert=require('assert/strict');
const opts=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf('=');return[x.slice(2,i),x.slice(i+1)];}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(200);}throw Error('Timed out: '+label);}
const output=path.resolve(opts.output), native=path.resolve(__dirname,'..');
fs.mkdirSync(output,{recursive:true});
const children=[], logs=[];
function launch(exe,args,name,env={}){
  const log=fs.createWriteStream(path.join(output,name+'.log'));logs.push(log);
  const child=spawn(exe,args,{windowsHide:true,cwd:path.dirname(path.resolve(exe)),env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>child.once('close',resolve));children.push(child);return child;
}
async function api(discovery,route,body){const info=JSON.parse(fs.readFileSync(discovery));const r=await fetch(info.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}

async function receiver(browser,c,dir,url,seconds,source){
  const page=await browser.newPage({viewport:{width:1280,height:720}}), result={case:c,phases:[]};
  const consoleLog=[];page.on('console',m=>consoleLog.push({type:m.type(),text:m.text()}));page.on('pageerror',e=>consoleLog.push({type:'pageerror',text:String(e)}));
  const pcm=fs.createWriteStream(path.join(dir,'decoded.f32')), chunks=[], frames=[];
  let cdp;
  await page.exposeFunction('qualityAudio',payload=>{
    pcm.write(Buffer.from(payload.data,'base64'));chunks.push({wall:payload.wall,contextTime:payload.contextTime,frames:payload.frames,peak:payload.peak});
  });
  await page.exposeFunction('qualityFrame',frame=>frames.push(frame));
  await page.addInitScript(()=>{window.qualityPeers=[];window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(target,args){const pc=new target(...args);window.qualityPeers.push(pc);return pc;}});});
  try{
    if(c.loss && !c.firefox){cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditionsByRule',{offline:false,matchedNetworkConditions:[{urlPattern:'',latency:0,downloadThroughput:-1,uploadThroughput:-1,packetLoss:0}]});}
    const viewer=new URL(url);viewer.searchParams.set('autostart','');viewer.searchParams.set('muted','');
    if(opts['pcm-fallback']==='true')viewer.searchParams.delete('audiocodec');
    await page.goto(viewer.href,{waitUntil:'domcontentloaded',timeout:40000});
    await page.waitForFunction(()=>window.qualityPeers.some(pc=>pc.connectionState==='connected'&&pc.getReceivers().some(r=>r.track?.kind==='audio')),null,{timeout:45000});
    await page.evaluate(async()=>{
      const pc=window.qualityPeers.find(pc=>pc.connectionState==='connected'&&pc.getReceivers().some(r=>r.track?.kind==='audio'));
      window.qualityPc=pc;
      const stream=new MediaStream(pc.getReceivers().map(r=>r.track));
      const video=document.createElement('video');video.srcObject=stream;video.muted=true;video.autoplay=true;
      video.style='position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:black;z-index:999999';document.body.appendChild(video);await video.play();
      window.qualityVideo=video;
      const canvas=document.createElement('canvas'),g=canvas.getContext('2d',{willReadFrequently:true});let geometry;
      const frame=(now,meta)=>{
        canvas.width=video.videoWidth;canvas.height=video.videoHeight;
        g.drawImage(video,0,0);const w=canvas.width,h=canvas.height;
        function rgb(x,y){return [...g.getImageData(Math.floor(x*w),Math.floor(y*h),1,1).data].slice(0,3);}
        // Locate both sentinels in actual captured pixels. Chrome can leave
        // fullscreen when another application starts; window borders and the
        // publisher's aspect-ratio padding must not invalidate measurements.
        if(!geometry){
          const pixels=g.getImageData(0,0,w,h).data;
          const color=(x,y,magenta)=>{const i=(y*w+x)*4;return magenta?pixels[i]>150&&pixels[i+1]<80&&pixels[i+2]>150:pixels[i]<80&&pixels[i+1]>150&&pixels[i+2]>150;};
          for(let y=4;y<h/2&&!geometry;y+=4){
            const cyan=[],magenta=[];for(let x=1;x<w-1;x++){
              if(color(x,y,false))cyan.push(x);if(color(x,y,true))magenta.push(x);
            }
            if(cyan.length>8&&magenta.length>8&&magenta[0]>cyan[cyan.length-1]+w*.3){
              const cx=(cyan[0]+cyan[cyan.length-1])/2,mx=(magenta[0]+magenta[magenta.length-1])/2;
              let top=y,bottom=y;while(top>0&&color(Math.round(cx),top-1,false))top--;while(bottom<h-1&&color(Math.round(cx),bottom+1,false))bottom++;
              const width=(mx-cx)/.9,height=(bottom-top+1)/.1;
              geometry={x:cx-width*.05,y:top-height*.1,width,height,barcodeY:(top+bottom)/2};
            }
          }
        }
        const at=(x,y)=>geometry?rgb((geometry.x+x*geometry.width)/w,(geometry.y+y*geometry.height)/h):[0,0,0];
        const left=at(.05,.15),right=at(.95,.15);
        const valid=left[0]<80&&left[1]>150&&left[2]>150&&right[0]>150&&right[1]<80&&right[2]>150;
        let sourceMs=0;if(valid)for(let i=0;i<32;i++)if(at((i+4.5)/40,.15)[0]>128)sourceMs+=2**i;
        window.qualityFrame({wall:performance.timeOrigin+meta.expectedDisplayTime,sourceMs,valid,pulse:at(.5,.37)[0]>128,geometry,
          presentedFrames:meta.presentedFrames,mediaTime:meta.mediaTime,width:w,height:h,processingDuration:meta.processingDuration});
        window.qualityFrameCallback=video.requestVideoFrameCallback(frame);
      };window.qualityFrameCallback=video.requestVideoFrameCallback(frame);
      const ctx=new AudioContext({sampleRate:48000});await ctx.resume();window.qualityAudioContext=ctx;
      const code=`class Capture extends AudioWorkletProcessor {
        constructor(){super();this.data=new Float32Array(4096);this.used=0;this.start=0;}
        process(inputs){const a=inputs[0];if(!a||!a.length)return true;
          if(!this.used)this.start=currentTime;
          for(let i=0;i<a[0].length;i++){this.data[this.used++]=a[0][i];this.data[this.used++]=(a[1]||a[0])[i];
            if(this.used===4096){this.port.postMessage({data:this.data,time:this.start},[this.data.buffer]);this.data=new Float32Array(4096);this.used=0;this.start=currentTime+(i+1)/sampleRate;}}
          return true;
        }}registerProcessor('quality-capture',Capture);`;
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code],{type:'application/javascript'})));
      // This path measures decoded audio independently of the HTML video's
      // A/V synchronizer. Actual combined-output sync is measured separately
      // from OBS recordings; do not claim these clocks prove browser lip sync.
      const src=ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const worklet=new AudioWorkletNode(ctx,'quality-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
      worklet.port.onmessage=e=>{const stamp=ctx.getOutputTimestamp();const bytes=new Uint8Array(e.data.data.buffer);
        let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
        let peak=0;for(const value of e.data.data)peak=Math.max(peak,Math.abs(value));
        window.qualityAudio({data:btoa(binary),contextTime:e.data.time,frames:e.data.data.length/2,peak,
          wall:performance.timeOrigin+stamp.performanceTime+(e.data.time-stamp.contextTime)*1000});};
      src.connect(worklet);worklet.connect(ctx.destination);
    });
    const stats=()=>page.evaluate(async()=>({wall:Date.now(),sdp:window.qualityPc.localDescription.sdp,stats:[...(await window.qualityPc.getStats()).values()]}));
    result.start=await stats();
    const takePhase=async(name,duration,loss=0,latency=0)=>{
      if(cdp)await cdp.send('Network.emulateNetworkConditionsByRule',{offline:false,matchedNetworkConditions:[{urlPattern:'',latency,downloadThroughput:-1,uploadThroughput:-1,packetLoss:loss}]});
      const phase={name,loss,latency,started:Date.now(),before:await stats()};
      console.log(c.id,name,duration+'s');
      for(let elapsed=0;elapsed<duration;elapsed+=5){await sleep(Math.min(5,duration-elapsed)*1000);result.last=await stats();}
      phase.after=await stats();phase.ended=Date.now();result.phases.push(phase);
      await page.screenshot({path:path.join(dir,name+'.png')});
    };
    await takePhase('clean',seconds);
    if(c.loss){await takePhase('loss-10',25,10);await takePhase('loss-30-delay-100',20,30,100);await takePhase('outage',4,100);await takePhase('recovered',25);}
    result.finish=await stats();
    result.source=await source.evaluate(()=>({epoch:quality.epoch,calibrations:quality.calibrations,screen:[innerWidth,innerHeight]}));
    assert(frames.filter(f=>f.valid).length>seconds*10,'Too few valid decoded video frames');
    assert(chunks.length>seconds*10,'Missing decoded audio');
    assert(chunks.some(c=>c.peak>.0001),'Saved audio samples are silent');
    result.ok=true;
  }catch(e){result.error=String(e);result.peers=await page.evaluate(async()=>Promise.all((window.qualityPeers||[]).map(async p=>({state:p.connectionState,ice:p.iceConnectionState,local:p.localDescription?.sdp,remote:p.remoteDescription?.sdp,stats:[...(await p.getStats()).values()]})))).catch(()=>null);await page.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});throw e;}
  finally{
    await page.close();await new Promise(resolve=>pcm.end(resolve));
    fs.writeFileSync(path.join(dir,'audio-chunks.json'),JSON.stringify(chunks));
    fs.writeFileSync(path.join(dir,'video-frames.json'),JSON.stringify(frames));
    fs.writeFileSync(path.join(dir,'receiver.json'),JSON.stringify(result,null,2));
    fs.writeFileSync(path.join(dir,'browser-console.json'),JSON.stringify(consoleLog,null,2));
  }
  return result;
}
async function main(){
  const existing=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-Process -Name game-capture -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id\nexit 0"],{encoding:'utf8',windowsHide:true});
  assert(!existing.trim(),'Another Game Capture session is running; serialize quality measurements');
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(__dirname,'quality-source.html')));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const fixtureBrowser=await chromium.launch({channel:'chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
  const source=await fixtureBrowser.newPage({viewport:null});
  const all=[{id:'source-calibration',direct:true},{id:'baseline-opus',baseline:true},{id:'baseline-firefox',baseline:true,firefox:true},{id:'review-opus'},{id:'review-red',red:true},{id:'review-pcm-stereo',pcm:true},{id:'review-pcm-mono',pcm:true,mono:true},{id:'review-firefox',firefox:true},{id:'review-red-firefox',firefox:true,red:true},{id:'review-pcm-firefox',firefox:true,pcm:true}];
  const selected=all.filter(c=>(opts.cases||'review-opus').split(',').includes(c.id));
  const results={started:new Date().toISOString(),cases:[],shutdown:[]};let obs;
  try{
    await source.goto('http://127.0.0.1:'+server.address().port);await source.getByRole('button').click();
    await source.waitForFunction(()=>quality.ready);await source.screenshot({path:path.join(output,'source.png')});
    if(opts.obs)obs=await require('./quality-obs-receiver').start(opts.obs,path.join(output,'obs-recordings'));
    for(const c of selected){
      c.loss=opts.loss==='true';const dir=path.join(output,c.id);fs.mkdirSync(dir,{recursive:true});
      const exe=path.resolve(c.baseline?opts.baseline:opts.publisher),discovery=path.join(dir,'control.json');
      c.publisher=exe;c.sha256=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
      const stream='quality'+crypto.randomBytes(8).toString('hex');
      const args=['--headless','--stream='+stream,'--password=false','--source=window','--window=Game Capture Quality Source',
        '--resolution='+(opts.resolution||'1280x720'),'--fps='+(opts.fps||'30'),'--audio-source=default-output','--duration-ms=1800000','--local-control','--local-control-discovery='+discovery];
      if(opts['video-encoder'])args.push('--video-encoder='+opts['video-encoder']);
      if(opts['video-codec'])args.push('--video-codec='+opts['video-codec']);
      if(!c.baseline)args.push('--audio-codec='+(c.pcm?'pcm':'opus'),'--audio-channels='+(c.mono?'1':'2'),'--audio-bitrate-kbps=192',...(c.red?['--audio-red']:[]));
      const app=launch(exe,args,c.id+'-publisher',{LOCALAPPDATA:dir,GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING:'1'});
      let browser,monitor;
      try{
        await until(async()=>{assert(app.exitCode===null,'Publisher exited');return fs.existsSync(discovery)&&(await api(discovery,'/diagnostics')).app.live;},'live publisher');
        monitor=launch(path.join(native,'.cache/desktop-ui-python/Scripts/python.exe'),[path.join(__dirname,'quality-resource-monitor.py'),'--pid',String(app.pid),'--output',path.join(dir,'resources.jsonl')],c.id+'-monitor');
        const log=fs.readFileSync(path.join(output,c.id+'-publisher.log'),'utf8');const url=log.match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1];assert(url,'No viewer URL');
        if(obs){c.obsBrowser=opts['obs-browser']==='true';results.cases.push(await require('./quality-obs-receiver').receive(obs,c,dir,url,Number(opts.seconds||60),source));}
        else{
          browser=await(c.firefox?firefox:chromium).launch(c.firefox?{headless:true,firefoxUserPrefs:{'media.autoplay.default':0,'media.autoplay.blocking_policy':0,'media.peerconnection.ice.obfuscate_host_addresses':false}}:{channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
          c.browserVersion=browser.version();
          for(let round=0;round<Number(opts.rounds||1);round++){
            const roundDir=Number(opts.rounds||1)>1?path.join(dir,'round-'+String(round+1).padStart(2,'0')):dir;
            fs.mkdirSync(roundDir,{recursive:true});
            results.cases.push(await receiver(browser,{...c,round:round+1},roundDir,url,Number(opts.seconds||60),source));
            if(Number(opts.rounds||1)>1){
              fs.writeFileSync(path.join(roundDir,'diagnostics.json'),JSON.stringify(await api(discovery,'/diagnostics'),null,2));
              await sleep(Number(opts.settle||5)*1000);
              console.log(c.id,'viewer disconnected after round',round+1);
            }
          }
          if(Number(opts.rounds||1)>1){
            const idle=[];console.log(c.id,'waiting 110s for disconnected peer retirement');
            for(let elapsed=0;elapsed<110;elapsed+=5){
              idle.push({wall:Date.now(),diagnostics:await api(discovery,'/diagnostics')});
              await sleep(5000);
            }
            fs.writeFileSync(path.join(dir,'idle-after-churn.json'),JSON.stringify(idle,null,2));
          }
        }
        fs.writeFileSync(path.join(dir,'diagnostics.json'),JSON.stringify(await api(discovery,'/diagnostics'),null,2));
      }catch(e){console.error(c.id,e);results.cases.push({case:c,error:String(e)});}
      finally{
        if(browser)await browser.close();
        const quitStarted=Date.now();
        if(app.exitCode===null)await api(discovery,'/commands',{command:'quit'}).catch(()=>{});
        await Promise.race([app.closed,sleep(10000)]);const forced=app.exitCode===null;
        if(forced){app.kill();await app.closed;}
        results.shutdown.push({case:c.id,pid:app.pid,forced,exitCode:app.exitCode,elapsedMs:Date.now()-quitStarted});
        if(monitor)await Promise.race([monitor.closed,sleep(5000)]);
        fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
      }
    }
  }finally{
    if(obs)await require('./quality-obs-receiver').stop(obs);
    await fixtureBrowser.close();server.close();
    for(const child of children)if(child.exitCode===null)child.kill();
    await Promise.all(children.map(c=>c.closed));for(const log of logs)log.end();
  }
  if(results.cases.some(c=>!c.ok)||results.shutdown.some(s=>s.forced||s.exitCode!==0))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
