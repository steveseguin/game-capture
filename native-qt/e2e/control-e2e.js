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
    streamId: `control_${Date.now()}`,
    room: '',
    password: '',
    label: 'control-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 60000,
    holdMs: 5000,
    bitrateKbps: 4000,
    requestResolution: '',
    remoteToken: 'control-token',
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    initRole: '',
    initVideo: true,
    initAudio: true,
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    headful: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--stream=')) {
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
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs;
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs;
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Number(arg.slice('--hold-ms='.length)) || args.holdMs;
    } else if (arg.startsWith('--bitrate-kbps=')) {
      args.bitrateKbps = Number(arg.slice('--bitrate-kbps='.length)) || args.bitrateKbps;
    } else if (arg.startsWith('--request-resolution=')) {
      args.requestResolution = arg.slice('--request-resolution='.length).trim();
    } else if (arg.startsWith('--remote-token=')) {
      args.remoteToken = arg.slice('--remote-token='.length);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--init-role=')) {
      args.initRole = arg.slice('--init-role='.length).trim();
    } else if (arg.startsWith('--init-video=')) {
      const value = arg.slice('--init-video='.length).trim().toLowerCase();
      args.initVideo = !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    } else if (arg.startsWith('--init-audio=')) {
      const value = arg.slice('--init-audio='.length).trim().toLowerCase();
      args.initAudio = !(value === '0' || value === 'false' || value === 'off' || value === 'no');
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
    }
  }

  if (!args.initRole && args.room) {
    args.initRole = 'viewer';
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
  const command = detectPublisherBinary(config.publisherPath);
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
  }

  const durationMs = Math.max(180000, config.startupDelayMs + config.timeoutMs + config.holdMs + 30000);
  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--password=${config.password}`,
    `--room=${config.room}`,
    `--label=${config.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    '--remote-control',
    `--remote-token=${config.remoteToken}`
  ];
  if (config.videoEncoder) {
    args.push(`--video-encoder=${config.videoEncoder}`);
  }
  if (config.ffmpegPath) {
    args.push(`--ffmpeg-path=${config.ffmpegPath}`);
  }
  if (config.ffmpegOptions) {
    args.push(`--ffmpeg-options=${config.ffmpegOptions}`);
  }

  const env = { ...process.env };
  const qtPluginPath = detectQtPluginPath();
  if (qtPluginPath) {
    env.QT_PLUGIN_PATH = qtPluginPath;
    env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM || 'offscreen';
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

async function collectState(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')).map((v) => ({
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      currentTime: v.currentTime,
      paused: v.paused,
      ended: v.ended
    }));
    return {
      title: document.title,
      videoCount: videos.length,
      hasDecodedVideo: videos.some((v) =>
        v.readyState >= 2 && v.width > 0 && v.height > 0 && v.currentTime > 0 && !v.ended),
      videos
    };
  });
}

async function waitForDecodedVideo(page, timeoutMs, stageLabel) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await collectState(page);
    if (lastState.hasDecodedVideo) {
      return { ok: true, state: lastState };
    }
    await wait(1000);
  }
  return { ok: false, state: lastState, stage: stageLabel };
}

function parseResolution(text) {
  if (!text) {
    return null;
  }
  const match = /^(\d+)x(\d+)(?:@(\d+))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const fps = Number(match[3] || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    w: width,
    h: height,
    f: Number.isFinite(fps) ? fps : 0
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

async function sendControlMessage(page, payload) {
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

    return {
      ok: sent,
      uuid,
      hasSendRequest: typeof sessionObj.sendRequest === 'function'
    };
  }, payload);
}

async function sendInitMessage(page, payload) {
  return sendControlMessage(page, payload);
}

async function installControlAckProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc', uuid: peerUuid };
    }

    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__gameCaptureControlProbe || { acks: [] };
    if (!Array.isArray(probe.acks)) {
      probe.acks = [];
    }
    window.__gameCaptureControlProbe = probe;

    const parseMessage = (event, channelName) => {
      let payload = '';
      if (event && typeof event.data === 'string') {
        payload = event.data;
      }
      if (!payload) {
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        if (parsed && parsed.ack === 'control') {
          probe.acks.push({
            ts: Date.now(),
            channel: channelName,
            message: parsed
          });
          if (probe.acks.length > 50) {
            probe.acks.shift();
          }
        }
      } catch {
        // Ignore non-JSON payloads.
      }
    };

    const attach = (channel, channelName) => {
      if (!channel) {
        return false;
      }
      if (channel.__gameCaptureControlProbeAttached) {
        return true;
      }
      channel.__gameCaptureControlProbeAttached = true;

      if (typeof channel.addEventListener === 'function') {
        channel.addEventListener('message', (event) => parseMessage(event, channelName));
        return true;
      }

      const previous = channel.onmessage;
      channel.onmessage = (event) => {
        parseMessage(event, channelName);
        if (typeof previous === 'function') {
          return previous.call(channel, event);
        }
        return undefined;
      };
      return true;
    };

    const receiveAttached = attach(rpc.receiveChannel, 'receiveChannel');
    const sendAttached = attach(rpc.sendChannel, 'sendChannel');
    return {
      ok: receiveAttached || sendAttached,
      receiveAttached,
      sendAttached
    };
  }, uuid);
}

