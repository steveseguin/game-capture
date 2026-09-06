'use strict';
// Test-only ICE candidate relay. Restrict destinations and senders to this host.
// The encrypted DTLS/SRTP payload is forwarded unchanged; only RTP is dropped.
const dgram=require('dgram'),os=require('os');
exports.create=function() {
  const local=new Set(Object.values(os.networkInterfaces()).flat().filter(a=>a.family==='IPv4').map(a=>a.address));
  const relays=new Map();let percent=0,closed=false;
  async function candidate(value,uuid,session) {
    if(closed)throw Error('UDP relay is closed');
    const words=value.replace(/^a=/,'').trim().split(/\s+/);
    if(words[2]?.toLowerCase()!=='udp'||!local.has(words[4])||words[7]!=='host')return null;
    const host=words[4],port=Number(words[5]);
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid publisher ICE port');
    const key=[uuid,session,host,port].join('|');
    if(!relays.has(key)) {
      const socket=dgram.createSocket('udp4');
      const r={uuid,session,host,port,socket,rtp:0,dropped:0,forwarded:0,lastRtpMs:0,ssrc:{},errors:[]};
      relays.set(key,r);
      socket.on('error',e=>r.errors.push(String(e)));
      socket.on('message',(data,from)=>{
        if(closed||!local.has(from.address))return;
        if(from.address===host&&from.port===port) {
          if(!r.receiver)return;
          const rtp=data.length>=12&&(data[0]&0xc0)===0x80&&!(data[1]>=192&&data[1]<=223);
          if(rtp) {
            r.rtp++;r.lastRtpMs=Date.now();
            const id=data.readUInt32BE(8),s=r.ssrc[id]||=( {received:0,dropped:0} );s.received++;
            if(percent>0&&r.rtp%100<percent){r.dropped++;s.dropped++;return;}
          }
          r.forwarded++;socket.send(data,r.receiver.port,r.receiver.address);
        } else {
          // ICE associates this socket with one remote transport. A replacement
          // transport uses another candidate/session mapping.
          r.receiver={address:from.address,port:from.port};socket.send(data,port,host);
        }
      });
      r.ready=new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,host,()=>{
        r.relayPort=socket.address().port;resolve();
      });});
    }
    await relays.get(key).ready;
    words[5]=String(relays.get(key).relayPort);
    return words.join(' ');
  }
  async function transform(data,outbound) {
    if(closed)return null;
    const message=JSON.parse(data.toString());
    if(typeof message.description==='string'&&!message.vector)message.description=JSON.parse(message.description);
    if(typeof message.candidates==='string'&&!message.vector)message.candidates=JSON.parse(message.candidates);
    if(message.vector&&(message.description||message.candidate||message.candidates))throw Error('UDP review requires unencrypted signaling');
    if(message.description?.sdp) {
      const lines=[];
      for(const line of message.description.sdp.split(/\r?\n/)) {
        if(line.startsWith('a=candidate:')) {
          if(outbound){const c=await candidate(line,message.UUID,message.session);if(c)lines.push('a='+c);}
        } else lines.push(line);
      }
      message.description.sdp=lines.join('\r\n');
    }
    if(message.candidate||message.candidates) {
      if(!outbound)return null; // prevent direct-path checks bypassing the relay
      const rewrite=async c=>{
        if(typeof c==='string')c=JSON.parse(c);
        const value=await candidate(c.candidate,message.UUID,message.session);
        return value?{...c,candidate:value}:null;
      };
      if(message.candidate){message.candidate=await rewrite(message.candidate);if(!message.candidate)return null;}
      if(message.candidates){message.candidates=(await Promise.all(message.candidates.map(rewrite))).filter(Boolean);if(!message.candidates.length)return null;}
    }
    return JSON.stringify(message);
  }
  return {transform,setLoss(value){if(!Number.isInteger(value)||value<0||value>100)throw Error('Loss percent must be an integer from 0 to 100');percent=value;},
    snapshot(){return [...relays.values()].map(({socket,ready,...r})=>structuredClone(r));},
    close(){closed=true;for(const r of relays.values())r.socket.close();}};
};
