#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process'), { chromium } = require('playwright');
const { receive } = require('./audio-settings-packaged-e2e');
const { create } = require('./signaling-fault-proxy');
const { sleep, waitFor } = require('./macos-media-receiver');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); assert(i > 2); return [arg.slice(2, i), arg.slice(i + 1)]; }));
assert.equal(process.platform, 'darwin');
for (const key of ['app', 'fixture', 'tone-helper', 'microphone-device', 'reports']) assert(opts[key], 'Required --' + key);
const encoders = (opts.encoders || 'videotoolbox,x264').split(','); assert(encoders.every(e => ['videotoolbox', 'x264'].includes(e)));
const app = path.resolve(opts.app), exe = path.join(app, 'Contents/MacOS/game-capture');
assert(fs.existsSync(path.join(app, 'Contents/Frameworks')), 'Use a packaged app');
const report = path.resolve(opts.reports, crypto.randomUUID()); fs.mkdirSync(report, { recursive: true });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result = { scope: 'Packaged Mac signaling reconnection, existing/late viewer media, plaintext/password signaling, and bounded stop/quit during an actual stalled upgrade. Owned Syphon and virtual audio input only.',
  app, executableSha256: hash(exe), qtWidgetsSha256: hash(path.join(app, 'Contents/Frameworks/QtWidgets.framework/Versions/A/QtWidgets')),
  harnessSha256: hash(__filename), receiverSha256: hash(path.join(__dirname, 'audio-settings-packaged-e2e.js')),
  fixtureSha256: hash(path.resolve(opts.fixture)), toneSha256: hash(path.resolve(opts['tone-helper'])), cases: [], passed: false };
