'use strict';
// Live packaged workflow companion. Reuse the Mac corpus and the Windows
// packaged framing/deadline/capacity cases against this run's owned publisher.
const net = require('node:net');
const assert = require('node:assert/strict');
const fuzz = require('./macos-live-control-fuzz');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function stress(control, seed, evidence) {
  const url = new URL(control.base_url);
  assert.equal(url.hostname, '127.0.0.1');
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  evidence.passed = false; evidence.corpora = []; evidence.framing = [];
  const auth = `Authorization: Bearer ${control.token}\r\n`;
  const address = {host:url.hostname, port:Number(url.port)};
  function request(payload) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(address);
      let response = '', done = false;
      const finish = (error, code) => {
        if (done) return; done = true; clearTimeout(timer); socket.destroy();
        error ? reject(error) : resolve(code);
      };
      const timer = setTimeout(() => finish(Error('Absolute request deadline')), 5000);
      socket.on('connect', () => socket.end(payload));
      socket.on('error', error => finish(error));
      socket.on('data', data => {
        response += data.toString();
        if (response.length > 65536) return finish(Error('Oversized response'));
        const match = /^HTTP\/1\.1 (\d{3}) /.exec(response);
        if (match) finish(null, Number(match[1]));
      });
      socket.on('end', () => finish(Error('Closed without response')));
    });
  }
  for (let i=0; i<3; ++i) {
    const corpus = {}; evidence.corpora.push(corpus);
    await fuzz(control, (seed+i)>>>0, corpus);
  }
  const invalidHeaders = ['-1','+0','1e3','0x10','9223372036854775808','1048576','']
    .map(value => ['length-'+value, `Content-Length: ${value}\r\n`]);
  invalidHeaders.push(['duplicate-length','Content-Length: 0\r\nContent-Length: 0\r\n'],
    ['duplicate-auth',auth], ['transfer-encoding','Transfer-Encoding: chunked\r\n'],
    ['header-name','bad name: value\r\n'], ['large-header','X-Pad: '+'x'.repeat(17000)+'\r\n']);
  for (const [name, headers] of invalidHeaders) {
    const row = {name, expected:400}; evidence.framing.push(row);
    row.actual = await request(`POST /commands HTTP/1.1\r\n${auth}${headers}\r\n`);
    assert.equal(row.actual, row.expected, name);
  }
  // A second, authenticated command in the same connection must not run.
  const body = '{"command":"quit"}';
  evidence.pipelineStatus = await request('GET /health HTTP/1.1\r\n\r\n'+
    `POST /commands HTTP/1.1\r\n${auth}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.equal(evidence.pipelineStatus, 200);
  const held = []; let closed = 0;
  const started = performance.now();
  try {
    for (let i=0; i<48; ++i) {
      const socket = net.createConnection(address); held.push(socket);
      socket.on('error', () => {});
      socket.on('close', () => { closed++; });
      socket.on('connect', () => socket.write('GET /health HTTP/1.1\r\nX-Held: '));
    }
    await sleep(600);
    evidence.capacity = {opened:48, promptlyClosed:closed};
    assert(closed >= 16, 'More than 32 incomplete connections retained');
    // Trickle traffic cannot extend the absolute ten-second lifetime.
    while (performance.now()-started < 11500 && closed < 48) {
      for (const socket of held) if (!socket.destroyed) socket.write('x');
      await sleep(250);
    }
    evidence.deadline = {closed, elapsedMs:performance.now()-started};
    assert.equal(closed, 48, 'Incomplete connections outlived their deadline');
  } finally { for (const socket of held) socket.destroy(); }
  evidence.concurrent = [];
  for (let offset=0; offset<128; offset+=8) {
    const statuses = await Promise.all(Array.from({length:8}, (_,i) => request(i%2 ?
      'GET /health HTTP/1.1\r\n\r\n' :
      `POST /commands HTTP/1.1\r\n${auth}Content-Length: 1\r\n\r\n{`)));
    evidence.concurrent.push(...statuses);
    statuses.forEach((status,i) => assert.equal(status, i%2 ? 200 : 400));
  }
  evidence.healthAfter = await request('GET /health HTTP/1.1\r\n\r\n');
  assert.equal(evidence.healthAfter, 200);
  evidence.passed = true;
};
