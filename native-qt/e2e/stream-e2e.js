#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const args = {
    publisher: 'game-capture',
    streamId: `game_capture_e2e_${Date.now()}`,
    room: '',
    password: '',
    label: 'e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    videoEncoder: '',
    videoCodec: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    source: '',
    spoutSender: '',
    width: 0,
    height: 0,
    fps: 0,
    bitrateKbps: 0,
    alphaWorkflow: false,
    alphaBackground: '',
    alphaBackgroundColor: '',
    diagnosticsOut: '',
    timeoutMs: 90000,
    startupDelayMs: 5000,
    holdMs: 0,
    durationMs: 0,
    iterations: 1,
    viewerAttempts: 1,
    viewerWidth: 1600,
    viewerHeight: 900,
    headful: false,
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    publisherPath: '',
    keepPublisher: false
    ,
    initRole: '',
    initVideo: true,
    initAudio: true
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--publisher=')) {
      args.publisher = arg.slice('--publisher='.length);
    } else if (arg.startsWith('--stream=')) {
      args.streamId = arg.slice('--stream='.length);
    } else if (arg.startsWith('--room=')) {
      args.room = arg.slice('--room='.length);
    } else if (arg.startsWith('--password=')) {
      args.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--label=')) {
      args.label = arg.slice('--label='.length);
    } else if (arg.startsWith('--server=')) {
      args.server = arg.slice('--server='.length);
    } else if (arg.startsWith('--salt=')) {
      args.salt = arg.slice('--salt='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--video-codec=')) {
      args.videoCodec = arg.slice('--video-codec='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--source=')) {
      args.source = arg.slice('--source='.length);
    } else if (arg.startsWith('--spout-sender=')) {
      args.spoutSender = arg.slice('--spout-sender='.length);
    } else if (arg.startsWith('--width=')) {
      args.width = Number(arg.slice('--width='.length)) || args.width;
    } else if (arg.startsWith('--height=')) {
      args.height = Number(arg.slice('--height='.length)) || args.height;
    } else if (arg.startsWith('--fps=')) {
      args.fps = Number(arg.slice('--fps='.length)) || args.fps;
    } else if (arg.startsWith('--bitrate-kbps=')) {
      args.bitrateKbps = Number(arg.slice('--bitrate-kbps='.length)) || args.bitrateKbps;
    } else if (arg === '--alpha-workflow') {
      args.alphaWorkflow = true;
    } else if (arg.startsWith('--alpha-background=')) {
      args.alphaBackground = arg.slice('--alpha-background='.length);
    } else if (arg.startsWith('--alpha-background-color=')) {
      args.alphaBackgroundColor = arg.slice('--alpha-background-color='.length);
    } else if (arg.startsWith('--diagnostics-out=')) {
      args.diagnosticsOut = path.resolve(arg.slice('--diagnostics-out='.length));
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs;
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs;
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Math.max(0, Number(arg.slice('--hold-ms='.length)) || args.holdMs);
    } else if (arg.startsWith('--duration-ms=')) {
      args.durationMs = Number(arg.slice('--duration-ms='.length)) || args.durationMs;
    } else if (arg.startsWith('--iterations=')) {
      args.iterations = Math.max(1, Number(arg.slice('--iterations='.length)) || args.iterations);
    } else if (arg.startsWith('--viewer-attempts=')) {
      args.viewerAttempts = Math.max(1, Number(arg.slice('--viewer-attempts='.length)) || args.viewerAttempts);
    } else if (arg.startsWith('--viewer-width=')) {
      args.viewerWidth = Math.max(320, Number(arg.slice('--viewer-width='.length)) || args.viewerWidth);
    } else if (arg.startsWith('--viewer-height=')) {
      args.viewerHeight = Math.max(240, Number(arg.slice('--viewer-height='.length)) || args.viewerHeight);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
    } else if (arg === '--keep-publisher') {
      args.keepPublisher = true;
    } else if (arg.startsWith('--init-role=')) {
      args.initRole = arg.slice('--init-role='.length).trim();
    } else if (arg.startsWith('--init-video=')) {
      const value = arg.slice('--init-video='.length).trim().toLowerCase();
      args.initVideo = !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    } else if (arg.startsWith('--init-audio=')) {
      const value = arg.slice('--init-audio='.length).trim().toLowerCase();
      args.initAudio = !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    }
  }

  if (!args.initRole && args.room) {
    args.initRole = 'viewer';
  }

  if (!args.durationMs || args.durationMs < args.timeoutMs + args.startupDelayMs + 10000) {
    args.durationMs = args.timeoutMs * args.iterations + args.startupDelayMs + 20000;
  }

  return args;
}