for (const name of ['macos-signaling-recovery.js', 'signaling-fault-proxy.js', 'audio-settings-packaged-e2e.js', 'macos-media-receiver.js', 'macos-syphon-fixture.mm', 'macos-audio-tone.mm']) fs.copyFileSync(path.join(__dirname, name), path.join(report, name));
const children = new Set(); let browser;
const save = () => fs.writeFileSync(path.join(report, 'results.json'), JSON.stringify(result, null, 2) + '\n');
function launch(program, args, name, cwd = report) {
  const log = fs.createWriteStream(path.join(report, name + '.log'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QT_|DYLD_|GAME_CAPTURE_|VERSUS_)/.test(k)));
  const child = spawn(path.resolve(program), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
  let output = ''; child.output = () => output; child.stdout.on('data', data => output += data);
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.closed = new Promise(resolve => { child.once('close', (code, signal) => { children.delete(child); log.end(); resolve({ code, signal }); }); child.once('error', error => child.launchError = String(error)); });
  return child;
}
async function api(control, route, body) {
  const response = await fetch(control.base_url + route, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  assert(response.ok, 'Local control HTTP ' + response.status); return response.json();
}
(async () => {
  console.log('Reports: ' + report);
  try {
    const source = launch(opts.fixture, ['Signaling fixture ' + crypto.randomUUID(), 'premultiplied', 'flipped'], 'source');
    const tone = launch(opts['tone-helper'], [opts['microphone-device'], '440', '880'], 'tone');
    await waitFor(() => { assert(!source.launchError && source.exitCode === null); return source.output().includes('"uuid"'); }, 10000, 'Source not ready');
    const sourceId = JSON.parse(source.output().trim().split('\n')[0]).uuid;
    await waitFor(() => { assert(!tone.launchError && tone.exitCode === null); return tone.output().includes('READY ' + opts['microphone-device']); }, 10000, 'Virtual input tone not ready');
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] }); result.browserVersion = browser.version();
    for (const encoder of encoders) for (const encrypted of [false, true]) {
      const name = encoder + (encrypted ? '-password' : '-plain'), dir = path.join(report, name); fs.mkdirSync(dir);
      const discovery = path.join(dir, 'control.json'), remoteToken = crypto.randomBytes(24).toString('hex');
      const password = encrypted ? crypto.randomBytes(16).toString('hex') : 'false';
      const c = { stream: 'macsignaling' + crypto.randomBytes(12).toString('hex'), codec: 'opus', red: false, bitrate: 192, channels: 2 };
      const entry = { encoder, encryptedSignaling: encrypted, shutdown: encrypted ? 'quit-during-handshake' : 'stop-during-handshake', passed: false }; result.cases.push(entry); save();
      const proxy = await create(); let publisher, control;
      try {
        publisher = launch(exe, ['--headless', '--source=syphon', '--syphon-server=' + sourceId, '--syphon-alpha=premultiplied', '--alpha-background=opaque', '--alpha-background-color=#224488',
          '--stream=' + c.stream, '--password=' + password, '--server=' + proxy.url, '--audio-source=none', '--include-microphone', '--microphone-device=' + opts['microphone-device'],
          '--audio-codec=opus', '--audio-channels=2', '--audio-bitrate-kbps=192', '--no-audio-red', '--video-codec=h264', '--video-encoder=' + encoder,
          '--width=640', '--height=360', '--fps=30', '--bitrate-kbps=2000', '--remote-control', '--remote-token=' + remoteToken,
          '--duration-ms=240000', '--local-control', '--local-control-port=0', '--local-control-discovery=' + discovery], name + '-publisher', dir);
        await waitFor(async () => {
          for (const p of [publisher, source, tone]) assert(!p.launchError && p.exitCode === null && !p.signalCode, 'Owned process exited');
          if (!fs.existsSync(discovery)) return false; control = JSON.parse(fs.readFileSync(discovery)); assert.equal(control.pid, publisher.pid);
          return (await api(control, '/diagnostics')).app.live;
        }, 20000, 'Publisher not live');
        await waitFor(() => { c.viewerUrl = publisher.output().match(/\[App\] VIEW URL: (https:\/\/\S+)/)?.[1]; return !!c.viewerUrl; }, 10000, 'Viewer link missing');
        const viewer = new URL(c.viewerUrl);
        if (encrypted) {
          assert.equal(viewer.searchParams.get('password'), '<redacted>', 'Password should be redacted in publisher logs');
          viewer.searchParams.set('password', password); c.viewerUrl = viewer.href;
          entry.passwordRestoredFromOwnedLaunchArgument = true;
        } else assert.equal(viewer.searchParams.get('password'), 'false');
        entry.initialDiagnostics = await api(control, '/diagnostics'); assert.equal(entry.initialDiagnostics.video.hardware_encoder, encoder === 'videotoolbox');
        assert.equal(entry.initialDiagnostics.signaling.password_disabled, !encrypted);
        const options = { observePlayback: async ({ page, measure }) => {
          const identity = () => page.evaluate(async () => {
            const pc = window.audioReviewPc, rows = [...(await pc.getStats()).values()];
            return { connection: pc.connectionState, audioSsrc: rows.find(s => s.type === 'inbound-rtp' && s.kind === 'audio')?.ssrc,
              videoSsrc: rows.find(s => s.type === 'inbound-rtp' && s.kind === 'video')?.ssrc };
          });
          const delivery = () => page.evaluate(async () => {
            const rows = [...(await window.audioReviewPc.getStats()).values()];
            const audio = rows.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
            const video = rows.find(s => s.type === 'inbound-rtp' && s.kind === 'video');
            return { frames: video.framesDecoded, audioBytes: audio.bytesReceived, videoTime: video.timestamp, audioTime: audio.timestamp };
          });
          entry.beforeOutage = { proxy: proxy.snapshot(), peer: await identity(), delivery: await delivery() };
          proxy.fault('reject');
          await waitFor(async () => (await api(control, '/diagnostics')).app.reconnecting, 8000, 'Recovery state not entered');
          const started = Date.now();
          await sleep(12000);
          await measure('signaling-unavailable', 192);
          entry.duringOutage = { milliseconds: Date.now() - started, proxy: proxy.snapshot(), peer: await identity(), diagnostics: await api(control, '/diagnostics') };
          entry.duringOutage.delivery = await delivery();
          const first = entry.beforeOutage.delivery, last = entry.duringOutage.delivery;
          entry.duringOutage.decodedFps = (last.frames - first.frames) * 1000 / (last.videoTime - first.videoTime);
          entry.duringOutage.audioKbps = (last.audioBytes - first.audioBytes) * 8 / (last.audioTime - first.audioTime);
          assert(entry.duringOutage.decodedFps >= 28.5, 'Video fell below 95% of 30 fps during signaling loss');
          assert(Math.abs(entry.duringOutage.audioKbps - 192) < 192 * .12 + 1, 'Audio payload rate changed during signaling loss');
          assert(entry.duringOutage.diagnostics.app.live && entry.duringOutage.diagnostics.app.reconnecting);
          assert(entry.duringOutage.proxy.rejectedConnections > 0, 'No reconnect was refused');
          assert.deepEqual(entry.duringOutage.peer, entry.beforeOutage.peer, 'Existing media connection changed during signaling loss');
          proxy.restore(); const restored = Date.now();
          await waitFor(async () => proxy.snapshot().forwardedConnections > entry.beforeOutage.proxy.forwardedConnections && !(await api(control, '/diagnostics')).app.reconnecting, 45000, 'Signaling did not reconnect');
          entry.reconnectedMs = Date.now() - restored;
          await measure('signaling-restored', 192);
          const lateDir = path.join(dir, 'late'); fs.mkdirSync(lateDir);
          entry.lateReceiver = await receive(browser, c, lateDir, discovery, undefined, undefined, { observePlayback: async () => {
            await measure('existing-with-late-viewer', 192);
            entry.simultaneousDiagnostics = await api(control, '/diagnostics');
            assert(entry.simultaneousDiagnostics.peers.length >= 2, 'Late viewer did not coexist with original');
          } });
          assert(entry.lateReceiver.ok);
          for (const [bitrate, expected, label] of [[96, 96, 'reconnected-override'], [false, 192, 'reconnected-restored']]) {
            assert(await page.evaluate(({ bitrate, token }) => {
              const uuid = Object.keys(window.session.rpcs || {})[0];
              return !!window.session.sendRequest({ targetAudioBitrate: bitrate, remote: token }, uuid);
            }, { bitrate, token: remoteToken }), 'Existing viewer control channel stopped after signaling recovery');
            await waitFor(async () => (await api(control, '/diagnostics')).audio.configured_opus_bitrate_kbps === expected,
              10000, 'Recovered control channel did not apply bitrate');
            await sleep(800); await measure(label, expected);
          }
          entry.remoteControlsAfterRecoveryPassed = true;
          entry.afterRecovery = { proxy: proxy.snapshot(), peer: await identity() };
          assert.deepEqual(entry.afterRecovery.peer, entry.beforeOutage.peer, 'Original media connection was replaced');
          const stalls = proxy.snapshot().stalledHandshakes; proxy.fault('stall');
          await waitFor(async () => proxy.snapshot().stalledHandshakes > stalls && (await api(control, '/diagnostics')).app.reconnecting, 8000, 'Pending upgrade not observed');
          entry.pendingHandshake = proxy.snapshot();
          const stopping = Date.now();
          if (encrypted) {
            await api(control, '/commands', { command: 'quit' });
            await waitFor(() => publisher.exitCode !== null, 5000, 'Quit blocked on pending handshake');
            entry.shutdownMs = Date.now() - stopping;
          } else {
            await api(control, '/commands', { command: 'stop' });
            await waitFor(async () => { const d = await api(control, '/diagnostics'); return !d.app.live && !d.app.capturing && !d.app.reconnecting; }, 5000, 'Stop blocked on pending handshake');
            entry.shutdownMs = Date.now() - stopping;
            const stopped = await api(control, '/diagnostics'); await sleep(1000); const settled = await api(control, '/diagnostics');
            assert.equal(settled.video.frames_captured, stopped.video.frames_captured); assert.equal(settled.video.frames_sent, stopped.video.frames_sent);
            assert.equal(settled.metrics.audio_packets_sent, stopped.metrics.audio_packets_sent); assert.equal(settled.peers.length, 0);
            assert.equal(settled.macos_media_activity_active, false); entry.stoppedDiagnostics = settled;
            await api(control, '/commands', { command: 'quit' });
            await waitFor(() => publisher.exitCode !== null, 5000, 'Stopped publisher did not quit');
          }
          entry.publisherExit = await publisher.closed; assert.equal(entry.publisherExit.code, 0); assert(!fs.existsSync(discovery));
          assert(entry.shutdownMs < 5000); console.log(name + ': signaling recovery, late viewer and pending-handshake shutdown passed');
        } };
        entry.receiver = await receive(browser, c, dir, discovery, remoteToken, undefined, options);
        assert(entry.receiver.ok); assert(source.exitCode === null && tone.exitCode === null);
        entry.passed = true;
      } catch (error) {
        entry.error = String(error.stack || error); console.error(name + ': ' + String(error.message || error));
        const file = path.join(dir, 'receiver.json'); if (fs.existsSync(file)) entry.receiver = JSON.parse(fs.readFileSync(file));
      } finally {
        if (publisher && publisher.exitCode === null && control) await api(control, '/commands', { command: 'quit' }).catch(() => {});
        if (publisher) {
          await Promise.race([publisher.closed, sleep(5000)]);
          if (publisher.exitCode === null && !publisher.signalCode) { entry.passed = false; entry.forcedCleanup = true; publisher.kill('SIGTERM'); }
          entry.publisherExit = await publisher.closed;
          if (entry.publisherExit.code !== 0 || fs.existsSync(discovery)) entry.passed = false;
        }
        entry.finalProxy = proxy.snapshot(); await proxy.close(); entry.proxyClosed = proxy.snapshot();
        assert(!publisher || !publisher.output().includes(remoteToken), 'Remote token exposed in publisher log');
        if (encrypted && publisher) { assert(!publisher.output().includes(password), 'Password exposed in publisher log'); entry.passwordNotExposedInLog = true; }
        save(); console.log(name + ': ' + (entry.passed ? 'passed' : 'failed'));
      }
    }
    result.passed = result.cases.length === encoders.length * 2 && result.cases.every(c => c.passed);
    assert(result.passed, 'Signaling recovery workflow failure');
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of children) child.stdin.write('quit\n');
    await Promise.all([...children].map(async child => {
      await Promise.race([child.closed, sleep(3000)]); if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
      await Promise.race([child.closed, sleep(3000)]); if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await child.closed;
    }));
    save(); console.log(JSON.stringify({ report, passed: result.passed }));
  }
})();
