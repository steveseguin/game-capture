'use strict';
// Measurement control: the identical clocked source crosses a local browser
// H264/Opus peer connection without Game Capture. This is not app testing.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http'),assert=require('assert/strict');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright');
const {waitFor,sleep}=require('./macos-media-receiver'),recorder=require('./macos-continuous-audio');
const opts=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
assert(process.env.GC_QA_PRIVATE_DESKTOP);for(const k of ['source-fixture','reports','analysis-python'])assert(opts[k],k);
const seconds=Number(opts.seconds||30),hold=Number(opts['hold-seconds']||0);assert(Number.isInteger(seconds)&&seconds>=30&&seconds<=120&&Number.isInteger(hold)&&hold>=0&&hold<=7200);
execFileSync(opts['analysis-python'],['-c','import numpy'],{timeout:10000});
const report=path.resolve(opts.reports,crypto.randomUUID());fs.mkdirSync(report,{recursive:true,mode:0o700});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for(const name of ['linux-av-reference.js','macos-continuous-audio.js','macos-media-receiver.js','macos-analyze-av-sync.py'])fs.copyFileSync(path.join(__dirname,name),path.join(report,name));
fs.copyFileSync(opts['source-fixture'],path.join(report,'source.html'));
const result={scope:'Measurement control only: identical generated source, local Chrome H264/Opus peer connection and paired recordings; Game Capture is not running. No application or physical timing qualification.',seconds,holdSeconds:hold,sourceFixtureSha256:sha(opts['source-fixture']),harnessSha256:sha(__filename),phases:[],passed:false};
const save=()=>fs.writeFileSync(path.join(report,'results.json'),JSON.stringify(result,null,2)+'\n');
const pactl=(...a)=>execFileSync('pactl',a,{encoding:'utf8',timeout:5000}).trim();
const browsers=[],recordings=new Set();let server,moduleId;
const defaultSink=pactl('get-default-sink');
(async()=>{
  console.log('Reports: '+report);save();
  try{
    const sink='gc_av_reference_'+crypto.randomBytes(8).toString('hex');moduleId=pactl('load-module','module-null-sink','sink_name='+sink,'rate=48000','channels=2');
    server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(req.url==='/source'?fs.readFileSync(path.join(report,'source.html')):'<video autoplay muted style="width:1280px;height:720px"></video>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port,browser=opts.browser||'/usr/bin/google-chrome';
    const sourceBrowser=await chromium.launch({executablePath:browser,headless:false,env:{...process.env,PULSE_SINK:sink},args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding','--window-size=1400,900']});browsers.push(sourceBrowser);
    const source=await sourceBrowser.newPage({viewport:{width:1280,height:720}});await source.goto(url+'/source');await source.bringToFront();await waitFor(()=>source.evaluate(()=>window.fixture?.frames>60),10000,'Source not ready');
    const viewerBrowser=await chromium.launch({executablePath:browser,headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});browsers.push(viewerBrowser);result.browserVersion=viewerBrowser.version();
    const viewer=await viewerBrowser.newPage();await viewer.goto(url+'/receiver');
    const offer=await source.evaluate(async()=>{
      const pc=window.referenceSender=new RTCPeerConnection();
      for(const track of fixtureReference.getTracks()){
        const transceiver=pc.addTransceiver(track,{direction:'sendonly',streams:[fixtureReference]});
        const codecs=RTCRtpSender.getCapabilities(track.kind).codecs.filter(c=>c.mimeType.toLowerCase()===(track.kind==='video'?'video/h264':'audio/opus'));
        if(!codecs.length)throw Error('Missing reference H264/Opus codec');transceiver.setCodecPreferences(codecs);
      }
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve,reject)=>{if(pc.iceGatheringState==='complete')return resolve();const timer=setTimeout(()=>reject(Error('Source ICE gathering timeout')),10000);pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};});return pc.localDescription.toJSON();
    });
    const answer=await viewer.evaluate(async offer=>{
      const pc=new RTCPeerConnection();window.reviewPCs=[pc];pc.ontrack=e=>{document.querySelector('video').srcObject=e.streams[0];};await pc.setRemoteDescription(offer);await pc.setLocalDescription(await pc.createAnswer());
      await new Promise((resolve,reject)=>{if(pc.iceGatheringState==='complete')return resolve();const timer=setTimeout(()=>reject(Error('Receiver ICE gathering timeout')),10000);pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};});return pc.localDescription.toJSON();
    },offer);await source.evaluate(answer=>referenceSender.setRemoteDescription(answer),answer);
    await waitFor(()=>viewer.evaluate(async()=>{for(const v of(await reviewPCs[0].getStats()).values())if(v.type==='inbound-rtp'&&v.kind==='video'&&v.framesDecoded>15)return true;return false;}),15000,'Reference receiver not decoding');await sleep(3000);
    async function phase(name){
      const entry={name,started:Date.now()};result.phases.push(entry);const pair=[];
      for(const [kind,page,settings] of [['source',source,{includeVideo:true,sourceStreamKey:'fixtureReference'}],['receiver',viewer,{includeVideo:true}]]){const r=await recorder.record(page,path.join(report,name+'-'+kind+'.webm'),settings);entry[kind]=r.metadata;recordings.add(r);pair.push(r);}
      save();await sleep(seconds*1000);
      for(const r of pair){await r.stop();recordings.delete(r);}entry.ended=Date.now();
      entry.inbound=await viewer.evaluate(async()=>{const stats=await reviewPCs[0].getStats();return[...stats.values()].filter(v=>v.type==='inbound-rtp').map(v=>({...v,codec:stats.get(v.codecId)?.mimeType}));});
      assert(entry.inbound.some(v=>v.codec?.toLowerCase()==='video/h264'));assert(entry.inbound.some(v=>v.codec?.toLowerCase()==='audio/opus'));save();
    }
    await phase('initial');if(hold){await sleep(hold*1000);await phase('final');}
    const log=fs.openSync(path.join(report,'analysis.log'),'w');const child=spawn(opts['analysis-python'],[path.join(report,'macos-analyze-av-sync.py'),report,'--ffmpeg','/usr/bin/ffmpeg'],{stdio:['ignore',log,log]});result.analysisExitCode=await new Promise(resolve=>child.once('close',resolve));fs.closeSync(log);
    result.analysis=JSON.parse(fs.readFileSync(path.join(report,'av-analysis.json')));result.passed=result.analysisExitCode===0&&result.analysis.passed;
  }catch(error){result.error=String(error.stack||error);}
  finally{
    const errors=[];for(const r of recordings)try{await r.stop();}catch(e){errors.push(String(e));}
    for(const browser of browsers.reverse())try{await browser.close();}catch(e){errors.push(String(e));}
    if(server)await new Promise(resolve=>server.close(resolve));
    try{if(moduleId)pactl('unload-module',moduleId);assert.equal(pactl('get-default-sink'),defaultSink);assert(!JSON.parse(pactl('--format=json','list','modules')).some(m=>String(m.index)===moduleId));result.cleanupPassed=true;}catch(e){errors.push(String(e));}
    if(errors.length){result.cleanupErrors=errors;result.passed=false;}save();process.exitCode=result.passed?0:1;console.log(JSON.stringify({report,passed:result.passed,error:result.error}));
  }
})();
