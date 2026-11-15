// Packaged Windows process capture -> real Chrome: six-channel and stereo peers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const opts = Object.fromEntries(process.argv.slice(2).map(v => {
  const i = v.indexOf('='); return [v.slice(2, i), v.slice(i + 1)];
}));
const publisher = path.resolve(opts.publisher);
const output = path.resolve(opts.output);
const toneProfile = opts['tone-profile'] || 'surround';
const reconnectCycles = Number(opts['reconnect-cycles'] || 0);
assert(Number.isInteger(reconnectCycles) && reconnectCycles >= 0 && reconnectCycles <= 10, 'Reconnect cycles must be 0..10');
assert(!reconnectCycles || opts.hosted === 'true', 'Reconnect journeys require the hosted viewer');
const frequencies = require('./six-channel-tone-profiles.json')[toneProfile];
assert(Array.isArray(frequencies), 'Unknown tone profile');
assert(toneProfile === 'surround' || opts['synthetic-capture'] === 'true', 'Voice profile requires synthetic capture');
fs.mkdirSync(output, { recursive: true });
assert(fs.existsSync(path.join(path.dirname(publisher), 'platforms/qwindows.dll')), 'Complete package required');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await wait(100); }
  throw Error('Timed out: ' + label);
}
const children = [], logs = [];
function launch(file, args, name) {
  const log = fs.openSync(path.join(output, name + '.log'), 'w'); logs.push(log);
  const child = spawn(file, args, { cwd: path.dirname(file), windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: output, GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING: '1', GC_AUDIO_TEST_PROFILE: toneProfile },
    stdio: ['ignore', log, log] });
  child.on('error', error => { child.launchError = error; });
  child.closed = new Promise(resolve => child.on('close', resolve));
  children.push(child); return child;
}
let browser, signal, server, app;
const hosted = opts.hosted === 'true';
const streamId = 'sixchannel' + crypto.randomBytes(8).toString('hex');
const report = { publisher, sha256: crypto.createHash('sha256').update(fs.readFileSync(publisher)).digest('hex'), receivers: [] };
report.syntheticCapture = opts['synthetic-capture'] === 'true';
report.hostedVdoNinja = hosted;
report.toneProfile = toneProfile;
report.frequencies = frequencies;
report.reconnects = [];
async function api(route, body) {
  const info = JSON.parse(fs.readFileSync(path.join(output, 'control.json')));
  const r = await fetch(info.base_url + route, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  assert(r.ok); return r.json();
}
(async () => {
  try {
    server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Six-channel receiver</title>'); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    signal = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(r => signal.on('listening', r));
    let socket;
    const events = [];
    signal.on('connection', ws => { socket = ws; ws.on('message', data => events.push(JSON.parse(data.toString()))); });
    const source = launch(opts.python || 'python',
      [path.join(__dirname, 'six-channel-source.py')], 'source');
    await until(() => { assert(source.exitCode === null, 'Source exited');
      return fs.readFileSync(path.join(output, 'source.log'), 'utf8').includes('SIX_CHANNEL_SOURCE_READY'); }, 'source');
    const appArgs = ['--headless', '--source=window', '--window=Game Capture Six Channel Source',
      '--audio-source=selected-window', '--audio-channels=6', '--audio-bitrate-kbps=384', '--no-audio-red',
      '--resolution=640x360', '--fps=30', '--video-encoder=software', `--stream=${streamId}`, '--password=false',
      ...(hosted ? [] : [`--server=ws://127.0.0.1:${signal.address().port}`]), '--ice-mode=host', `--duration-ms=${Math.max(120000, 60000 + reconnectCycles * 60000)}`,
      '--local-control', `--local-control-discovery=${path.join(output, 'control.json')}`];
    app = report.syntheticCapture
      ? launch(path.resolve(__dirname, '../.cache/desktop-ui-python/Scripts/python.exe'),
          [path.join(__dirname, 'six-channel-instrumented-launch.py'), publisher, ...appArgs], 'publisher')
      : launch(publisher, appArgs, 'publisher');
    await until(() => { assert(app.exitCode === null, 'Publisher exited');
      return hosted ? fs.readFileSync(path.join(output, 'publisher.log'), 'utf8').includes('[App] VIEW URL:')
        : socket && events.some(e => e.request === 'seed'); }, 'publisher signaling');
    if (report.syntheticCapture) await until(() => fs.readFileSync(path.join(output, 'publisher.log'), 'utf8')
      .includes('synthetic-six-channel-capture'), 'synthetic capture attached');
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    report.browser = browser.version();
    const peers = [];
    async function connectHosted(six, label, existingPage) {
      const page = existingPage || await browser.newPage();
      if (!existingPage) await page.addInitScript(() => {
        window.reviewPeers = [];
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(target, args) {
          const pc = new target(...args); window.reviewPeers.push(pc); return pc;
        } });
      });
      const link = fs.readFileSync(path.join(output, 'publisher.log'), 'utf8').match(/\[App\] VIEW URL: (https:\/\/\S+)/)[1];
      const url = new URL(link); assert.equal(url.searchParams.get('stereo'), '4');
      if (!six) url.searchParams.set('stereo', '1');
      url.searchParams.set('autostart', ''); url.searchParams.set('muted', '');
      if (existingPage) await page.reload({ waitUntil: 'domcontentloaded' });
      else await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.reviewPeers.some(p => p.connectionState === 'connected' &&
        p.getReceivers().some(r => r.track.kind === 'audio')), null, { timeout: 40000 });
      await page.evaluate(() => { window.pc = window.reviewPeers.find(p => p.connectionState === 'connected' &&
        p.getReceivers().some(r => r.track.kind === 'audio')); });
      const sdp = await page.evaluate(() => ({ offer: pc.remoteDescription.sdp, answer: pc.localDescription.sdp }));
      fs.writeFileSync(path.join(output, label + '-offer.sdp'), sdp.offer);
      fs.writeFileSync(path.join(output, label + '-answer.sdp'), sdp.answer);
      return { page, six };
    }
    for (const six of [true, false]) {
      const uuid = six ? 'sixchannelreceiver' : 'stereoreceiver';
      if (hosted) {
        peers.push(await connectHosted(six, uuid)); continue;
      }
      socket.send(JSON.stringify({ request: 'offerSDP', UUID: uuid, streamID: streamId }));
      await until(() => events.some(e => e.UUID === uuid && e.description?.type === 'offer'), 'offer ' + uuid);
      const offer = events.find(e => e.UUID === uuid && e.description?.type === 'offer');
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const answer = await page.evaluate(async ({ offer, six, native }) => {
        const pc = window.pc = new RTCPeerConnection({ iceServers: [] });
        pc.ontrack = e => { if (e.track.kind === 'audio') {
          const audio = document.createElement('audio'); audio.autoplay = true;
          audio.srcObject = new MediaStream([e.track]); audio.muted = true;
          document.body.appendChild(audio); audio.play();
        } };
        window.candidates = []; pc.onicecandidate = e => { if (e.candidate) window.candidates.push(e.candidate.toJSON()); };
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        if (six && native) {
          answer.sdp = answer.sdp.replace(/(m=audio .+?UDP\/TLS\/RTP\/SAVPF) /, '$1 112 ')
            .replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:112 multiopus/48000/6\r\na=fmtp:112 channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2\r\na=rtpmap:111 opus/48000/2');
        } else if (six) {
          answer.sdp = answer.sdp.replace('opus/48000/2', 'multiopus/48000/6')
            .replace(/(a=fmtp:111[^\r\n]*)/, '$1;channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2');
        } else answer.sdp = answer.sdp.replace(/(a=fmtp:111[^\r\n]*)/, '$1;stereo=1');
        await pc.setLocalDescription(answer);
        return pc.localDescription;
      }, { offer: offer.description, six, native: opts['native-multiopus'] === 'true' });
      socket.send(JSON.stringify({ UUID: uuid, streamID: streamId, session: offer.session, description: answer }));
      const forwarded = new Set(); let sent = 0;
      await until(async () => {
        for (let i = 0; i < events.length; ++i) {
          const e = events[i];
          if (e.UUID === uuid && e.candidate && !forwarded.has(i)) {
            await page.evaluate(c => pc.addIceCandidate(c), e.candidate); forwarded.add(i);
          }
        }
        const candidates = await page.evaluate(() => window.candidates);
        while (sent < candidates.length) socket.send(JSON.stringify({ UUID: uuid, session: offer.session, candidate: candidates[sent++] }));
        return page.evaluate(() => pc.connectionState === 'connected');
      }, 'connected ' + uuid);
      peers.push({ page, six });
      fs.writeFileSync(path.join(output, uuid + '-offer.sdp'), offer.description.sdp);
      fs.writeFileSync(path.join(output, uuid + '-answer.sdp'), answer.sdp);
    }
    await wait(2000);
    async function measureReceiver({ page, six }, phase) {
      const result = await page.evaluate(async frequencies => {
        const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume();
        const track = pc.getReceivers().find(r => r.track.kind === 'audio').track;
        let rawChannels = [];
        const rawSamples = [];
        let reader;
        if (typeof MediaStreamTrackProcessor !== 'undefined') {
          try {
            reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
            (async () => { while (reader) { const next = await reader.read(); if (next.done) break;
              if (!rawChannels.includes(next.value.numberOfChannels)) rawChannels.push(next.value.numberOfChannels);
              for (let ch = 0; ch < next.value.numberOfChannels; ++ch) {
                const plane = new Float32Array(next.value.numberOfFrames);
                next.value.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
                rawSamples[ch] ||= []; rawSamples[ch].push(...plane);
              }
              next.value.close(); } })().catch(() => {});
          } catch (_) {}
        }
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const code = `class Capture extends AudioWorkletProcessor { process(inputs) { if(inputs[0].length) this.port.postMessage(inputs[0].map(c=>Array.from(c))); return true; } } registerProcessor('capture',Capture);`;
        const blob = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(blob); URL.revokeObjectURL(blob);
        const node = new AudioWorkletNode(ctx, 'capture', { channelCountMode: 'max', channelInterpretation: 'discrete' });
        const mute = ctx.createGain(); mute.gain.value = 0;
        source.connect(node); node.connect(mute); mute.connect(ctx.destination);
        const samples = [];
        node.port.onmessage = e => { for (let ch = 0; ch < e.data.length; ++ch) { samples[ch] ||= []; samples[ch].push(...e.data[ch]); } };
        await new Promise(r => setTimeout(r, 3000));
        source.disconnect(); await ctx.close();
        if (reader) { await reader.cancel(); reader = null; }
        const measure = audio => audio.map(s => frequencies.map(f => {
          let real = 0, imag = 0;
          for (let i = 0; i < s.length; ++i) { real += s[i] * Math.cos(2 * Math.PI * f * i / 48000); imag += s[i] * Math.sin(2 * Math.PI * f * i / 48000); }
          return 2 * Math.hypot(real, imag) / s.length;
        }));
        const matrix = measure(rawSamples), webAudioMatrix = measure(samples);
        const stats = [...(await pc.getStats()).values()];
        const inbound = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
        return { channels: rawSamples.length, rawChannels, frames: rawSamples[0]?.length, matrix, webAudioMatrix, inbound,
          codec: stats.find(s => s.id === inbound?.codecId), packetsReceived: inbound?.packetsReceived };
      }, frequencies);
      report.receivers.push({ phase, six, ...result });
      console.log(JSON.stringify({ phase, six, channels: result.channels, codec: result.codec?.mimeType }));
      report.audio = (await api('/diagnostics')).audio;
      assert.equal(result.channels, six ? 6 : 2, 'Decoded channel count');
      assert(result.frames > 96000 && result.packetsReceived > 100, 'Sustained audio');
      if (six && opts['stereo-endpoint'] === 'true') {
        assert(result.matrix[0][0] > .005 && result.matrix[1][1] > .005, 'Real endpoint audio');
        for (const row of result.matrix.slice(2)) assert(row.every(v => v < .001), 'Unused channels must be silent');
      } else if (six) for (let ch = 0; ch < 6; ++ch) {
        assert(result.matrix[ch][ch] > .005, 'Missing source channel ' + ch);
        for (let other = 0; other < 6; ++other) if (other !== ch)
          assert(result.matrix[ch][other] < result.matrix[ch][ch] * .1, `Crosstalk ${other} -> ${ch}`);
      }
      else {
        assert(result.matrix.every(row => row.some(v => v > .005)), 'Stereo fallback is audible');
        if (report.syntheticCapture) for (let ch = 0; ch < 6; ++ch)
          assert(Math.max(...result.matrix.map(row => row[ch])) > .003, 'Stereo fallback lost source channel ' + ch);
      }
    }
    for (const peer of peers) await measureReceiver(peer, 'initial');
    for (let cycle = 0; cycle < reconnectCycles; ++cycle) {
      const departingIndex = cycle % 2, staying = peers[1 - departingIndex], departing = peers[departingIndex];
      const action = cycle % 3 === 2 ? 'reload' : 'close-and-rejoin';
      const label = `reconnect-${cycle + 1}-${departing.six ? 'six' : 'stereo'}`;
      await staying.page.evaluate(async () => {
        const track = pc.getReceivers().find(r => r.track.kind === 'audio').track.clone();
        const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        const stats = [...(await pc.getStats()).values()];
        const inbound = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
        const watch = window.continuity = { track, reader, running: true, frames: 0, silentFrames: 0,
          channels: [], maxGapMs: 0, packetsBefore: inbound.packetsReceived, last: performance.now() };
        watch.done = (async () => {
          while (watch.running) {
            const { value, done } = await reader.read(); if (done) break;
            const now = performance.now(); watch.maxGapMs = Math.max(watch.maxGapMs, now - watch.last); watch.last = now;
            if (!watch.channels.includes(value.numberOfChannels)) watch.channels.push(value.numberOfChannels);
            let energy = 0;
            for (let ch = 0; ch < value.numberOfChannels; ++ch) {
              const samples = new Float32Array(value.numberOfFrames);
              value.copyTo(samples, { planeIndex: ch, format: 'f32-planar' });
              for (const sample of samples) energy += sample * sample;
            }
            watch.frames += value.numberOfFrames;
            if (energy / (value.numberOfFrames * value.numberOfChannels) < 1e-10) watch.silentFrames += value.numberOfFrames;
            value.close();
          }
        })();
      });
      if (action === 'close-and-rejoin') { await departing.page.close(); await wait(1000); }
      peers[departingIndex] = await connectHosted(departing.six, label, action === 'reload' ? departing.page : undefined);
      await wait(2000);
      const continuity = await staying.page.evaluate(async () => {
        const w = window.continuity;
        w.running = false; await w.reader.cancel(); await w.done; w.track.stop();
        const stats = [...(await pc.getStats()).values()];
        const inbound = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
        return { frames: w.frames, silentFrames: w.silentFrames, channels: w.channels, maxGapMs: w.maxGapMs,
          packetsBefore: w.packetsBefore, packetsAfter: inbound.packetsReceived, connectionState: pc.connectionState };
      });
      report.reconnects.push({ cycle: cycle + 1, action, rejoinedSix: departing.six, stayingSix: staying.six, continuity });
      assert.equal(continuity.connectionState, 'connected', 'Other viewer disconnected');
      assert.deepEqual(continuity.channels, [staying.six ? 6 : 2], 'Other viewer channel count changed');
      assert(continuity.frames > 96000 && continuity.packetsAfter - continuity.packetsBefore > 100, 'Other viewer stopped receiving');
      assert(continuity.maxGapMs < 1000, 'Other viewer audio stalled for a second');
      assert(continuity.silentFrames < continuity.frames * .01, 'Other viewer audio went silent');
      for (const peer of peers) await measureReceiver(peer, label);
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ cycle: cycle + 1, action, stayingSix: staying.six, maxGapMs: continuity.maxGapMs }));
    }
    report.audio = (await api('/diagnostics')).audio;
    report.ok = true;
    report.stereoEndpoint = opts['stereo-endpoint'] === 'true';
  } catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if (app?.exitCode === null) await api('/commands', { command: 'quit' }).catch(() => {});
    if (app) await Promise.race([app.closed, wait(15000)]);
    report.cleanExit = app?.exitCode === 0;
    if (report.ok && !report.cleanExit) { report.ok = false; report.error = 'Publisher did not exit cleanly'; process.exitCode = 1; }
    if (browser) await browser.close();
    for (const child of children) if (child.exitCode === null && child.pid)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    for (const log of logs) fs.closeSync(log);
    if (signal) { for (const ws of signal.clients) ws.terminate(); await new Promise(r => signal.close(r)); }
    if (server) await new Promise(r => server.close(r));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    if (report.error) console.error(report.error);
  }
})();