async function waitForControlAck(page, timeoutMs, expectedBitrate) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate((bitrate) => {
      const probe = window.__gameCaptureControlProbe || { acks: [] };
      const acks = Array.isArray(probe.acks) ? probe.acks : [];
      const latest = acks.length ? acks[acks.length - 1] : null;
      const success = acks.find((entry) => {
        if (!entry || !entry.message) {
          return false;
        }
        const msg = entry.message;
        const ackBitrate = Number(msg.targetBitrate ?? msg.bitrate ?? 0);
        const ok = msg.ok === true || msg.ok === 'true' || msg.ok === 1;
        return ok && (!Number.isFinite(bitrate) || bitrate <= 0 || ackBitrate === bitrate);
      }) || null;
      return {
        ackCount: acks.length,
        latest,
        success
      };
    }, expectedBitrate);

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }

  return { ok: false, stage: 'control-ack', state: lastState };
}

async function main() {
  const config = parseArgs(process.argv);
  const viewerUrl = buildViewerUrl(config);

  console.log(`[CONTROL] Stream ID: ${config.streamId}`);
  console.log(`[CONTROL] Room: ${config.room || '(none)'}`);
  console.log(`[CONTROL] Password: ${config.password}`);
  console.log(`[CONTROL] Remote token length: ${config.remoteToken.length}`);
  if (config.initRole) {
    console.log(`[CONTROL] Data init role: ${config.initRole} (video=${config.initVideo}, audio=${config.initAudio})`);
  }
  console.log(`[CONTROL] URL: ${viewerUrl}`);

  const publisher = spawnPublisher(config);
  console.log(`[CONTROL] Spawned publisher: ${publisher.command} ${publisher.args.join(' ')}`);

  await wait(config.startupDelayMs);

  const browser = await chromium.launch({
    headless: !config.headful,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();

  let failure = null;
  try {
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peerState = await waitForSessionPeer(page, Math.max(10000, config.timeoutMs / 2));
    if (!peerState || !peerState.ready) {
      failure = { stage: 'session-peer', state: peerState };
      return;
    }

    if (config.initRole) {
      const initMessage = {
        init: {
          role: config.initRole,
          room: !!config.room,
          video: config.initVideo,
          audio: config.initAudio,
          label: config.label,
          system: {
            app: 'game-capture-e2e-control',
            version: '1',
            platform: 'playwright',
            browser: 'chromium'
          }
        }
      };
      const initDeadlineMs = Math.max(8000, Math.floor(config.timeoutMs / 2));
      const initStart = Date.now();
      let initResult = null;
      while (Date.now() - initStart < initDeadlineMs) {
        initResult = await sendInitMessage(page, initMessage);
        if (initResult && initResult.ok) {
          break;
        }
        await wait(400);
      }
      if (!initResult || !initResult.ok) {
        failure = { stage: 'send-init', state: initResult };
        return;
      }
      console.log(`[CONTROL] Init sent to ${initResult.uuid}`);
    }

    let result = await waitForDecodedVideo(page, config.timeoutMs, 'initial-video');
    if (!result.ok) {
      failure = result;
      return;
    }
    console.log('[CONTROL] Initial decode PASS');

    const probeResult = await installControlAckProbe(page, peerState.uuid);
    if (!probeResult.ok) {
      failure = { stage: 'control-probe', state: probeResult };
      return;
    }

    const controlMessage = {
      keyframe: true,
      requestStats: true,
      targetBitrate: config.bitrateKbps,
      remote: config.remoteToken
    };
    const requestedResolution = parseResolution(config.requestResolution);
    if (requestedResolution) {
      controlMessage.requestResolution = requestedResolution;
    }

    const sendResult = await sendControlMessage(page, controlMessage);
    if (!sendResult.ok) {
      failure = { stage: 'send-control', state: sendResult };
      return;
    }
    console.log(`[CONTROL] Control message sent via ${sendResult.hasSendRequest ? 'session.sendRequest' : 'data channel direct'} to ${sendResult.uuid}`);

    const ackResult = await waitForControlAck(page, Math.max(5000, config.timeoutMs / 2), config.bitrateKbps);
    if (!ackResult.ok) {
      failure = ackResult;
      return;
    }
    console.log(`[CONTROL] Control ack PASS (${JSON.stringify(ackResult.state.success.message)})`);

    await wait(config.holdMs);
    result = await waitForDecodedVideo(page, config.timeoutMs, 'post-control-video');
    if (!result.ok) {
      failure = result;
      return;
    }
    console.log('[CONTROL] Post-control decode PASS');

    const stdoutText = publisher.stdout.join('');
    const bitrateApplied =
      stdoutText.includes(`[App] Applying runtime bitrate update: ${config.bitrateKbps} kbps`) ||
      stdoutText.includes(`[App] Applying runtime video reconfigure`);
    if (bitrateApplied) {
      console.log('[CONTROL] Publisher runtime control log observed');
    } else {
      console.log('[CONTROL] Publisher runtime control log not observed; using ack-based validation');
    }

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const shot = path.join(config.screenshotDir, `control-pass-${config.streamId}-${nowStamp()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[CONTROL] PASS screenshot: ${shot}`);
    process.exitCode = 0;
  } finally {
    if (failure) {
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shot = path.join(config.screenshotDir, `control-fail-${config.streamId}-${nowStamp()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      console.error('[CONTROL] FAIL');
      console.error(`[CONTROL] Stage: ${failure.stage}`);
      console.error(`[CONTROL] State: ${JSON.stringify(failure.state)}`);
      console.error(`[CONTROL] Screenshot: ${shot}`);

      const stdoutText = publisher.stdout.join('');
      const stderrText = publisher.stderr.join('');
      if (stdoutText.trim()) {
        console.error(`[CONTROL] Publisher stdout:\n${stdoutText}`);
      }
      if (stderrText.trim()) {
        console.error(`[CONTROL] Publisher stderr:\n${stderrText}`);
      }
      process.exitCode = 1;
    }

    if (publisher.proc && !publisher.proc.killed) {
      publisher.proc.kill();
    }
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[CONTROL] Unhandled error:', err);
  process.exit(1);
});

