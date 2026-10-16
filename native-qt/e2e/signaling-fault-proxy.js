'use strict';
// Owned loopback-only forwarding proxy. Signaling payloads remain opaque.
// The upstream retains normal TLS certificate verification.
const net = require('node:net');
const { WebSocketServer, WebSocket } = require('ws');
const assert = require('node:assert/strict');
async function create() {
  let mode = 'forward', closed = false;
  const tcp = new Set(), upstreams = new Set();
  const counts = { forwardedConnections: 0, rejectedConnections: 0, stalledHandshakes: 0,
    clientMessages: 0, serverMessages: 0, unexpectedErrors: 0 };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  server.on('connection', client => {
    const remote = new WebSocket('wss://wss.vdo.ninja:443', { handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
    upstreams.add(remote);
    let queuedBytes = 0;
    const queued = [];
    const fail = () => { if (mode === 'forward' && !closed) counts.unexpectedErrors++; client.terminate(); remote.terminate(); };
    client.on('message', (data, binary) => {
      counts.clientMessages++;
      if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary }, error => { if (error) fail(); });
      else if (remote.readyState === WebSocket.CONNECTING) {
        queuedBytes += data.length;
        if (queuedBytes > 1024 * 1024 || queued.length >= 256) return fail();
        queued.push([data, binary]);
      }
    });
    remote.on('open', () => {
      counts.forwardedConnections++;
      for (const [data, binary] of queued) remote.send(data, { binary }, error => { if (error) fail(); });
      queued.length = 0; queuedBytes = 0;
    });
    remote.on('message', (data, binary) => {
      counts.serverMessages++;
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary }, error => { if (error) fail(); });
    });
    remote.on('close', () => { upstreams.delete(remote); client.terminate(); });
    client.on('close', () => remote.terminate());
    remote.on('error', fail); client.on('error', fail);
  });
  const gate = net.createServer(socket => {
    tcp.add(socket); socket.on('close', () => tcp.delete(socket)); socket.on('error', () => socket.destroy());
    if (mode === 'reject') { counts.rejectedConnections++; socket.destroy(); return; }
    if (mode === 'stall') {
      // Consume a real upgrade request without returning a handshake response.
      socket.once('data', data => { if (data.toString('ascii').startsWith('GET ')) counts.stalledHandshakes++; });
      return;
    }
    const backend = net.connect(server.address().port, '127.0.0.1');
    tcp.add(backend); backend.on('close', () => { tcp.delete(backend); socket.destroy(); });
    backend.on('error', () => socket.destroy()); socket.on('close', () => backend.destroy());
    socket.pipe(backend); backend.pipe(socket);
  });
  try { await new Promise((resolve, reject) => { gate.once('error', reject); gate.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  function disconnect() {
    for (const peer of upstreams) peer.terminate();
    for (const peer of server.clients) peer.terminate();
    for (const socket of tcp) socket.destroy();
  }
  return {
    url: `ws://127.0.0.1:${gate.address().port}`,
    snapshot: () => ({ mode, ...counts, activeTcpSockets: tcp.size, activeUpstreams: upstreams.size }),
    fault(next) { assert(['reject', 'stall'].includes(next)); mode = next; disconnect(); },
    restore() { mode = 'forward'; },
    async close() {
      closed = true; mode = 'reject';
      const retired = [...upstreams].map(peer => peer.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise(resolve => peer.once('close', resolve)));
      disconnect();
      await Promise.all([...retired, new Promise(resolve => gate.close(resolve)), new Promise(resolve => server.close(resolve))]);
      assert.equal(tcp.size, 0); assert.equal(upstreams.size, 0);
    }
  };
}
module.exports = { create };
