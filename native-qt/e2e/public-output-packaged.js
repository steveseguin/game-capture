/* Real packaged publisher -> public WHIP service -> Chrome and OBS playback.
 * Publishes synthetic media only, to a random stream owned by this run.
 */
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {spawn}=require('child_process'),{chromium}=require('playwright'),assert=require('assert/strict');
const opts=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf('=');return[x.slice(2,i),x.slice(i+1)];}));
const out=path.resolve(opts.output),exe=path.resolve(opts.publisher),native=path.resolve(__dirname,'..');
const id='gcqa'+crypto.randomBytes(12).toString('hex'),base=opts.base||'https://usw2.meshcast.io';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const children=[],logs=[];fs.mkdirSync(out,{recursive:true});
function launch(program,args,name,env={}){const log=fs.createWriteStream(path.join(out,name+'.log'));logs.push(log);
 const p=spawn(program,args,{windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});p.closed=new Promise(r=>p.once('close',r));children.push(p);return p;}
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(200);}throw Error('Timed out: '+label);}
async function api(file,route,body){const d=JSON.parse(fs.readFileSync(file));const r=await fetch(d.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+d.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}
// Meshcast's public CORS policy explicitly allows this official viewer origin.
const viewerUrl='https://vdo.ninja/?whepplay='+encodeURIComponent(base+'/whep/'+id)+'&autostart&cleanoutput&stereo=1';
async function main(){
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(__dirname,'quality-source.html')));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const report={started:new Date().toISOString(),publisher:exe,sha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),endpointHost:new URL(base).host,stream:id,samples:[]};
 const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
 let sourceBrowser,receiverBrowser,app,obs,page,remote;
 const discovery=path.join(out,'control.json');
 try{
  sourceBrowser=await chromium.launch({channel:'chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
  const source=await sourceBrowser.newPage({viewport:null});await source.goto('http://127.0.0.1:'+server.address().port);await source.getByRole('button').click();await source.waitForFunction(()=>quality.ready);
  app=launch(exe,['--headless','--output=whip','--output-url='+base+'/whip/'+id,'--window=Game Capture Quality Source','--resolution=1280x720','--fps=60','--audio-source=selected-window','--audio-channels=stereo','--audio-bitrate-kbps=192','--duration-ms=600000','--local-control','--local-control-discovery='+discovery], 'publisher',{LOCALAPPDATA:out,GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING:'1'});
  await until(async()=>{assert(app.exitCode===null,'Publisher exited '+app.exitCode);return fs.existsSync(discovery)&&(await api(discovery,'/diagnostics')).output?.state===2;},'public WHIP publishing',60000);
  report.initialDiagnostics=await api(discovery,'/diagnostics');save();
  receiverBrowser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});page=await receiverBrowser.newPage({viewport:{width:1280,height:720}});
  report.receiverErrors=[];page.on('pageerror',e=>report.receiverErrors.push(String(e)));page.on('requestfailed',r=>report.receiverErrors.push(r.url()+': '+r.failure()?.errorText));
  await page.addInitScript(()=>{window.qualityPeers=[];const Native=window.RTCPeerConnection;window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);window.qualityPeers.push(this);}};
    window.qualityStats=async()=>{const all=[];for(const pc of qualityPeers)for(const r of(await pc.getStats()).values())if(['inbound-rtp','candidate-pair','local-candidate','remote-candidate','codec'].includes(r.type))all.push(r);return all;};});
  await page.goto(viewerUrl);await until(async()=>page.evaluate(()=>[...document.querySelectorAll('video')].some(v=>v.currentTime>2&&v.videoWidth>0)),'public WHEP playback');
  report.chrome=receiverBrowser.version();report.before=await page.evaluate(()=>qualityStats());await page.screenshot({path:path.join(out,'chrome-receiver.png')});
  if(opts['browserstack-credentials'])remote=require('./browserstack-whip-receiver').receive(viewerUrl,path.join(out,'browserstack'),opts['browserstack-credentials']).catch(()=>({passed:false,error:'Remote setup failed; credentials are not logged'}));
  if(opts.obs)obs=await require('./quality-obs-receiver').start(opts.obs,path.join(out,'obs-recordings'),{paired:true,fps:60});
  const recording=obs?require('./quality-obs-receiver').receive(obs,{id:'public-whip',processAudio:true,obsBrowser:true,obsRenderDelayMs:Number(opts['obs-render-delay-ms']||0)},out,viewerUrl,Number(opts.seconds||75),source):null;
  await page.evaluate(()=>{const v=[...document.querySelectorAll('video')].find(v=>v.currentTime>2&&v.videoWidth>0);window.qualityChunks=[];
    window.qualityRecording=new MediaRecorder(v.srcObject,{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:8000000});qualityRecording.ondataavailable=e=>{if(e.data.size)qualityChunks.push(e.data);};qualityRecording.start(1000);});
  for(let i=0;i<Number(opts.seconds||75);i+=5){await sleep(5000);report.samples.push({wall:Date.now(),stats:await page.evaluate(()=>qualityStats()),output:(await api(discovery,'/diagnostics')).output});save();}
  if(recording)report.obs=await recording;
  if(remote){report.browserstack=await remote;assert(report.browserstack.passed,'BrowserStack playback failed');}
  const encoded=await page.evaluate(()=>new Promise(resolve=>{qualityRecording.onstop=()=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(qualityChunks));};qualityRecording.stop();}));fs.writeFileSync(path.join(out,'receiver.webm'),Buffer.from(encoded,'base64'));
  report.after=await page.evaluate(()=>qualityStats());report.finalDiagnostics=await api(discovery,'/diagnostics');
  const inbound=report.after.filter(x=>x.type==='inbound-rtp');assert(inbound.some(x=>x.kind==='audio'&&x.totalSamplesReceived>48000),'No decoded audio');assert(inbound.some(x=>x.kind==='video'&&x.framesDecoded>300),'No decoded video');
  assert.equal(report.finalDiagnostics.output.reconnects,0,'Public healthy stream reconnected');
  report.passed=true;
 }catch(e){report.error=String(e);
  if(page)report.receiverFailure=await page.evaluate(()=>({peers:qualityPeers.map(pc=>({connection:pc.connectionState,ice:pc.iceConnectionState})),
    videos:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,width:v.videoWidth,paused:v.paused}))})).catch(error=>({error:String(error)}));
  throw e;}
 finally{
  if(remote)report.browserstack=await remote;
  if(page)await page.evaluate(()=>{for(const pc of qualityPeers)pc.close();}).catch(()=>{});
  if(obs)await require('./quality-obs-receiver').stop(obs);
  if(app&&app.exitCode===null){const t=Date.now();await api(discovery,'/commands',{command:'quit'}).catch(()=>{});await Promise.race([app.closed,sleep(6000)]);report.shutdown={forced:app.exitCode===null,exitCode:app.exitCode,elapsedMs:Date.now()-t};}
  if(receiverBrowser)await receiverBrowser.close();if(sourceBrowser)await sourceBrowser.close();
  for(const p of children)if(p.exitCode===null)p.kill();await Promise.all(children.map(p=>p.closed));for(const log of logs)log.end();server.closeAllConnections();server.close();save();
 }
 assert(!report.shutdown.forced&&report.shutdown.exitCode===0,'Publisher shutdown failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
