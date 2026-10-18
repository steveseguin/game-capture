'use strict';
// Transparent TCP gate: the packaged GUI still uses its real wss hostname,
// TLS handshake and certificate checks. Only its cgroup gets the DNAT rule.
const net=require('net'),dns=require('dns').promises,fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),{waitFor,sleep}=require('./macos-media-receiver');
async function create(report){
  const addresses=await dns.lookup('wss.vdo.ninja',{all:true});assert(addresses.length&&addresses.every(a=>a.family===4),'This owned route fixture requires IPv4 signaling resolution');
  const ips=[...new Set(addresses.map(a=>a.address))];let mode='forward',closed=false,route;
  const sockets=new Set(),stalled=new Set(),counts={forwardedConnections:0,rejectedConnections:0,stalledHandshakes:0,clientBytes:0,serverBytes:0,unexpectedErrors:0};
  function track(socket){sockets.add(socket);socket.once('close',()=>sockets.delete(socket));}
  const server=net.createServer(client=>{
    track(client);
    if(mode==='reject'){counts.rejectedConnections++;client.on('error',()=>{});client.destroy();return;}
    if(mode==='stall'){
      stalled.add(client);client.once('close',()=>stalled.delete(client));client.on('error',()=>{});
      let header=Buffer.alloc(0);
      client.on('data',data=>{
        counts.clientBytes+=data.length;
        if(header.length<3){header=Buffer.concat([header,data]).subarray(0,3);if(header.length===3){
          if(header[0]===22&&header[1]===3)counts.stalledHandshakes++;
          else{counts.unexpectedErrors++;client.destroy();}
        }}
      });return;
    }
    const remote=net.connect(443,ips[0]);track(remote);
    remote.once('connect',()=>counts.forwardedConnections++);
    client.on('data',d=>counts.clientBytes+=d.length);remote.on('data',d=>counts.serverBytes+=d.length);
    client.on('error',()=>{if(!closed&&mode==='forward'&&!remote.destroyed)counts.unexpectedErrors++;remote.destroy();});
    remote.on('error',()=>{if(!closed&&mode==='forward'&&!client.destroyed)counts.unexpectedErrors++;client.destroy();});
    client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());client.pipe(remote);remote.pipe(client);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const snapshot=()=>({mode,...counts,activeTcpSockets:sockets.size,activeUpstreams:[...sockets].filter(s=>s.remotePort===443).length,
    activeStalledConnections:stalled.size,transport:'Opaque TLS TCP gate with publisher-only cgroup DNAT',routeAttached:!!route});
  return {snapshot,
    async attach(publisher,exe){
      assert(!route);const helper=path.join(report,'linux-signaling-route.py'),log=fs.createWriteStream(path.join(report,'signaling-route.log'));
      route=spawn('sudo',['-n','python3',helper,'--pid='+publisher.pid,'--exe='+exe,'--exe-sha256='+crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),'--report='+report,'--port='+server.address().port,...ips.map(ip=>'--address='+ip)],{stdio:['pipe','pipe','pipe']});
      route.stdin.on('error',()=>{});
      route.closed=new Promise(resolve=>route.once('close',code=>log.end(()=>resolve(code))));let output='';route.stdout.on('data',d=>output+=d);route.stdout.pipe(log,{end:false});route.stderr.pipe(log,{end:false});
      await waitFor(()=>{assert.equal(route.exitCode,null,'Publisher route setup failed; inspect signaling-route.log');return output.includes('"ready": true');},15000,'Publisher route did not become ready');
    },
    fault(next){assert(['reject','stall'].includes(next));assert(route&&route.exitCode===null);mode=next;for(const socket of sockets)socket.destroy();},
    restore(){assert(route&&route.exitCode===null);mode='forward';for(const socket of stalled)socket.destroy();},
    async close(){
      closed=true;mode='reject';const retired=[...sockets].map(s=>new Promise(resolve=>s.once('close',resolve)));for(const s of sockets)s.destroy();
      await Promise.all([...retired,new Promise(resolve=>server.close(resolve))]);assert.equal(sockets.size,0);
      if(route){route.stdin.end();await Promise.race([route.closed,sleep(10000)]);assert.notEqual(route.exitCode,null,'Route cleanup did not retire');assert.equal(await route.closed,0);assert(JSON.parse(fs.readFileSync(path.join(report,'signaling-route-cleanup.json'))).passed);}
    }
  };
}
module.exports={create};
