'use strict';
const net = require('node:net');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Bounded malformed requests against this run's owned loopback publisher.
// Return no tokens or response bodies. Seed + this source reconstruct each
// payload and write boundary; TCP delivery timing is not deterministic.
module.exports = async function fuzzControl(control, seed, evidence) {
  const url = new URL(control.base_url);
  assert.equal(url.hostname, '127.0.0.1');
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  evidence.seed = seed; evidence.requests = []; evidence.passed = false;
  for (let index = 0; index < 128; index++) {
    const kind = index % 8;
    let body = Buffer.alloc(0), method = 'POST', route = '/commands', expected = 400;
    let headers = ['Authorization: Bearer ' + control.token];
    if (kind === 0) {
      body = Buffer.alloc(1 + next() % 511, 255);
      for (let i = 1; i < body.length; i++) body[i] = next() >>> 24;
    } else if (kind === 1) {
      const depth = 1 + next() % 1200;
      body = Buffer.from('['.repeat(depth) + 'null' + ']'.repeat(depth));
    } else if (kind === 2) {
      body = Buffer.from(JSON.stringify({command: 'fuzz-' + next().toString(16), notes: 'café / 日本語 / 🎮'}));
    } else if (kind === 3) {
      body = Buffer.from(['null', '[]', '{', '{"command":null}', '{"command":123}'][next() % 5]);
    } else if (kind === 4 || kind === 5) {
      method = 'GET'; route = '/diagnostics'; expected = 401;
      headers = kind === 4 ? [] : ['Authorization: Bearer invalid-' + next().toString(16)];
    } else if (kind === 6) {
      method = 'GET'; route = '/health'; expected = 200; headers = [];
    } else {
      headers.push('Content-Length: 0'); body = Buffer.from('{');
    }
    headers.push('Content-Length: ' + body.length);
    const head = Buffer.from(`${method} ${route} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    const payload = Buffer.concat([head, body]);
    const chunks = []; let offset = 0;
    while (offset < payload.length) { const size = Math.min(1 + next() % 97, payload.length - offset); chunks.push(size); offset += size; }
    const row = {index, kind, method, route, bodySha256: hash(body), bodyBytes: body.length, chunks, expected};
    evidence.requests.push(row);
    row.actual = await new Promise((resolve, reject) => {
      const socket = net.createConnection({host: url.hostname, port: Number(url.port)});
      let response = Buffer.alloc(0), written = 0, chunk = 0, done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(Error('Control fuzz absolute request deadline')), 5000);
      socket.on('error', error => finish(error));
      socket.on('data', bytes => {
        response = Buffer.concat([response, bytes]);
        if (response.length > 65536) return finish(Error('Oversized control fuzz response'));
        const end = response.indexOf('\r\n');
        if (end >= 0) {
          const match = /^HTTP\/1\.1 (\d{3}) /.exec(response.subarray(0, end).toString());
          finish(match ? null : Error('Invalid control response'), match ? Number(match[1]) : undefined);
        }
      });
      socket.on('end', () => finish(Error('Control closed without response')));
      const write = () => {
        if (done || chunk === chunks.length) return;
        const size = chunks[chunk++]; socket.write(payload.subarray(written, written + size)); written += size;
        setImmediate(write);
      };
      socket.on('connect', write);
    });
    assert.equal(row.actual, expected, 'Live control fuzz request ' + index);
  }
  evidence.passed = true;
};
