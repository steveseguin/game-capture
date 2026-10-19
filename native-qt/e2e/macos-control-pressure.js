'use strict';
// Only the caller's owned loopback publisher. Never export authentication bytes.
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function pressure(control, seed, evidence) {
  const url = new URL(control.base_url);
  assert.equal(url.hostname, '127.0.0.1');
  const address = {host:url.hostname,port:Number(url.port)};
  const auth = 'Authorization: Bearer ' + control.token + '\r\n';
  const started = performance.now(), elapsed = () => performance.now() - started;
  evidence.scope = 'Bounded local HTTP framing, incomplete-client deadlines and connection admission while real media is received';
  evidence.seed = seed; evidence.started = Date.now(); evidence.requests = [];
  evidence.seeded = []; evidence.passed = false;
  async function raw(name, payload, expected, fragmented = false) {
    const bytes = Buffer.from(payload);
    const row = {name,expected,bytes:bytes.length,fragmented,startedMs:elapsed()};
    // Redacted templates remain reconstructible without disclosing the token.
    row.redactedPayload = bytes.toString().split(control.token).join('<RUN_TOKEN>');
    row.redactedSha256 = crypto.createHash('sha256').update(row.redactedPayload).digest('hex');
    evidence.requests.push(row);
    row.actual = await new Promise((resolve,reject) => {
      const socket = net.createConnection(address); let response = '', done = false;
      const finish = (error,status) => {
        if(done)return; done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(status);
      };
      const timer = setTimeout(()=>finish(Error(name+': absolute deadline')),5000);
      socket.on('error',error=>finish(error));
      socket.on('end',()=>finish(Error(name+': closed before status')));
      socket.on('data',chunk=>{
        response+=chunk.toString();
        if(response.length>65536)return finish(Error(name+': response bound'));
        const line=response.indexOf('\r\n');
        if(line>=0) {
          const match=/^HTTP\/1\.1 (\d{3}) /.exec(response.slice(0,line));
          finish(match?null:Error(name+': invalid status'),match?Number(match[1]):undefined);
        }
      });
      socket.on('connect',()=>{
        let offset=0;
        const write=()=>{
          if(done||offset===bytes.length)return;
          const end=Math.min(bytes.length,offset+(fragmented?7:bytes.length));
          socket.write(bytes.subarray(offset,end));offset=end;setImmediate(write);
        };write();
      });
    });
    row.endedMs=elapsed();assert.equal(row.actual,expected,name);
  }
  try {
    await sleep(100); // Allow the concurrent decoded-track observer to attach.
    for(let index=0;index<3;index++) {
      const row={startedMs:elapsed()};evidence.seeded.push(row);
      await require('./macos-live-control-fuzz')(control,(seed+index)>>>0,row);
      row.endedMs=elapsed();
    }
    const invalid = [
      ['missing-version','GET /health'],['invalid-version','GET /health HTTP/9.9'],
      ['extra-request-token','GET /health HTTP/1.1 extra'],
      ['bare-LF','GET /health HTTP/1.1\nX-Fill: a'],
      ['header-without-colon','GET /health HTTP/1.1\r\ninvalid-header'],
      ['whitespace-name','GET /health HTTP/1.1\r\nContent-Length : 0'],
      ['duplicate-host','GET /health HTTP/1.1\r\nHost: a\r\nhOsT: b'],
      ['duplicate-auth','GET /diagnostics HTTP/1.1\r\n'+auth.trimEnd()+'\r\n'+auth.trimEnd()],
      ['duplicate-length','GET /health HTTP/1.1\r\nContent-Length: 0\r\ncOnTeNt-LeNgTh: 0'],
      ['chunked','GET /health HTTP/1.1\r\nTransfer-Encoding: chunked'],
      ['length-and-chunked','GET /health HTTP/1.1\r\nContent-Length: 0\r\nTransfer-Encoding: chunked'],
      ['NUL-header','GET /health HTTP/1.1\r\nX-Fill: a\0b'],
      ['oversized-header','GET /health HTTP/1.1\r\nX-Fill: '+'a'.repeat(17000)],
    ];
    for(const value of ['-1','+0','1e3','0x10','999999999999999999999999','1048576',''])
      invalid.push(['invalid-length-'+(value||'empty'),'GET /health HTTP/1.1\r\nContent-Length: '+value]);
    for(const [name,request] of invalid) await raw(name,request+'\r\n\r\n',400);
    await raw('fragmented-health','GET /health HTTP/1.1\r\ncOnTeNt-LeNgTh: 0\r\n\r\n',200,true);

    // All three must close on the absolute deadline, including a byte trickle.
    evidence.slowClients=[];
    const held=[];
    try {
      await Promise.all(['idle','trickled-header','incomplete-body'].map((kind,index)=>new Promise((resolve,reject)=>{
        const row={kind,startedMs:elapsed(),bytesSent:0};evidence.slowClients.push(row);
        const socket=net.createConnection(address);held.push(socket);let trickle;
        const deadline=setTimeout(()=>{row.timedOut=true;socket.destroy();reject(Error(kind+': not closed by 11.5 seconds'));},11500);
        socket.on('connect',()=>{
          row.connectedMs=elapsed();
          const initial=['','GET /health HTTP/1.1\r\nX-Slow: ', 'POST /commands HTTP/1.1\r\nContent-Length: 500\r\n\r\n'][index];
          if(initial){socket.write(initial);row.bytesSent+=Buffer.byteLength(initial);}
          if(index===1)trickle=setInterval(()=>{socket.write('a');row.bytesSent++;},200);
        });
        socket.on('data',bytes=>{row.responseBytes=(row.responseBytes||0)+bytes.length;});
        socket.on('error',error=>{row.errorCode=error.code;if(error.code!=='ECONNRESET')reject(error);});
        socket.on('close',()=>{
          clearTimeout(deadline);clearInterval(trickle);row.closedMs=elapsed();
          row.lifetimeMs=row.closedMs-row.connectedMs;
          if(!row.timedOut&&row.lifetimeMs>=9000&&row.lifetimeMs<=11500)resolve();
          else reject(Error(kind+': unexpected lifetime '+row.lifetimeMs));
        });
      })));
    } finally {for(const socket of held)socket.destroy();}

    // Deliberately occupy all slots; health refusal during this phase is expected.
    // Media is observed separately and a fresh authenticated request must recover.
    evidence.admission={startedMs:elapsed(),clients:[]};const slots=[];
    try {
      for(let index=0;index<48;index++) {
        const row={index};evidence.admission.clients.push(row);
        const socket=net.createConnection(address);slots.push(socket);
        socket.on('connect',()=>{row.connected=true;});
        socket.on('error',error=>{row.errorCode=error.code;});
        socket.on('close',()=>{row.closed=true;});
        socket.on('data',chunk=>{row.responseBytes=(row.responseBytes||0)+chunk.length;});
      }
      await sleep(1000);
      evidence.admission.rejected=evidence.admission.clients.filter(row=>row.closed).length;
      evidence.admission.accepted=evidence.admission.clients.filter(row=>row.connected&&!row.closed).length;
      assert(evidence.admission.rejected>=16,'Connection bound was not enforced');
      assert(evidence.admission.accepted>0&&evidence.admission.accepted<=32,'No bounded admitted clients');
    } finally {for(const socket of slots)socket.destroy();evidence.admission.endedMs=elapsed();}
    await sleep(250);
    await raw('authenticated-recovery','GET /diagnostics HTTP/1.1\r\n'+auth+'\r\n',200,true);
    const body='{"command":"quit"}';
    await raw('one-request-per-connection','GET /health HTTP/1.1\r\n\r\nPOST /commands HTTP/1.1\r\n'+auth+'Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body,200);
    await sleep(250);
    await raw('pipeline-did-not-quit','GET /diagnostics HTTP/1.1\r\n'+auth+'\r\n',200);
    evidence.passed=true;
  } finally {evidence.ended=Date.now();evidence.durationMs=elapsed();}
};
