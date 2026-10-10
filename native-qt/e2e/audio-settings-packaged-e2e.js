// Real packaged publisher -> browser: decoded channel content, bitrate, and overrides.
// Can also receive a stream started by the GUI workflow with --stream=...
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf('=');
  assert(i > 2, 'Use --name=value arguments');
  return [arg.slice(2, i), arg.slice(i + 1)];
}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(200); }
  throw Error('Timed out: ' + label);
}
async function api(discovery, route, body) {
  const control = JSON.parse(fs.readFileSync(discovery, 'utf8'));
  const response = await fetch(control.base_url + route, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000)
  });
  assert(response.ok, `Local control ${route}: ${response.status}`);
  return response.json();
}
async function receive(browser, c, dir, discovery, remoteToken, synchronize) {
  const page = await browser.newPage();
  const result = { requested: c, browserVersion: browser.version() };
  let lossCdp;
  try {
    await page.addInitScript(({ rejectRed }) => {
      window.audioReviewPeers = [];
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(target, args) {
          const pc = new target(...args);
          if (rejectRed) {
            const answer = pc.createAnswer.bind(pc);
            pc.createAnswer = async (...params) => {
              const desc = await answer(...params);
              desc.sdp = desc.sdp.split('\r\n').filter(l => !/^a=(rtpmap|fmtp|rtcp-fb):63\b/.test(l))
                .map(l => l.startsWith('m=audio ') ? l.split(' ').filter(x => x !== '63').join(' ') : l).join('\r\n');
              return desc;
            };
          }
          window.audioReviewPeers.push(pc);
          return pc;
        }
      });
    }, { rejectRed: !!c.red && !!c.fallback });
    const viewerUrl = new URL(c.viewerUrl);
    assert.equal(viewerUrl.searchParams.get('view'), c.stream);
    assert.equal(viewerUrl.searchParams.get('stereo'), c.channels === 1 ? '0' : '1');
    assert.equal(viewerUrl.searchParams.get('ab'), '510');
    viewerUrl.searchParams.set('autostart', '');
    viewerUrl.searchParams.set('muted', '');
    if (c.fallback) viewerUrl.searchParams.delete('audiocodec');
    if (opts.loss && c.bitrate === 192 && c.channels === 2 && !c.codec && !c.fallback) {
      lossCdp = await page.context().newCDPSession(page);
      await lossCdp.send('Network.enable');
      // Chrome attaches its P2P interceptor when the socket is created.
      await lossCdp.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{
        urlPattern: '', latency: 1, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 0
      }] });
    }
    await page.goto(viewerUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.audioReviewPeers.some(pc =>
      pc.connectionState === 'connected' && pc.getReceivers().some(r => r.track?.kind === 'audio')),
    null, { timeout: 40000 });
    await page.evaluate(() => {
      window.audioReviewPc = window.audioReviewPeers.find(pc => pc.connectionState === 'connected' &&
        pc.getReceivers().some(r => r.track?.kind === 'audio'));
    });
    await sleep(2000);
    result.sdp = await page.evaluate(() => ({ offer: window.audioReviewPc.remoteDescription.sdp,
      answer: window.audioReviewPc.localDescription.sdp }));
    if (opts.baseline !== 'true') {
      const cnames = [...new Set([...result.sdp.offer.matchAll(/^a=ssrc:\d+ cname:(.+)$/gm)].map(m => m[1].trim()))];
      assert.equal(cnames.length, 1, 'Audio and video must share one synchronization CNAME');
      const streams = [...new Set([...result.sdp.offer.matchAll(/(?:^a=msid:|^a=ssrc:\d+ msid:)(\S+)/gm)].map(m => m[1]))];
      assert.equal(streams.length, 1, 'Audio and video must belong to one MediaStream');
    }
    assert(result.sdp.offer.includes('opus/48000/2'), 'Opus RTP mapping must remain 48000/2, including mono');
    if (opts.baseline !== 'true') assert(result.sdp.offer.includes('sprop-stereo=' + (c.channels === 1 ? '0' : '1')));
    const pcm = c.codec === 'pcm' && !c.fallback;
    const red = !!c.red && !c.fallback;
    const audioLine = result.sdp.answer.split('\r\n').find(l => l.startsWith('m=audio'));
    assert.equal(audioLine.split(' ')[3], pcm ? '109' : red ? '63' : '111', 'Wrong negotiated audio codec');
    if (pcm) assert(result.sdp.answer.includes(c.channels === 1 ? 'L16/48000' : 'L16/32000/2'));
    if (synchronize) await synchronize('connected');

    async function measure(label, expectedBitrate) {
      const sample = await page.evaluate(async () => {
        const pc = window.audioReviewPc;
        const stats = async () => {
          const all = [...(await pc.getStats()).values()];
          const audio = all.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
          const video = all.find(s => s.type === 'inbound-rtp' && s.kind === 'video');
          return { audio, frames: video?.framesDecoded || 0 };
        };
        const before = await stats();
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const track = pc.getReceivers().find(r => r.track?.kind === 'audio').track;
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const processor = ctx.createScriptProcessor(4096, 2, 2);
        const silence = ctx.createGain(); silence.gain.value = 0;
        source.connect(processor); processor.connect(silence); silence.connect(ctx.destination);
        const left = [], right = [];
        const captured = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('No decoded PCM')), 8000);
          processor.onaudioprocess = event => {
            left.push(...event.inputBuffer.getChannelData(0));
            right.push(...event.inputBuffer.getChannelData(1));
            if (left.length >= 48000) { clearTimeout(timeout); processor.onaudioprocess = null; resolve(); }
          };
        });
        try { await captured; } finally { source.disconnect(); processor.disconnect(); await ctx.close(); }
        const amplitude = (pcm, hz) => {
          let a = 0, b = 0;
          for (let i = 0; i < pcm.length; ++i) {
            const phase = 2 * Math.PI * hz * i / 48000;
            a += pcm[i] * Math.cos(phase); b += pcm[i] * Math.sin(phase);
          }
          return 2 * Math.hypot(a, b) / pcm.length;
        };
        let difference = 0, energy = 0;
        for (let i = 0; i < left.length; ++i) {
          difference += (left[i] - right[i]) ** 2;
          energy += left[i] ** 2 + right[i] ** 2;
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
        const after = await stats();
        return { left: [amplitude(left, 440), amplitude(left, 880)],
          right: [amplitude(right, 440), amplitude(right, 880)],
          channelDifference: difference / Math.max(energy, 1e-12),
          receivedKbps: (after.audio.bytesReceived - before.audio.bytesReceived) * 8 /
            (after.audio.timestamp - before.audio.timestamp),
          framesDecoded: after.frames - before.frames, before, after };
      });
      result[label] = sample;
      assert(sample.framesDecoded > 10, 'Video playback did not advance');
      assert(Math.abs(sample.receivedKbps - expectedBitrate) < expectedBitrate * .12 + 1,
        `Received ${sample.receivedKbps} kbps; expected ${expectedBitrate}`);
      assert(sample.left[0] > .0001 && sample.right[1] > .0001, 'Missing fixture tones');
      if (c.channels === 1) {
        assert(sample.channelDifference < .001, 'Mono decoded channels differ');
        assert(sample.left[1] > .0001 && sample.right[0] > .0001, 'Mono lost one input channel');
      } else {
        assert(sample.left[0] > sample.left[1] * 5 && sample.right[1] > sample.right[0] * 5,
          'Stereo lost channel separation');
      }
      console.log(label, JSON.stringify({ kbps: sample.receivedKbps, left: sample.left, right: sample.right }));
    }
    const wireBitrate = bitrate => red ? bitrate * 2 + 8 : pcm ? (c.channels === 1 ? 768 : 1024) : bitrate;
    await measure('initial', wireBitrate(c.bitrate));
    result.senderReports = await page.evaluate(async () => [...(await window.audioReviewPc.getStats()).values()]
      .filter(s => s.type === 'remote-outbound-rtp'));
    if (opts.baseline !== 'true') {
      for (const kind of ['audio', 'video']) assert(result.senderReports.some(s =>
        (s.kind || s.mediaType) === kind && s.reportsSent > 0), 'Missing actual RTCP sender reports for ' + kind);
    }
    result.diagnostics = await api(discovery, '/diagnostics');
    if (opts.baseline !== 'true') {
      assert.equal(result.diagnostics.audio.preferred_opus_bitrate_kbps, c.bitrate);
      assert.equal(result.diagnostics.audio.output_channels, c.channels);
    }
    if (synchronize) await synchronize('measured');
    if (remoteToken && !pcm) {
      async function send(bitrate, token) {
        assert(await page.evaluate(({ bitrate, token }) => {
          const session = window.session;
          const uuid = Object.keys(session.rpcs || {})[0];
          return !!session.sendRequest({ targetAudioBitrate: bitrate, remote: token }, uuid);
        }, { bitrate, token }), 'Could not send remote control');
      }
      await send(96, 'incorrect-token');
      await sleep(500);
      assert.equal((await api(discovery, '/diagnostics')).audio.configured_opus_bitrate_kbps, c.bitrate);
      await send(96, remoteToken);
      await until(async () => (await api(discovery, '/diagnostics')).audio.configured_opus_bitrate_kbps === 96,
        'remote bitrate override');
      await sleep(800);
      await measure('override', wireBitrate(96));
      await send(false, remoteToken);
      await until(async () => (await api(discovery, '/diagnostics')).audio.configured_opus_bitrate_kbps === c.bitrate,
        'restore selected bitrate');
      await sleep(800);
      await measure('restored', wireBitrate(c.bitrate));
    }
    if (lossCdp) {
      const cdp = lossCdp;
      const snapshot = () => page.evaluate(async () => [...(await window.audioReviewPc.getStats()).values()]
        .find(s => s.type === 'inbound-rtp' && s.kind === 'audio'));
      try {
        await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{
          urlPattern: '', latency: 0, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 10
        }] });
        await sleep(3000);
        const before = await snapshot();
        await sleep(10000);
        const after = await snapshot();
        result.loss = { before, after,
          packetsLost: after.packetsLost - before.packetsLost,
          concealedFraction: (after.concealedSamples - before.concealedSamples) /
            (after.totalSamplesReceived - before.totalSamplesReceived) };
        assert(result.loss.packetsLost > 10, 'Packet loss was not actually applied');
        console.log('loss', JSON.stringify({ red, packetsLost: result.loss.packetsLost,
          concealedFraction: result.loss.concealedFraction }));
      } finally {
        await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [] });
        await cdp.detach();
      }
    }
    await page.screenshot({ path: path.join(dir, 'receiver.png') });
    result.ok = true;
    return result;
  } catch (error) {
    result.ok = false;
    result.error = String(error);
    await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(dir, 'receiver.json'), JSON.stringify(result, null, 2));
    await page.close();
  }
}
async function main() {
  assert(opts.output, '--output is required');
  const output = path.resolve(opts.output);
  fs.mkdirSync(output, { recursive: true });
  const children = [], logStreams = [];
  const launch = (exe, args, name, env = {}) => {
    const log = fs.createWriteStream(path.join(output, name + '.log')); logStreams.push(log);
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true,
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    children.push(child); child.on('error', error => { child.launchError = error; });
    child.closed = new Promise(resolve => child.once('close', resolve));
    return child;
  };
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    if (opts.stream) {
      await receive(browser, { stream: opts.stream, bitrate: Number(opts.bitrate), channels: Number(opts.channels),
        viewerUrl: opts['viewer-url'], codec: opts.codec || 'opus', red: opts.red === 'true' },
        output, opts.discovery, opts['remote-token']);
      return;
    }
    const publisher = path.resolve(opts.publisher), sender = path.resolve(opts.sender);
    assert(!opts.only || ['boundaries', 'experimental', 'simultaneous'].includes(opts.only), 'Unknown --only selection');
    assert(fs.existsSync(path.join(path.dirname(publisher), 'platforms/qwindows.dll')), 'Complete package required');
    const results = { publisher, browser: 'Google Chrome', browserVersion: browser.version(),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(publisher)).digest('hex'), cases: [] };
    results.invalidArguments = [];
    for (const argument of ['--audio-bitrate-kbps=5', '--audio-bitrate-kbps=511',
      '--audio-bitrate-kbps=abc', '--audio-channels=6', '--audio-codec=invalid']) {
      const invalid = spawnSync(publisher, [argument], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
      results.invalidArguments.push({ argument, exitCode: invalid.status });
      assert.equal(invalid.status, 2, 'Invalid audio argument must fail before capture: ' + argument);
    }
    const tone = launch('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'audio-test-tone.ps1'),
        '-DurationMs', '600000', '-RightFrequencyHz', '880', '-Amplitude', '0.08'], 'tone');
    await until(() => fs.existsSync(path.join(output, 'tone.log')) &&
      fs.readFileSync(path.join(output, 'tone.log'), 'utf8').includes('AUDIO_TEST_TONE_READY'), 'audio fixture');
    const cases = opts.only === 'simultaneous' ? [
      { bitrate: 192, channels: 2, codec: 'pcm' }, { bitrate: 192, channels: 1, codec: 'pcm' },
      { bitrate: 192, channels: 2, red: true }, { bitrate: 64, channels: 1, red: true }
    ] : opts.only === 'boundaries' ? [
      { bitrate: 6, channels: 1 }, { bitrate: 6, channels: 2 }, { bitrate: 510, channels: 2 },
      { bitrate: 6, channels: 1, red: true }, { bitrate: 6, channels: 2, red: true }
    ] : [
      { bitrate: 64, channels: 1 }, { bitrate: 192, channels: 2 }, { bitrate: 320, channels: 2 },
      { bitrate: 192, channels: 1, codec: 'pcm' }, { bitrate: 192, channels: 2, codec: 'pcm' },
      { bitrate: 192, channels: 2, red: true }, { bitrate: 64, channels: 1, red: true },
      { bitrate: 510, channels: 2, red: true },
      { bitrate: 192, channels: 2, codec: 'pcm', fallback: true },
      { bitrate: 192, channels: 2, red: true, fallback: true }
    ];
    for (const c of cases.filter(c => !opts.only || ['boundaries', 'simultaneous'].includes(opts.only) || (opts.only === 'experimental' && (c.codec || c.red)))) {
      const id = `${c.codec || 'opus'}-${c.bitrate}-${c.channels}${c.red ? '-red' : ''}${c.fallback ? '-fallback' : ''}`, dir = path.join(output, id);
      fs.mkdirSync(dir); c.stream = 'audioreview' + crypto.randomBytes(8).toString('hex');
      const discovery = path.join(dir, 'control.json'), token = crypto.randomBytes(12).toString('hex');
      const fixture = launch(sender, [`--name=${c.stream}`, '--width=640', '--height=360', '--fps=30',
        '--duration-ms=120000'], 'source-' + id);
      await sleep(1500);
      const app = launch(publisher, ['--headless', `--stream=${c.stream}`, '--password=false', '--source=spout',
        `--spout-sender=${c.stream}`, '--resolution=640x360', '--fps=30', '--audio-source=default-output',
        `--audio-bitrate-kbps=${c.bitrate}`, `--audio-channels=${c.channels}`, '--remote-control',
        `--audio-codec=${c.codec || 'opus'}`, ...(c.red ? ['--audio-red'] : []),
        `--remote-token=${token}`, '--duration-ms=110000', '--local-control',
        `--local-control-discovery=${discovery}`], 'publisher-' + id, { LOCALAPPDATA: dir });
      try {
        await until(async () => {
          if (app.launchError) throw app.launchError;
          assert(app.exitCode === null, 'Publisher exited early');
          assert(tone.exitCode === null, 'Tone fixture exited early');
          return fs.existsSync(discovery) && (await api(discovery, '/diagnostics')).app.live;
        }, 'live publisher');
        await until(() => {
          const log = fs.readFileSync(path.join(output, 'publisher-' + id + '.log'), 'utf8');
          c.viewerUrl = log.match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1];
          return !!c.viewerUrl;
        }, 'publisher viewer link');
        if (opts.only === 'simultaneous') {
          const barriers = new Map();
          const synchronize = label => {
            if (!barriers.has(label)) {
              let resolve;
              const promise = new Promise(r => { resolve = r; });
              barriers.set(label, { arrived: 0, promise, resolve });
            }
            const barrier = barriers.get(label);
            if (++barrier.arrived === 2) barrier.resolve();
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(Error('Concurrent receiver barrier timed out: ' + label)), 30000);
              barrier.promise.then(() => { clearTimeout(timer); resolve(); });
            });
          };
          const receivers = [false, true].map(fallback => {
            const receiverDir = path.join(dir, fallback ? 'fallback' : 'preferred');
            fs.mkdirSync(receiverDir);
            return { requested: { ...c, fallback }, dir: receiverDir };
          });
          // Both real receivers stay connected through both decoded measurements.
          // Do not run competing director bitrate overrides in this comparison.
          const settled = await Promise.allSettled(receivers.map(r =>
            receive(browser, r.requested, r.dir, discovery, undefined, synchronize)));
          for (let i = 0; i < settled.length; i++) {
            const value = settled[i], receiver = receivers[i];
            const saved = path.join(receiver.dir, 'receiver.json');
            results.cases.push(value.status === 'fulfilled' ? value.value :
              fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) :
              { requested: receiver.requested, ok: false, error: String(value.reason) });
          }
        } else results.cases.push(await receive(browser, c, dir, discovery, token));
      } catch (error) {
        // Retain failed quality measurements and finish the matrix so one
        // degraded boundary setting cannot hide the other codec results.
        const saved = path.join(dir, 'receiver.json');
        results.cases.push(fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) :
          { requested: c, ok: false, error: String(error) });
        console.error(id, String(error));
      } finally {
        if (app.exitCode === null && fs.existsSync(discovery)) await api(discovery, '/commands', { command: 'quit' }).catch(() => {});
        await Promise.race([app.closed, sleep(5000)]);
        if (app.exitCode === null) app.kill();
        fixture.kill();
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      }
    }
    if (opts.loss && !opts.only) {
      const plain = results.cases.find(c => c.loss && !c.requested.red);
      const protectedAudio = results.cases.find(c => c.loss && c.requested.red);
      assert(protectedAudio.loss.concealedFraction < plain.loss.concealedFraction * .7,
        'RED did not materially reduce audio concealment under packet loss');
      results.lossComparisonPassed = true;
    }
    results.ok = results.cases.every(c => c.ok);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    assert(results.ok, 'Playback quality failures; inspect the complete matrix results');
  } finally {
    await browser.close();
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.closed));
    for (const log of logStreams) log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
