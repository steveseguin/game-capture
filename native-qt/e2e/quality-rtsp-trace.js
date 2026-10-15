/* Observe real interleaved RTP/RTCP without changing the receiver byte stream. */
const net=require('net'),fs=require('fs');
async function start({port,targetPort,output}){
 const log=fs.createWriteStream(output),sockets=new Set(),summary={connections:0,parseErrors:0,streams:{}};
 const server=net.createServer(client=>{
  const connection=++summary.connections,upstream=net.connect(targetPort,'127.0.0.1');
  sockets.add(client);sockets.add(upstream);let pending=Buffer.alloc(0);
  client.pipe(upstream);upstream.pipe(client);
  const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};
  client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
  upstream.on('data',data=>{
   pending=Buffer.concat([pending,data]);
   if(pending.length>1024*1024){summary.parseErrors++;pending=Buffer.alloc(0);return;}
   while(pending.length){
    if(pending[0]!==36){
     const end=pending.indexOf('\r\n\r\n');if(end<0)return;
     const header=pending.subarray(0,end).toString();const length=Number(header.match(/content-length:\s*(\d+)/i)?.[1]||0);
     if(pending.length<end+4+length)return;
     // Preserve the announced time origins too: monotonic RTP alone cannot
     // explain a receiver switching from RTP-Info to its first RTCP mapping.
     log.write(JSON.stringify({kind:'rtsp-response',wall:Date.now(),connection,
      status:header.split('\r\n')[0],cseq:header.match(/cseq:\s*([^\r\n]+)/i)?.[1],
      rtpInfo:header.match(/rtp-info:\s*([^\r\n]+)/i)?.[1],range:header.match(/range:\s*([^\r\n]+)/i)?.[1]})+'\n');
     pending=pending.subarray(end+4+length);continue;
    }
    if(pending.length<4)return;const channel=pending[1],length=pending.readUInt16BE(2);
    if(pending.length<length+4)return;const packet=pending.subarray(4,length+4);pending=pending.subarray(length+4);
    if(packet.length<8||(packet[0]>>6)!==2){summary.parseErrors++;continue;}
    if(channel%2===1){
     for(let offset=0;offset+4<=packet.length;){const size=(packet.readUInt16BE(offset+2)+1)*4;
      if(size<4||offset+size>packet.length){summary.parseErrors++;break;}
      if(packet[offset+1]===200&&size>=28)log.write(JSON.stringify({kind:'sender-report',wall:Date.now(),connection,channel,
       ssrc:packet.readUInt32BE(offset+4),ntpSeconds:packet.readUInt32BE(offset+8),ntpFraction:packet.readUInt32BE(offset+12),timestamp:packet.readUInt32BE(offset+16)})+'\n');
      offset+=size;
     }continue;
    }
    if(packet.length<12){summary.parseErrors++;continue;}
    const ssrc=packet.readUInt32BE(8),timestamp=packet.readUInt32BE(4),key=connection+':'+channel+':'+ssrc;
    const stream=summary.streams[key]||(summary.streams[key]={ssrc,channel,connection,payloadType:packet[1]&127,packets:0,timestamps:0,backwardTimestamps:0});
    stream.packets++;
    // Video marker packets delimit complete frames. Timestamp-change logs
    // alone cannot distinguish two frames incorrectly sharing one timestamp.
    if(packet[1]&128){
     const delta=stream.lastMarkerTimestamp===undefined?null:(timestamp-stream.lastMarkerTimestamp)|0;
     stream.frameMarkers=(stream.frameMarkers||0)+1;
     stream.duplicateMarkerTimestamps=(stream.duplicateMarkerTimestamps||0)+(delta===0?1:0);
     stream.backwardMarkerTimestamps=(stream.backwardMarkerTimestamps||0)+(delta!==null&&delta<0?1:0);
     stream.lastMarkerTimestamp=timestamp;
     log.write(JSON.stringify({kind:'frame-marker',wall:Date.now(),connection,channel,ssrc,timestamp,delta,sequence:packet.readUInt16BE(2)})+'\n');
    }
    if(timestamp!==stream.lastTimestamp){
     const delta=stream.lastTimestamp===undefined?null:(timestamp-stream.lastTimestamp)|0;
     if(delta!==null&&delta<0)stream.backwardTimestamps++;
     stream.timestamps++;stream.lastTimestamp=timestamp;
     log.write(JSON.stringify({kind:'rtp',wall:Date.now(),connection,channel,ssrc,timestamp,delta,sequence:packet.readUInt16BE(2)})+'\n');
    }
   }
  });
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 return {summary,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>log.end(resolve));}};
}
// Explicit diagnostic/workaround for MediaMTX's on-demand RTSP stream: allow
// it to observe both tracks before the recorder asks for RTP-Info. No RTP or
// timestamps are altered. Keep this opt-in so ordinary starts remain covered.
async function warmup(url,ms=500){
 const target=new URL(url);
 if(target.protocol!=='rtsp:'||target.hostname!=='127.0.0.1'||target.username||target.password||!Number.isFinite(ms)||ms<0||ms>5000)
  throw Error('RTSP warm-up requires a private loopback fixture and a bounded delay');
 await new Promise((resolve,reject)=>{
  const socket=net.connect(Number(target.port||554),target.hostname);let pending=Buffer.alloc(0),complete=false;
  socket.setTimeout(5000,()=>socket.destroy(Error('RTSP DESCRIBE timed out')));
  socket.on('connect',()=>socket.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`));
  socket.on('error',reject);socket.on('close',()=>{if(!complete)reject(Error('RTSP DESCRIBE closed early'));});
  socket.on('data',chunk=>{
   if(complete)return;pending=Buffer.concat([pending,chunk]);
   if(pending.length>1024*1024){socket.destroy(Error('RTSP response too large'));return;}
   const end=pending.indexOf('\r\n\r\n');if(end<0)return;
   const header=pending.subarray(0,end).toString(),length=Number(header.match(/content-length:\s*(\d+)/i)?.[1]||0);
   if(!header.startsWith('RTSP/1.0 200 ')){socket.destroy(Error('RTSP DESCRIBE failed'));return;}
   if(pending.length<end+4+length)return;complete=true;socket.destroy();resolve();
  });
 });
 await new Promise(resolve=>setTimeout(resolve,ms));
}
module.exports={start,warmup};
