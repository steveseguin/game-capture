/* Exercise packaged WHIP HTTP negotiation, credentials, cleanup and cancellation.
 * Successful cases forward unchanged SDP/media negotiation to real MediaMTX.
 */
const fs=require('fs'),path=require('path'),http=require('http'),https=require('https'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process'),{chromium}=require('playwright'),assert=require('assert/strict');
const opts=Object.fromEntries(process.argv.slice(2).map(x=>{const i=x.indexOf('=');return[x.slice(2,i),x.slice(i+1)];}));
const out=path.resolve(opts.output),exe=path.resolve(opts.publisher),native=path.resolve(__dirname,'..'),token=crypto.randomBytes(24).toString('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),children=[],logs=[],trace=[];let mode,proxy1,proxy2,stun;const stunRequests=[];
fs.mkdirSync(out,{recursive:true});
function launch(program,args,name,env={}){const log=fs.createWriteStream(path.join(out,name+'.log'));logs.push(log);const p=spawn(program,args,{windowsHide:true,cwd:path.dirname(path.resolve(program)),env:{...process.env,...env},stdio:['ignore','pipe','pipe']});p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});p.closed=new Promise(r=>p.once('close',r));children.push(p);return p;}
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('Timed out: '+label);}
async function api(file,route,body){const d=JSON.parse(fs.readFileSync(file));const r=await fetch(d.base_url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+d.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(r.ok);return r.json();}
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',r));
function handler(origin){return(req,res)=>{
  const auth=req.headers.authorization;trace.push({mode,origin,method:req.method,path:req.url,credential:auth===('Bearer '+token)?'expected':auth?'unexpected':'none'});
  if(mode==='unauthorized'){res.writeHead(401);res.end();return;}
  if(mode==='cancel'&&req.method==='POST')return;
  if(mode.startsWith('ice-link')&&req.method==='OPTIONS'){
    res.writeHead(204,{Link:`<stun:127.0.0.1:${stun.address().port}>; rel=${mode==='ice-link-token'?'ice-server':'"alternate ice-server"'}`});res.end();return;
  }
  if(mode==='malformed'||mode==='oversized'){
    if(req.method==='POST'){res.writeHead(201,{'Content-Type':'application/sdp',Location:'/'+mode+'/session'});res.end(mode==='oversized'?'x'.repeat(2*1024*1024):'not valid SDP');}
    else{res.writeHead(req.method==='DELETE'?200:204);res.end();}return;
  }
  if(mode==='redirect'&&origin===1&&req.method==='POST'){
    res.writeHead(307,{Location:'http://127.0.0.1:'+proxy2.address().port+req.url});res.end();return;
  }
  if((origin===1&&auth!==('Bearer '+token))||(origin===2&&auth)){
    res.writeHead(403);res.end();return;
  }
  const upstream=http.request({hostname:'127.0.0.1',port:18889,path:req.url,method:req.method,
    headers:{'content-type':req.headers['content-type']||'application/sdp'}},reply=>{
      const headers={...reply.headers};if(headers.location){const target=new URL(headers.location,'http://127.0.0.1:18889');headers.location='http://127.0.0.1:'+(origin===1?proxy1:proxy2).address().port+target.pathname+target.search;}
      res.writeHead(reply.statusCode,headers);reply.pipe(res);
    });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
};}
async function main(){
  const config=path.join(out,'mediamtx.yml');fs.writeFileSync(config,'api: true\napiAddress: 127.0.0.1:18990\nrtsp: false\nrtmp: false\nsrt: false\nhls: false\nmoq: false\nwebrtcAddress: 127.0.0.1:18889\nwebrtcLocalUDPAddress: 127.0.0.1:18189\nwebrtcIPsFromInterfaces: false\nwebrtcAdditionalHosts: [127.0.0.1]\npaths:\n  all_others:\n');
  launch(path.join(native,'.cache/mediamtx-1.21.2/mediamtx.exe'),[config],'server');
  proxy1=http.createServer(handler(1));proxy2=http.createServer(handler(2));await listen(proxy1);await listen(proxy2);
  stun=require('dgram').createSocket('udp4');
  stun.on('message',(request,remote)=>{
    if(request.length<20||request.readUInt16BE(0)!==1||request.readUInt32BE(4)!==0x2112a442)return;
    stunRequests.push({mode});const reply=Buffer.alloc(32);
    reply.writeUInt16BE(0x101,0);reply.writeUInt16BE(12,2);request.copy(reply,4,4,20);
    reply.writeUInt16BE(0x20,20);reply.writeUInt16BE(8,22);reply[25]=1;reply.writeUInt16BE(remote.port^0x2112,26);
    const address=remote.address.split('.').reduce((value,part)=>(value*256+Number(part))>>>0,0);
    reply.writeUInt32BE((address^0x2112a442)>>>0,28);stun.send(reply,remote.port,remote.address);
  });
  await new Promise(resolve=>stun.bind(0,'127.0.0.1',resolve));
  const key=path.join(out,'localhost.key'),cert=path.join(out,'localhost.crt');
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',key,'-out',cert],{windowsHide:true,stdio:'ignore'});
  const tls=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},handler(1));await listen(tls);
  const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(__dirname,'quality-source.html')));});await listen(fixture);
  const browser=await chromium.launch({channel:'chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-backgrounding-occluded-windows']});
  const report={sha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),cases:[]};
  try{
    const source=await browser.newPage({viewport:null});await source.goto('http://127.0.0.1:'+fixture.address().port);await source.getByRole('button').click();await source.waitForFunction(()=>quality.ready);
    for(mode of ['authenticated','redirect','ice-link-token','ice-link-list','unauthorized','malformed','oversized','invalid-tls','cancel','rtmps-invalid-tls']){
      const dir=path.join(out,mode);fs.mkdirSync(dir);const discovery=path.join(dir,'control.json'),result={mode};report.cases.push(result);
      const secure=mode.includes('invalid-tls'),rtmps=mode.startsWith('rtmps');
      const endpoint=(secure?(rtmps?'rtmps':'https'):'http')+'://127.0.0.1:'+(secure?tls:proxy1).address().port+'/'+mode+'/whip';
      const publisher=launch(exe,['--headless','--output='+(rtmps?'rtmp':'whip'),'--output-url='+endpoint,...(rtmps?[]:['--output-token='+token]),
        '--window=Game Capture Quality Source','--resolution=960x540','--fps=30','--audio-source=selected-window','--local-control','--local-control-discovery='+discovery],mode+'-publisher',{LOCALAPPDATA:dir,GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING:'1'});
      let receiver;
      try{
        if(['unauthorized','malformed','oversized','invalid-tls'].includes(mode)){
          await Promise.race([publisher.closed,sleep(20000)]);assert.equal(publisher.exitCode,3,'Expected a bounded, permanent WHIP error');
          if(mode==='malformed'||mode==='oversized')assert(trace.some(t=>t.mode===mode&&t.method==='DELETE'),'Failed session was not deleted');
        }else{
          await until(()=>fs.existsSync(discovery),'control server');
          if(rtmps){await until(async()=>{const d=await api(discovery,'/diagnostics');result.diagnostics=d;return d.output?.reconnects>0;},'TLS rejection');assert(!trace.some(t=>t.mode===mode),'Untrusted TLS delivered application data');}
          else if(mode==='cancel')await until(()=>trace.some(t=>t.mode===mode&&t.method==='POST'),'pending POST');
          else{
            await until(async()=>{assert(publisher.exitCode===null);return (await api(discovery,'/diagnostics')).output?.state===2;},'publishing');
            receiver=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
            const page=await receiver.newPage();await page.goto('http://127.0.0.1:18889/'+mode+'/');await page.waitForFunction(()=>document.querySelector('video')?.currentTime>2,{},{timeout:20000});
            await page.screenshot({path:path.join(dir,'receiver.png')});
            const diagnostics=await api(discovery,'/diagnostics');assert(!JSON.stringify(diagnostics).includes(token),'Token leaked into diagnostics');result.diagnostics=diagnostics;
            if(mode.startsWith('ice-link')){result.stunRequests=stunRequests.filter(x=>x.mode===mode).length;assert(result.stunRequests>0,'Advertised ICE server was ignored');}
          }
          const start=Date.now();await api(discovery,'/commands',{command:'quit'});await Promise.race([publisher.closed,sleep(5000)]);
          assert.equal(publisher.exitCode,0,'Stop did not exit normally');result.shutdownMs=Date.now()-start;
          if(mode!=='cancel'&&!rtmps)assert(trace.some(t=>t.mode===mode&&t.method==='DELETE'),'Session was not deleted on stop');
        }
        assert(!fs.readFileSync(path.join(out,mode+'-publisher.log'),'utf8').includes(token),'Token leaked into console log');
        const log=path.join(dir,'GameCapture/logs/game-capture-debug.log');if(fs.existsSync(log))assert(!fs.readFileSync(log,'utf8').includes(token),'Token leaked into application log');
        result.passed=true;
      }catch(e){result.error=String(e);console.error(mode,e);}
      finally{if(receiver)await receiver.close();if(publisher.exitCode===null){publisher.kill();await publisher.closed;}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({...report,trace},null,2));}
    }
    assert(trace.filter(t=>t.mode==='redirect'&&t.origin===2).every(t=>t.credential==='none'),'Credential crossed origins');
  }finally{
    await browser.close();stun.close();for(const server of [fixture,proxy1,proxy2,tls]){server.closeAllConnections();server.close();}
    for(const p of children)if(p.exitCode===null)p.kill();await Promise.all(children.map(p=>p.closed));for(const log of logs)log.end();
  }
  assert(report.cases.every(c=>c.passed),'WHIP HTTP workflow failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