function detectQtPluginPath() {
  const candidates = [
    process.env.QT_PLUGIN_PATH,
    'C:/vcpkg/installed/x64-windows/Qt6/plugins',
    'C:/Users/Steve/code/obs-studio/.deps/obs-deps-qt6-2025-08-23-x64/plugins'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'platforms', 'qwindows.dll')) ||
        fs.existsSync(path.join(candidate, 'platforms', 'qoffscreen.dll'))) {
      return candidate;
    }
  }
  return '';
}

function detectPublisherBinary(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const candidates = [
    path.resolve(__dirname, '../build-review2/bin/Release/game-capture.exe'),
    path.resolve(__dirname, '../build-test/bin/Release/game-capture.exe'),
    path.resolve(__dirname, '../build/bin/Release/game-capture.exe')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function detectTestStreamBinary() {
  const candidates = [
    path.resolve(__dirname, '../build-review2/bin/Release/test-stream.exe'),
    path.resolve(__dirname, '../build-test/bin/Release/test-stream.exe'),
    path.resolve(__dirname, '../build/bin/Release/test-stream.exe')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function buildViewerUrl(config) {
  const query = new URLSearchParams();
  query.set('view', config.streamId);
  query.set('autostart', '');
  query.set('muted', '');

  if (config.room) {
    query.set('room', config.room);
    query.set('solo', '');
  }
  if (config.password) {
    query.set('password', config.password);
  }

  return `https://vdo.ninja/?${query.toString()}`;
}

function spawnPublisher(config) {
  let command;
  let args;
  const env = { ...process.env };

  if (config.publisher === 'test-stream') {
    command = detectTestStreamBinary();
    if (!command) {
      throw new Error('Could not find test-stream.exe. Build native-qt first.');
    }
    args = [config.streamId];
  } else {
    command = detectPublisherBinary(config.publisherPath);
    if (!command) {
      throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
    }
    args = [
      '--headless',
      `--stream=${config.streamId}`,
      `--password=${config.password}`,
      `--room=${config.room}`,
      `--label=${config.label}`,
      `--server=${config.server}`,
      `--salt=${config.salt}`,
      `--duration-ms=${config.durationMs}`
    ];
    if (config.videoEncoder) {
      args.push(`--video-encoder=${config.videoEncoder}`);
    }
    if (config.videoCodec) {
      args.push(`--video-codec=${config.videoCodec}`);
    }
    if (config.ffmpegPath) {
      args.push(`--ffmpeg-path=${config.ffmpegPath}`);
    }
    if (config.ffmpegOptions) {
      args.push(`--ffmpeg-options=${config.ffmpegOptions}`);
    }
    if (config.source) {
      args.push(`--source=${config.source}`);
    }
    if (config.spoutSender) {
      args.push(`--spout-sender=${config.spoutSender}`);
    }
    if (config.width > 0) {
      args.push(`--width=${config.width}`);
    }
    if (config.height > 0) {
      args.push(`--height=${config.height}`);
    }
    if (config.fps > 0) {
      args.push(`--fps=${config.fps}`);
    }
    if (config.bitrateKbps > 0) {
      args.push(`--bitrate-kbps=${config.bitrateKbps}`);
    }
    if (config.alphaWorkflow) {
      args.push('--alpha-workflow');
    }
    if (config.alphaBackground) {
      args.push(`--alpha-background=${config.alphaBackground}`);
    }
    if (config.alphaBackgroundColor) {
      args.push(`--alpha-background-color=${config.alphaBackgroundColor}`);
    }
    if (config.diagnosticsOut) {
      args.push(`--diagnostics-out=${config.diagnosticsOut}`);
    }

    const qtPluginPath = detectQtPluginPath();
    if (qtPluginPath) {
      env.QT_PLUGIN_PATH = qtPluginPath;
      env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM || 'offscreen';
    }
  }

  const proc = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const stdout = [];
  const stderr = [];
  proc.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  return { proc, command, args, stdout, stderr };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailText(value, maxLength = 6000) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(text.length - maxLength);
}

async function waitForPublisherReady(started, config) {
  const minDelayMs = Math.max(0, Number(config.startupDelayMs) || 0);
  const maxWaitMs = Math.max(minDelayMs, minDelayMs + Math.min(Math.max(config.timeoutMs, 15000), 60000));
  const start = Date.now();
  let lastReadySignal = '';

  while (Date.now() - start < maxWaitMs) {
    const stdoutText = started.stdout.join('');
    const stderrText = started.stderr.join('');
    const outputText = `${stdoutText}\n${stderrText}`;
    const elapsedMs = Date.now() - start;

    if (started.proc.exitCode !== null) {
      return {
        ok: false,
        reason: 'publisher-exited',
        exitCode: started.proc.exitCode,
        elapsedMs,
        outputTail: tailText(outputText)
      };
    }

    if (config.publisher === 'test-stream') {
      lastReadySignal = 'fixed-delay';
    } else if (/VIEW URL:/i.test(outputText) || /Stream started, waiting for connections/i.test(outputText)) {
      lastReadySignal = 'view-url';
    }

    if (lastReadySignal && elapsedMs >= minDelayMs) {
      return { ok: true, elapsedMs, signal: lastReadySignal };
    }

    await wait(250);
  }

  return {
    ok: false,
    reason: 'publisher-not-ready',
    elapsedMs: Date.now() - start,
    outputTail: tailText(`${started.stdout.join('')}\n${started.stderr.join('')}`)
  };
}

async function waitForSessionPeer(page, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(() => {
      const sessionObj = window.session || null;
      if (!sessionObj) {
        return { ready: false, reason: 'no_session' };
      }

      const rpcIds = Object.keys(sessionObj.rpcs || {});
      if (!rpcIds.length) {
        return { ready: false, reason: 'no_rpcs', hasSendRequest: typeof sessionObj.sendRequest === 'function' };
      }

      return {
        ready: true,
        uuid: rpcIds[0],
        hasSendRequest: typeof sessionObj.sendRequest === 'function'
      };
    });

    if (last.ready) {
      return last;
    }
    await wait(500);
  }
  return last || { ready: false, reason: 'timeout' };
}

async function sendDataMessage(page, payload) {
  return page.evaluate((msg) => {
    const sessionObj = window.session || null;
    if (!sessionObj) {
      return { ok: false, reason: 'no_session' };
    }

    const rpcIds = Object.keys(sessionObj.rpcs || {});
    if (!rpcIds.length) {
      return { ok: false, reason: 'no_rpcs' };
    }

    const uuid = rpcIds[0];
    let sent = false;
    if (typeof sessionObj.sendRequest === 'function') {
      sent = !!sessionObj.sendRequest(msg, uuid);
    } else {
      const rpc = sessionObj.rpcs[uuid];
      const channel = rpc && (rpc.receiveChannel || rpc.sendChannel);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify(msg));
        sent = true;
      }
    }
    return { ok: sent, uuid };
  }, payload);
}

async function sendViewerInitIfConfigured(page, initOptions, timeoutMs) {
  if (!initOptions || !initOptions.role) {
    return { ok: true, skipped: true };
  }

  const initDeadlineMs = Math.max(8000, Math.floor(timeoutMs / 2));
  const peerState = await waitForSessionPeer(page, initDeadlineMs);
  if (!peerState || !peerState.ready) {
    return { ok: false, stage: 'session-peer', state: peerState };
  }

  const initPayload = {
    init: {
      role: initOptions.role,
      room: !!initOptions.room,
      video: !!initOptions.video,
      audio: !!initOptions.audio,
      label: initOptions.label || '',
      system: {
        app: 'game-capture-e2e',
        version: '1',
        platform: 'playwright',
        browser: 'chromium'
      }
    }
  };
  const start = Date.now();
  let lastSend = null;
  while (Date.now() - start < initDeadlineMs) {
    lastSend = await sendDataMessage(page, initPayload);
    if (lastSend && lastSend.ok) {
      return { ok: true, state: lastSend };
    }
    await wait(400);
  }
  return { ok: false, stage: 'send-init', state: lastSend };
}

async function runViewerCheck(viewerUrl, timeoutMs, holdMs, headful, screenshotDir, runId, initOptions, viewport) {
  const browser = await chromium.launch({
    headless: !headful,
    args: ['--autoplay-policy=no-user-gesture-required']
  });

  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const initResult = await sendViewerInitIfConfigured(page, initOptions, timeoutMs);
  if (!initResult.ok) {
    const shotPath = path.join(screenshotDir, `e2e-fail-${runId}-${nowStamp()}.png`);
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    await browser.close();
    return { ok: false, state: initResult.state || initResult, screenshot: shotPath };
  }

  const collectState = async () => page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')).map((v) => ({
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      currentTime: v.currentTime,
      paused: v.paused,
      ended: v.ended
    }));
    const hasDecodedVideo = videos.some((v) =>
      v.readyState >= 2 && v.width > 0 && v.height > 0 && v.currentTime > 0 && !v.ended
    );
    return {
      title: document.title,
      videoCount: videos.length,
      hasDecodedVideo,
      videos,
      bodyTextSample: (document.body && document.body.innerText) ? document.body.innerText.slice(0, 240) : ''
    };
  });

  const start = Date.now();
  let lastState = null;

  while (Date.now() - start < timeoutMs) {
    lastState = await collectState();

    if (lastState.hasDecodedVideo) {
      if (holdMs > 0) {
        await wait(holdMs);
        const heldState = await collectState();
        if (!heldState.hasDecodedVideo) {
          const shotPath = path.join(screenshotDir, `e2e-fail-${runId}-${nowStamp()}.png`);
          fs.mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({ path: shotPath, fullPage: true });
          await browser.close();
          return { ok: false, state: heldState, screenshot: shotPath };
        }
        lastState = heldState;
      }

      const shotPath = path.join(screenshotDir, `e2e-pass-${runId}-${nowStamp()}.png`);
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: shotPath, fullPage: true });
      await browser.close();
      return { ok: true, state: lastState, screenshot: shotPath };
    }
    await wait(1000);
  }

  const shotPath = path.join(screenshotDir, `e2e-fail-${runId}-${nowStamp()}.png`);
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: shotPath, fullPage: true });
  await browser.close();
  return { ok: false, state: lastState, screenshot: shotPath };
}

