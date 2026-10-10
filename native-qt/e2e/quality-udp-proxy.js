/* Owned UDP impairment fixture; no firewall, routes or unrelated traffic change. */
const dgram=require('dgram');
async function start({port,targetPort,loss=0,delayMs=0,jitterMs=0,burstMs=0,burstEveryMs=10000}){
 const socket=dgram.createSocket('udp4'),timers=new Set(),stats={received:0,forwarded:0,dropped:0,burstDropped:0};
 let client,seed=0x19c041,started=Date.now(),closed=false;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 socket.on('error',e=>{stats.error=String(e);});
 socket.on('message',(data,remote)=>{
  if(closed)return;stats.received++;
  const fromServer=remote.port===targetPort&&remote.address==='127.0.0.1';
  if(!fromServer)client={port:remote.port,address:remote.address};
  if(fromServer&&!client)return;
  // SRT control packets retain their high-bit marker. Impair data only, in
  // both directions, after establishment so failures are actual media loss.
  const elapsed=Date.now()-started,dataPacket=data.length>=16&&(data[0]&0x80)===0;
  const burst=dataPacket&&elapsed>5000&&burstMs&&elapsed%burstEveryMs<burstMs;
  if(dataPacket&&elapsed>5000&&(burst||random()<loss)){stats.dropped++;if(burst)stats.burstDropped++;return;}
  const destination=fromServer?client:{port:targetPort,address:'127.0.0.1'};
  const forward=()=>{if(!closed)socket.send(data,destination.port,destination.address,e=>{if(!e)stats.forwarded++;});};
  const wait=Math.max(0,delayMs+(random()*2-1)*jitterMs);
  if(wait){const timer=setTimeout(()=>{timers.delete(timer);forward();},wait);timers.add(timer);}else forward();
 });
 await new Promise(r=>socket.bind(port,'127.0.0.1',r));
 return {stats,close:()=>{closed=true;for(const t of timers)clearTimeout(t);socket.close();}};
}
module.exports={start};
