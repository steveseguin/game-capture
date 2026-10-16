'use strict';
// Observe an already-running packaged publisher; no encoder settings are changed.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require('playwright');
const obsHelper=require('./quality-obs-receiver');
const opts=Object.fromEntries(process.argv.slice(2).map(s=>{const i=s.indexOf('=');return [s.slice(2,i),s.slice(i+1)];}));
const out=path.resolve(opts.report);fs.mkdirSync(out,{recursive:true});
const control=JSON.parse(fs.readFileSync(opts.discovery,'utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const result={codec:opts.codec,receiver:opts.obs?'OBS native':'Edge',samples:[]};
async function api(route,body){const r=await fetch(control.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});assert(r.ok);return r.json();}
async function stats(page){return page.evaluate(async()=>{const rows=[];for(const pc of window.qaPeers)for(const r of (await pc.getStats()).values())if(r.type==='inbound-rtp')rows.push({...r,codec:(await pc.getStats()).get(r.codecId)?.mimeType});return rows;});}
async function ready(page){const end=Date.now()+45000;while(Date.now()<end){if((await stats(page)).some(r=>r.kind==='video'&&r.framesDecoded>15&&r.framesPerSecond>0))return;await sleep(300);}throw Error('No advancing received video');}
function encoder(d){const expected={h264:'h264_amf',h265:'hevc_amf',av1:'av1_amf',vp9:'libvpx-vp9'}[opts.codec];assert(d.app.live);assert(d.video.active_encoder.includes(expected),d.video.active_encoder);assert.equal(d.video.active_codec.toLowerCase().replace(/[.]/g,''),opts.codec);}
let browser,obs;
(async()=>{
  try{
    encoder(result.before=await api('/diagnostics'));
    if(opts.obs){
      obs=await obsHelper.start(opts.obs,path.join(out,'obs'),{fps:30});
      const c=obs.client,scene='AMD-'+Date.now(),input=scene+'-receiver';
      await c.request('CreateScene',{sceneName:scene});await c.request('SetCurrentProgramScene',{sceneName:scene});
      await c.request('CreateInput',{sceneName:scene,inputName:input,inputKind:'vdoninja_source',inputSettings:{stream_id:opts.stream,password:'false',room_id:'',use_native_receiver:true,enable_data_channel:true,auto_reconnect:true,width:1280,height:720},sceneItemEnabled:true});
      try{
        await c.request('SetInputAudioMonitorType',{inputName:input,monitorType:'OBS_MONITORING_TYPE_NONE'});
        await c.request('SetSceneItemTransform',{sceneName:scene,sceneItemId:(await c.request('GetSceneItemId',{sceneName:scene,sourceName:input})).sceneItemId,sceneItemTransform:{boundsType:'OBS_BOUNDS_STRETCH',boundsWidth:1280,boundsHeight:720}});
        await sleep(12000);encoder(await api('/diagnostics'));
        await c.request('StartRecord');await sleep(25000);
        result.recording=(await c.request('StopRecord')).outputPath;
        const end=Date.now()+30000;while((await c.request('GetRecordStatus')).outputActive){assert(Date.now()<end);await sleep(100);}
        await c.request('SaveSourceScreenshot',{sourceName:scene,imageFormat:'png',imageFilePath:path.join(out,'received.png'),imageWidth:1280,imageHeight:720});
        result.obsStats=await c.request('GetStats');
      }finally{await c.request('RemoveInput',{inputName:input}).catch(()=>{});await c.request('RemoveScene',{sceneName:scene}).catch(()=>{});}
    }else{
      browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
      const context=await browser.newContext({viewport:{width:1280,height:800}});
      await context.addInitScript(()=>{window.qaPeers=[];const Original=RTCPeerConnection;window.RTCPeerConnection=new Proxy(Original,{construct(target,args){const pc=new target(...args);window.qaPeers.push(pc);return pc;}});});
      const page=await context.newPage();await page.goto('https://vdo.ninja/?view='+opts.stream+'&password=false&autostart&cleanoutput',{waitUntil:'domcontentloaded'});
      for(const phase of ['steady','viewer-reload','transport-restart']){
        if(phase==='viewer-reload')await page.reload({waitUntil:'domcontentloaded'});
        if(phase==='transport-restart')await api('/commands',{command:'refresh_peer_transports'});
        await ready(page);await sleep(2000);const before=await stats(page);await sleep(12000);const after=await stats(page);
        const metrics=after.map(b=>{const a=before.find(v=>v.id===b.id);if(!a)return {changed:true};const seconds=(b.timestamp-a.timestamp)/1000;return {kind:b.kind,codec:b.codec,fps:(b.framesDecoded-a.framesDecoded)/seconds,kbps:(b.bytesReceived-a.bytesReceived)*8/seconds/1000,freezes:(b.freezeCount||0)-(a.freezeCount||0),dropped:(b.framesDropped||0)-(a.framesDropped||0),rms:Math.sqrt(((b.totalAudioEnergy||0)-(a.totalAudioEnergy||0))/Math.max(.001,(b.totalSamplesDuration||0)-(a.totalSamplesDuration||0)))};});
        const video=metrics.find(r=>r.kind==='video'),audio=metrics.find(r=>r.kind==='audio');
        assert(video&&video.codec.toLowerCase()==='video/'+opts.codec&&video.fps>=28.5,JSON.stringify(metrics));assert(audio&&audio.rms>.001,JSON.stringify(metrics));
        result.samples.push({phase,metrics});encoder(await api('/diagnostics'));
      }
      result.motion=await page.evaluate(async()=>{const v=[...document.querySelectorAll('video')].find(v=>v.videoWidth);const c=document.createElement('canvas');c.width=160;c.height=90;const ctx=c.getContext('2d',{willReadFrequently:true});const hashes=[];for(let n=0;n<6;n++){ctx.drawImage(v,0,0,160,90);hashes.push(c.toDataURL());await new Promise(r=>setTimeout(r,300));}return new Set(hashes).size;});assert(result.motion>=5);
      await page.screenshot({path:path.join(out,'received.png')});
    }
    encoder(result.after=await api('/diagnostics'));result.passed=true;
  }catch(e){result.error=String(e);process.exitCode=1;}
  finally{if(browser)await browser.close();if(obs)try{await obsHelper.stop(obs);}catch(e){result.shutdownError=String(e);result.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(out,'receiver.json'),JSON.stringify(result,null,2));}
  console.log(JSON.stringify({codec:opts.codec,passed:result.passed,error:result.error,recording:result.recording}));
})();
