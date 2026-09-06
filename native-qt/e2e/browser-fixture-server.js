'use strict';
const fs=require('fs');
const http=require('http');

// Only two explicit fixture resources are exposed, on loopback. Same-origin
// HTTP permits captureStream without weakening Chromium's file-origin rules.
exports.start=async function(html,video) {
  const server=http.createServer((req,res)=>{
    const file=req.url==='/'?html:req.url==='/video'?video:null;
    if(!file||!['GET','HEAD'].includes(req.method)){res.writeHead(404).end();return;}
    const size=fs.statSync(file).size;
    let start=0,end=size-1,status=200;
    if(req.headers.range) {
      const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if(!match){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}
      start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}
      status=206;
    }
    res.writeHead(status,{'Content-Type':file===html?'text/html':video.endsWith('.webm')?'video/webm':'video/mp4',
      'Accept-Ranges':'bytes','Content-Length':end-start+1,
      ...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD'){res.end();return;}
    const input=fs.createReadStream(file,{start,end});
    input.on('error',()=>res.destroy());res.on('close',()=>input.destroy());input.pipe(res);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}/`,close(){server.closeAllConnections();server.close();}};
};
