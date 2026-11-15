'use strict';

// Real packaged publisher -> deployed VDO.Ninja -> Chrome. No receiver code replacement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  assert(arg.startsWith('--') && index > 2, 'Use --name=value arguments');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
assert(options.publisher && options.sender && options.output, '--publisher, --sender and --output are required');
const publisher = path.resolve(options.publisher), sender = path.resolve(options.sender);
const output = path.resolve(options.output);
const width = Number(options.width || 1280), height = Number(options.height || 720);
const fps = Number(options.fps || 60);
const frontend = options.frontend || 'https://vdo.ninja/alpha/';
const encoder = options.encoder || 'nvenc';
assert(fs.existsSync(path.join(path.dirname(publisher), 'platforms/qwindows.dll')), 'Complete Windows package required');
fs.mkdirSync(output, { recursive: true });
assert(!fs.existsSync(path.join(output, 'report.json')), 'Use a fresh evidence directory');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { passed: false, frontend, publisher, publisherSha256: sha256(publisher), sender,
  senderSha256: sha256(sender), width, height, fps, encoder, stages: [], browserErrors: [] };
const children = [];
let browser, page, app, source;
const stream = 'alpha' + crypto.randomBytes(8).toString('hex');
const sourceName = 'AlphaReview' + crypto.randomBytes(6).toString('hex');
const discovery = path.join(output, 'control.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2));
async function until(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(200); }
  throw Error('Timed out: ' + label);
}
function launch(file, args, label) {
  const log = fs.openSync(path.join(output, label + '.log'), 'w');
  const child = spawn(file, args, { cwd: path.dirname(file), windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: output, GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING: '1' },
    stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.on('error', error => { child.launchError = error; });
  child.closed = new Promise(resolve => child.once('close', resolve));
  children.push(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([child.closed, sleep(5000)]);
}
async function api(route, body) {
  const info = JSON.parse(fs.readFileSync(discovery, 'utf8'));
  const response = await fetch(info.base_url + route, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, 'Local API returned ' + response.status);
  return response.json();
}
async function replaceSource(pattern, sourceWidth = width, sourceHeight = height) {
  await stop(source);
  await sleep(600);
  source = launch(sender, ['--name=' + sourceName, '--width=' + sourceWidth, '--height=' + sourceHeight,
    '--fps=' + fps, '--pattern=' + pattern, '--duration-ms=600000'], 'source-' + report.stages.length);
  await sleep(2000);
  assert(!source.launchError && source.exitCode === null, 'Spout source failed to start');
}
async function sample() {
  return page.evaluate(async () => {
    if (!window.session?.rpcs) return null;
    const entry = Object.entries(session.rpcs).find(([, peer]) => peer.packedAlpha);
    if (!entry) return null;
    const [id, peer] = entry, state = peer.packedAlpha, video = peer.videoElement;
    const stats = [...(await peer.getStats()).values()];
    const inbound = stats.find(s => s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video'));
    const result = { id, ready: state.ready, failed: state.failed, mid: state.mid,
      hidden: video?.classList.contains('packed-alpha-source-hidden'),
      videoWidth: video?.videoWidth, videoHeight: video?.videoHeight, time: video?.currentTime,
      frames: inbound?.framesDecoded || 0, timestamp: inbound?.timestamp || performance.now(),
      renderedFrames: window.reviewPackedDraws,
      codec: stats.find(s => s.id === inbound?.codecId)?.mimeType,
      videoTracks: peer.getReceivers().filter(r => r.track.kind === 'video').length };
    const rendered = getRenderedRemoteElement(id);
    if (!rendered) return result;
    const canvas = document.createElement('canvas');
    canvas.width = rendered.width; canvas.height = rendered.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(rendered, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let zero = 0, half = 0, full = 0, alphaSum = 0, weightedX = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      const alpha = pixels[i];
      if (alpha < 8) zero++;
      if (alpha >= 116 && alpha <= 140) half++;
      if (alpha > 247) full++;
      alphaSum += alpha; weightedX += ((i - 3) / 4 % canvas.width) * alpha;
    }
    const count = pixels.length / 4;
    return { ...result, width: canvas.width, height: canvas.height, zero: zero / count,
      half: half / count, full: full / count, meanAlpha: alphaSum / count,
      centroidX: alphaSum ? weightedX / alphaSum : null,
      center: [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data], png: canvas.toDataURL() };
  });
}
function checkPixels(s, pattern) {
  if (!s?.ready || s.failed || !s.hidden || s.width !== width || s.height !== height) return false;
  if (pattern === 'alpha-opaque') return s.full > .99;
  if (pattern === 'alpha-half') return s.half > .99;
  if (pattern === 'alpha-checker') return s.zero > .4 && s.full > .4;
  if (pattern === 'alpha-moving-edge') return s.zero > .85 && s.full > .06;
  return false;
}
async function stage(label, pattern) {
  await until(async () => checkPixels(await sample(), pattern), label + ' expected transparency');
  const first = await sample(); await sleep(2500); const last = await sample();
  assert(checkPixels(last, pattern), label + ': alpha pixels changed unexpectedly');
  assert(last.frames > first.frames + 10 && last.time > first.time + 1, label + ': playback did not advance');
  // getRenderedRemoteElement takes a fresh snapshot. Independently require the
  // page's normal scheduler to draw between snapshots, so sampling cannot hide a frozen canvas.
  assert(last.renderedFrames > first.renderedFrames + 10, label + ': canvas scheduler did not advance');
  assert.equal(last.codec?.toLowerCase(), 'video/h264');
  assert.equal(last.videoTracks, 1, 'Packed alpha must use one video track');
  assert.equal(last.videoWidth, width * 2); assert.equal(last.videoHeight, height);
  if (pattern === 'alpha-moving-edge') assert(Math.abs(last.centroidX - first.centroidX) > 2, 'Image did not move');
  if (pattern === 'alpha-half' || pattern === 'alpha-opaque') {
    for (const [index, expected] of [32, 96, 255].entries()) {
      assert(Math.abs(last.center[index] - expected) < 16, 'Straight RGB changed during alpha reconstruction');
    }
  }
  fs.writeFileSync(path.join(output, label + '-rgba.png'), Buffer.from(last.png.split(',')[1], 'base64'));
  delete first.png; delete last.png;
  await page.evaluate(() => {
    for (const peer of Object.values(session.rpcs)) {
      for (let el = peer.packedAlpha?.canvas?.parentElement; el; el = el.parentElement) el.style.background = 'transparent';
    }
    document.body.style.background = 'repeating-conic-gradient(#eee 0% 25%,#888 0% 50%) 0 0 / 32px 32px';
  });
  await page.screenshot({ path: path.join(output, label + '-checker.png') });
  report.stages.push({ label, pattern, passed: true, first, last,
    decodedFps: (last.frames - first.frames) * 1000 / (last.timestamp - first.timestamp) });
  save('report.json', report); console.log('PASS ' + label);
}

(async () => {
  try {
    await replaceSource('alpha-half');
    app = launch(publisher, ['--headless', '--source=spout', '--spout-sender=' + sourceName,
      '--audio-source=none', '--resolution=' + width + 'x' + height, '--fps=' + fps,
      '--video-codec=h264', '--video-encoder=' + encoder, '--browser-alpha', '--stream=' + stream,
      '--password=false', '--duration-ms=600000', '--local-control', '--local-control-port=0',
      '--local-control-discovery=' + discovery], 'publisher');
    await until(() => {
      assert(!app.launchError && app.exitCode === null, 'Publisher exited');
      return fs.existsSync(discovery) && fs.readFileSync(path.join(output, 'publisher.log'), 'utf8').includes('[App] VIEW URL:');
    }, 'publisher signaling');
    const generatedLink = fs.readFileSync(path.join(output, 'publisher.log'), 'utf8').match(/\[App\] VIEW URL: (https:\/\/\S+)/)[1];
    report.generatedLink = generatedLink;
    const url = new URL(frontend); url.search = new URL(generatedLink).search;
    for (const flag of ['autostart', 'cleanoutput', 'transparent', 'muted']) url.searchParams.set(flag, '');
    url.searchParams.set('salt', 'vdo.ninja'); report.viewerUrl = url.href;
    browser = await chromium.launch({ channel: options.browser || 'chrome', headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    report.browser = browser.version();
    page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript(() => {
      window.reviewPackedDraws = 0;
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (...args) {
        const result = draw.apply(this, args);
        if (this.canvas.id.startsWith('packedalpha_')) window.reviewPackedDraws++;
        return result;
      };
    });
    page.on('pageerror', error => report.browserErrors.push(String(error)));
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await stage('half', 'alpha-half');
    for (const pattern of ['alpha-opaque', 'alpha-checker', 'alpha-moving-edge']) {
      await replaceSource(pattern); await stage(pattern, pattern);
    }
    await replaceSource('alpha-half', 1920, 1080); await stage('source-resize', 'alpha-half');
    await page.reload({ waitUntil: 'domcontentloaded' }); await stage('reload', 'alpha-half');
    const beforeRefresh = await api('/diagnostics');
    report.refreshRequest = await api('/commands', { command: 'refresh_peer_transports' });
    assert(report.refreshRequest.accepted_peer_count > 0);
    await until(async () => {
      const current = await api('/diagnostics');
      return current.peers.some(peer => beforeRefresh.peers.some(old => old.uuid === peer.uuid &&
        peer.signaling.client_transport_generation > old.signaling.client_transport_generation) &&
        peer.media.packed_alpha_ready_generation === peer.signaling.active_transport_generation);
    }, 'replacement transport acknowledges packed alpha');
    await stage('transport-refresh', 'alpha-half');
    report.refreshedDiagnostics = await api('/diagnostics');
    await page.evaluate(() => {
      const peer = Object.values(session.rpcs).find(p => p.packedAlpha);
      const extension = peer.packedAlpha.renderer.gl.getExtension('WEBGL_lose_context');
      if (!extension) throw Error('WebGL context-loss control unavailable');
      extension.loseContext();
    });
    await until(async () => (await sample())?.failed, 'WebGL loss withdraws readiness');
    await sleep(1000); const lostBefore = await sample(); await sleep(2000);
    report.contextLoss = await sample();
    assert(!report.contextLoss.ready && report.contextLoss.hidden && !report.contextLoss.png);
    assert(report.contextLoss.frames - lostBefore.frames < 3, 'Sender continued video after WebGL loss');
    await page.reload({ waitUntil: 'domcontentloaded' }); await stage('reload-after-context-loss', 'alpha-half');
    report.diagnostics = await api('/diagnostics');
    assert(report.diagnostics.video.packed_alpha, 'Publisher is not in packed-alpha mode');
    assert.equal(report.diagnostics.metrics.packed_alpha_waiting_peers, 0);
    // A real unsupported layout must decline readiness, leaving the carrier hidden and unsent.
    await page.goto(url.href + '&manual', { waitUntil: 'domcontentloaded' });
    await until(async () => (await sample())?.failed, 'unsupported viewer declines');
    await sleep(6500);
    report.unsupported = await sample();
    assert(!report.unsupported.ready && report.unsupported.hidden && report.unsupported.frames === 0);
    report.unsupportedDiagnostics = await api('/diagnostics');
    assert(report.unsupportedDiagnostics.metrics.packed_alpha_waiting_peers >= 1);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' }); await stage('reconnect-after-decline', 'alpha-half');
    report.passed = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1; console.error(error.stack);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    if (fs.existsSync(discovery)) report.failureDiagnostics = await api('/diagnostics').catch(() => null);
  } finally {
    await browser?.close().catch(() => {});
    if (app?.exitCode === null && fs.existsSync(discovery)) {
      await api('/commands', { command: 'quit' }).catch(() => {});
      await Promise.race([app.closed, sleep(5000)]);
    }
    for (const child of children.reverse()) await stop(child);
    report.publisherHashStable = sha256(publisher) === report.publisherSha256;
    report.senderHashStable = sha256(sender) === report.senderSha256;
    if (!report.publisherHashStable || !report.senderHashStable) { report.passed = false; process.exitCode = 1; }
    save('report.json', report); console.log(JSON.stringify({ passed: report.passed, output }));
  }
})();