async function runViewerCheckWithRetry(viewerUrl, timeoutMs, holdMs, headful, screenshotDir, runId, initOptions, attempts) {
  const maxAttempts = Math.max(1, attempts || 1);
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runViewerCheck(
      viewerUrl,
      timeoutMs,
      holdMs,
      headful,
      screenshotDir,
      maxAttempts > 1 ? `${runId}-attempt${attempt}` : runId,
      initOptions,
      { width: initOptions.viewerWidth || 1600, height: initOptions.viewerHeight || 900 }
    );
    if (result.ok) {
      if (attempt > 1) {
        console.log(`[E2E] Viewer recovered on attempt ${attempt}/${maxAttempts}`);
      }
      return result;
    }

    lastResult = result;
    if (attempt < maxAttempts) {
      console.warn(`[E2E] Viewer attempt ${attempt}/${maxAttempts} failed; retrying`);
      // eslint-disable-next-line no-await-in-loop
      await wait(1500);
    }
  }

  return lastResult;
}

async function main() {
  const config = parseArgs(process.argv);
  const viewerUrl = buildViewerUrl(config);

  console.log(`[E2E] Publisher mode: ${config.publisher}`);
  console.log(`[E2E] Stream ID: ${config.streamId}`);
  console.log(`[E2E] Room: ${config.room || '(none)'}`);
  console.log(`[E2E] Password: ${config.password}`);
  console.log(`[E2E] Iterations: ${config.iterations}`);
  if (config.videoEncoder) {
    console.log(`[E2E] Video encoder: ${config.videoEncoder}`);
  }
  if (config.source) {
    console.log(`[E2E] Capture source: ${config.source}${config.spoutSender ? ` (${config.spoutSender})` : ''}`);
  }
  if (config.width || config.height || config.fps) {
    console.log(`[E2E] Requested capture/encode: ${config.width || '(default)'}x${config.height || '(default)'} @ ${config.fps || '(default)'}fps`);
  }
  if (config.alphaBackground) {
    console.log(`[E2E] Alpha background: ${config.alphaBackground} ${config.alphaBackgroundColor || ''}`.trim());
  }
  if (config.diagnosticsOut) {
    console.log(`[E2E] Diagnostics out: ${config.diagnosticsOut}`);
  }
  if (config.ffmpegPath) {
    console.log(`[E2E] FFmpeg path override: ${config.ffmpegPath}`);
  }
  if (config.holdMs > 0) {
    console.log(`[E2E] Hold per iteration: ${config.holdMs}ms`);
  }
  if (config.viewerAttempts > 1) {
    console.log(`[E2E] Viewer attempts per iteration: ${config.viewerAttempts}`);
  }
  if (config.viewerWidth !== 1600 || config.viewerHeight !== 900) {
    console.log(`[E2E] Viewer viewport: ${config.viewerWidth}x${config.viewerHeight}`);
  }
  if (config.initRole) {
    console.log(`[E2E] Data init role: ${config.initRole} (video=${config.initVideo}, audio=${config.initAudio})`);
  }

  const started = spawnPublisher(config);
  console.log(`[E2E] Spawned publisher: ${started.command} ${started.args.join(' ')}`);
  console.log(`[E2E] Waiting for publisher readiness (minimum ${config.startupDelayMs}ms)...`);
  const publisherReady = await waitForPublisherReady(started, config);
  if (!publisherReady.ok) {
    if (!config.keepPublisher && started.proc && !started.proc.killed) {
      started.proc.kill();
    }
    console.error('[E2E] FAIL');
    console.error(`[E2E] Publisher did not become ready: ${JSON.stringify(publisherReady)}`);
    if (publisherReady.outputTail && publisherReady.outputTail.trim()) {
      console.error(`[E2E] Publisher output tail:\n${publisherReady.outputTail}`);
    }
    process.exit(1);
  }
  console.log(`[E2E] Publisher ready via ${publisherReady.signal} after ${publisherReady.elapsedMs}ms`);

  const results = [];
  try {
    for (let i = 1; i <= config.iterations; i++) {
      console.log(`[E2E] Iteration ${i}/${config.iterations}: opening viewer`);
      const result = await runViewerCheckWithRetry(
        viewerUrl,
        config.timeoutMs,
        config.holdMs,
        config.headful,
        config.screenshotDir,
        `${config.streamId}-iter${i}`,
        {
          role: config.initRole,
          room: !!config.room,
          video: config.initVideo,
          audio: config.initAudio,
          label: config.label,
          viewerWidth: config.viewerWidth,
          viewerHeight: config.viewerHeight
        },
        config.viewerAttempts
      );
      results.push(result);
      if (result.ok) {
        console.log(`[E2E] Iteration ${i}: PASS (${result.screenshot})`);
      } else {
        console.error(`[E2E] Iteration ${i}: FAIL (${result.screenshot})`);
        break;
      }
      await wait(1000);
    }
  } finally {
    if (!config.keepPublisher && started.proc && !started.proc.killed) {
      started.proc.kill();
    }
  }

  const allPassed = results.length === config.iterations && results.every((r) => r.ok);
  if (allPassed) {
    const last = results[results.length - 1];
    console.log('[E2E] PASS');
    console.log(`[E2E] URL: ${viewerUrl}`);
    console.log(`[E2E] Final state: ${JSON.stringify(last.state)}`);
    process.exit(0);
  }

  const failed = results.find((r) => !r.ok) || results[results.length - 1];
  const stdoutText = started.stdout.join('');
  const stderrText = started.stderr.join('');
  console.error('[E2E] FAIL');
  console.error(`[E2E] URL: ${viewerUrl}`);
  if (failed) {
    console.error(`[E2E] Last viewer state: ${JSON.stringify(failed.state)}`);
    console.error(`[E2E] Screenshot: ${failed.screenshot}`);
  }
  if (stdoutText.trim()) {
    console.error(`[E2E] Publisher stdout:\n${stdoutText}`);
  }
  if (stderrText.trim()) {
    console.error(`[E2E] Publisher stderr:\n${stderrText}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[E2E] Unhandled error:', err);
  process.exit(1);
});

