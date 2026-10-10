/* Packaged application -> real Chrome capture -> MediaMTX -> decoded recording.
 * Each process is owned by this run. Output decoding/quality analysis is separate.
 */
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');
const {chromium}=require('playwright');
const assert=require('assert/strict');
const opts=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf('=');return[x.slice(2,i),x.slice(i+1)];}));
const native=path.resolve(__dirname,'..'),out=path.resolve(opts.output),exe=path.resolve(opts.publisher);
const ffmpeg=path.join(path.dirname(exe),'ffmpeg','bin','ffmpeg.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const children=[],logs=[];
fs.mkdirSync(out,{recursive:true});
function launch(program,args,name,env={}){
  const log=fs.createWriteStream(path.join(out,name+'.log'));logs.push(log);
  const child=spawn(program,args,{windowsHide:true,cwd:path.dirname(path.resolve(program)),env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.closed=new Promise(resolve=>{child.once('close',resolve);child.once('error',e=>{console.error(e);resolve(-1);});});children.push(child);return child;
}
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(200);}throw Error('Timed out: '+label);}
async function api(discovery,route,body){const d=JSON.parse(fs.readFileSync(discovery));const r=await fetch(d.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+d.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();}
async function main(){
  const running=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-Process -Name game-capture -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id\nexit 0"],{encoding:'utf8',windowsHide:true});
  assert(!running.trim(),'Serialize capture quality runs');
  const config=path.join(out,'mediamtx.yml');
  fs.writeFileSync(config,`logLevel: info
api: true
apiAddress: 127.0.0.1:18990
rtspAddress: 127.0.0.1:18854
rtspTransports: [tcp]
rtmpAddress: 127.0.0.1:19350
webrtcAddress: 127.0.0.1:18889
webrtcLocalUDPAddress: 127.0.0.1:18189
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: [127.0.0.1]
srtAddress: 127.0.0.1:18890
hls: false
moq: false
paths:
  '~^srt-encrypted':
    srtPublishPassphrase: 'qa:+%2B?&= pass2026'
  all_others:
`);
  let server=launch(path.join(native,'.cache/mediamtx-1.21.2/mediamtx.exe'),[config],'server');
  const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(__dirname,'quality-source.html')));});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  let sourceBrowser,receiverBrowser,obs;
  const results={started:new Date().toISOString(),publisher:exe,sha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),cases:[]};
  try{
    await until(async()=>fetch('http://127.0.0.1:18990/v3/paths/list').then(r=>r.ok).catch(()=>false),'server');
    sourceBrowser=await chromium.launch({channel:'chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
    const source=await sourceBrowser.newPage({viewport:null});
    await source.goto('http://127.0.0.1:'+fixture.address().port);await source.getByRole('button').click();await source.waitForFunction(()=>quality.ready);
    await source.screenshot({path:path.join(out,'source.png')});
    if(opts.obs)obs=await require('./quality-obs-receiver').start(opts.obs,path.join(out,'obs-recordings'),{paired:true,fps:60});
    for(const id of (opts.cases||'rtmp-stereo,srt-stereo,whip-stereo').split(',')){
      const protocol=id.split('-')[0],mono=id.includes('mono'),silent=id.includes('silent'),dir=path.join(out,id);
      fs.mkdirSync(dir,{recursive:true});const discovery=path.join(dir,'control.json');
      const bitrate=Number(id.match(/-(\d+)$/)?.[1]||192);
      const result={id,protocol,channels:mono?1:2,silent,bitrateKbps:bitrate,phases:[]};results.cases.push(result);
      const url=protocol==='whip'?'http://127.0.0.1:18889/'+id+'/whip':protocol==='srt'?
        'srt://127.0.0.1:18890'+(id==='srt-encrypted-url'?'?passphrase='+encodeURIComponent('qa:+%2B?&= pass2026'):''):'rtmp://127.0.0.1:19350/live';
      const stream=protocol==='rtmp'?'live/'+id:id;
      const args=['--headless','--output='+protocol,'--output-url='+url,'--source=window','--window=Game Capture Quality Source',
        '--resolution=1280x720','--fps=60','--audio-source='+(silent?'none':'selected-window'),'--audio-channels='+(mono?1:2),
        '--duration-ms=1800000','--local-control','--local-control-discovery='+discovery];
      args.push((protocol==='whip'?'--audio-bitrate-kbps=':'--aac-bitrate-kbps=')+bitrate);
      if(protocol==='rtmp')args.push('--output-key='+id);
      if(protocol==='srt')args.push('--srt-stream-id=publish:'+id);
      if(id.startsWith('srt-encrypted')&&id!=='srt-encrypted-url')args.push('--srt-passphrase=qa:+%2B?&= pass2026');
      const app=launch(exe,args,id+'-publisher',{LOCALAPPDATA:dir,GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING:'1'});
      let monitor,page,record;
      try{
        await until(async()=>{assert(app.exitCode===null,'Publisher exited with '+app.exitCode);if(!fs.existsSync(discovery))return false;const d=await api(discovery,'/diagnostics');result.lastDiagnostics=d;return d.output?.state===2;},id+' publishing',60000);
        monitor=launch(path.join(native,'.cache/desktop-ui-python/Scripts/python.exe'),[path.join(__dirname,'quality-resource-monitor.py'),'--pid',String(app.pid),'--output',path.join(dir,'resources.jsonl')],id+'-monitor');
        await until(async()=>{const paths=await fetch('http://127.0.0.1:18990/v3/paths/list').then(r=>r.json());
          result.serverPath=paths.items.find(p=>p.name===stream);return result.serverPath?.ready;},'server track discovery');
        if(protocol==='whip'){
          receiverBrowser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
          page=await receiverBrowser.newPage({viewport:{width:1280,height:720}});
          await page.addInitScript(()=>{window.qualityPeers=[];const Native=window.RTCPeerConnection;window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);window.qualityPeers.push(this);}};});
          await page.goto('http://127.0.0.1:18889/'+stream+'/');
          await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.videoWidth>0&&v.currentTime>1;},{},{timeout:30000});
          result.browser=receiverBrowser.version();
          await page.screenshot({path:path.join(dir,'chrome-receiver.png')});
        }
        const phases=id.includes('reconnect')?['initial','reconnected']:['steady'];
        if(obs){
          const obsBrowser=protocol==='whip'&&opts['obs-browser']!=='false';
          result.obs=await require('./quality-obs-receiver').receive(obs,{id,external:true,processAudio:true,obsBrowser},dir,
            obsBrowser?'http://127.0.0.1:18889/'+stream+'/':'rtsp://127.0.0.1:18854/'+stream,Number(opts.seconds||75),source);
        }
        if(!obs)
        for(const phase of phases){
          if(phase==='reconnected'){
            server.kill();await server.closed;await sleep(3000);
            server=launch(path.join(native,'.cache/mediamtx-1.21.2/mediamtx.exe'),[config],id+'-server-restarted');
            await until(async()=>{const d=await api(discovery,'/diagnostics');return d.output?.state===2&&d.output.reconnects>0;},'output reconnect',60000);
            await until(async()=>{const paths=await fetch('http://127.0.0.1:18990/v3/paths/list').then(r=>r.json());
              return paths.items.some(p=>p.name===stream&&p.ready);},'reconnected server tracks');
            if(page){await page.reload();await page.waitForFunction(()=>document.querySelector('video')?.currentTime>1,{},{timeout:30000});}
          }
          const recording=path.join(dir,phase+'.mkv');
          const input=protocol==='rtmp'?['-i','rtmp://127.0.0.1:19350/'+stream]:protocol==='srt'?
            ['-i','srt://127.0.0.1:18890?mode=caller&streamid=read:'+stream]:['-rtsp_transport','tcp','-i','rtsp://127.0.0.1:18854/'+stream];
          record=launch(ffmpeg,['-hide_banner','-y',...input,'-map','0','-c','copy','-t',opts.seconds||'75',recording],id+'-'+phase+'-record');
          const frames=[];
          const end=Date.now()+(Number(opts.seconds||75)+20)*1000;
          while(record.exitCode===null&&Date.now()<end){
            const d=await api(discovery,'/diagnostics');frames.push({wall:Date.now(),output:d.output,metrics:d.stream});
            assert(d.output.state===2,'Output lost publishing state');
            await sleep(1000);
          }
          assert(record.exitCode!==null,'Receiver recording timed out');assert.equal(record.exitCode,0,'Receiver failed');
          assert(fs.statSync(recording).size>100000,'No usable recording');
          result.phases.push({phase,recording,receiverInput:input,diagnostics:frames});
          if(page){result.browserStats=await page.evaluate(async()=>{const all=[];for(const p of qualityPeers)for(const r of(await p.getStats()).values())if(r.type==='inbound-rtp')all.push(r);return all;});}
        }
        result.source=await source.evaluate(()=>({epoch:quality.epoch,calibrations:quality.calibrations}));
        if(page)result.browserStats=await page.evaluate(async()=>{const all=[];for(const p of qualityPeers)for(const r of(await p.getStats()).values())if(r.type==='inbound-rtp')all.push(r);return all;});
        result.lastDiagnostics=await api(discovery,'/diagnostics');result.transportPassed=true;
      }catch(e){result.error=String(e);console.error(id,e);}
      finally{
        if(record&&record.exitCode===null){record.kill();await record.closed;}
        if(receiverBrowser){await receiverBrowser.close();receiverBrowser=null;}
        const start=Date.now();
        if(app.exitCode===null)await api(discovery,'/commands',{command:'quit'}).catch(()=>{});
        await Promise.race([app.closed,sleep(10000)]);
        result.shutdown={forced:app.exitCode===null,exitCode:app.exitCode,elapsedMs:Date.now()-start};
        if(app.exitCode===null){app.kill();await app.closed;}
        if(monitor)await Promise.race([monitor.closed,sleep(5000)]);
        fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
        fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
      }
    }
  }finally{
    if(obs)await require('./quality-obs-receiver').stop(obs);
    if(sourceBrowser)await sourceBrowser.close();if(receiverBrowser)await receiverBrowser.close();fixture.close();
    for(const child of children)if(child.exitCode===null)child.kill();await Promise.all(children.map(c=>c.closed));for(const log of logs)log.end();
  }
  assert(results.cases.every(c=>c.transportPassed&&!c.shutdown.forced&&c.shutdown.exitCode===0),'One or more output workflows failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
