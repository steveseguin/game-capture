#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const LQ_WIDTH = 640;
const LQ_HEIGHT = 360;
const LQ_FPS = 30;
const LQ_BITRATE = 2000;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeId(value, maxLen, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(/[^A-Za-z0-9_]/g, '_');
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLen) {
    return normalized.slice(0, maxLen);
  }
  return normalized;
}

function parseArgs(argv) {
  const seed = Date.now();
  const args = {
    streamId: `dual_quality_${seed}`,
    room: `dual_room_${seed}`,
    password: '',
    label: 'dual-quality-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 60000,
    holdMs: 4000,
    sceneRole: 'scene',
    guestRole: 'guest',
    sceneMinBitrateKbps: 3000,
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../qa/reports'),
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
      args.startupDelayMs = Math.max(1000, Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs);
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Math.max(5000, Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs);
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Math.max(0, Number(arg.slice('--hold-ms='.length)) || args.holdMs);
    } else if (arg.startsWith('--scene-role=')) {
      args.sceneRole = arg.slice('--scene-role='.length).trim() || args.sceneRole;
    } else if (arg.startsWith('--guest-role=')) {
      args.guestRole = arg.slice('--guest-role='.length).trim() || args.guestRole;
    } else if (arg.startsWith('--scene-min-bitrate-kbps=')) {
      args.sceneMinBitrateKbps = Math.max(1, Number(arg.slice('--scene-min-bitrate-kbps='.length)) || args.sceneMinBitrateKbps);
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg.startsWith('--report-dir=')) {
      args.reportDir = path.resolve(arg.slice('--report-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
    }
  }

  const fallbackSeed = Date.now();
  args.originalStreamId = args.streamId;
  args.originalRoom = args.room;
  args.streamId = sanitizeId(args.streamId, 64, `dual_quality_${fallbackSeed}`);
  args.room = sanitizeId(args.room, 30, `dual_room_${fallbackSeed}`);
  args.streamIdNormalized = args.streamId !== args.originalStreamId;
  args.roomNormalized = args.room !== args.originalRoom;

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
    const resolved = path.resolve(explicitPath);
    return fs.existsSync(resolved) ? resolved : '';
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
  query.set('room', config.room);
  query.set('solo', '');
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

  const durationMs = Math.max(240000, config.startupDelayMs + config.timeoutMs + config.holdMs + 90000);
  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--password=${config.password}`,
    `--room=${config.room}`,
    `--label=${config.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    '--max-viewers=12'
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

function stopProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }
  proc.kill();
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
  return { ok: false, stage: stageLabel, state: lastState };
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

async function installInfoProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc', uuid: peerUuid };
    }

    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__gameCaptureInfoProbe || { records: [] };
    if (!Array.isArray(probe.records)) {
      probe.records = [];
    }
    window.__gameCaptureInfoProbe = probe;

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
        if (parsed && (parsed.info || parsed.ack === 'init' || parsed.miniInfo)) {
          probe.records.push({
            ts: Date.now(),
            channel: channelName,
            message: parsed
          });
          if (probe.records.length > 200) {
            probe.records.shift();
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
      if (channel.__gameCaptureInfoProbeAttached) {
        return true;
      }
      channel.__gameCaptureInfoProbeAttached = true;
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

async function waitForTierInfo(page, expectedTier, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((tier) => {
      const probe = window.__gameCaptureInfoProbe || { records: [] };
      const records = Array.isArray(probe.records) ? probe.records : [];
      const infoRecord = records.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        return !!info && String(info.assigned_tier || '').toLowerCase() === String(tier).toLowerCase();
      }) || null;
      const latestInfo = records.filter((entry) => entry && entry.message && entry.message.info).slice(-1)[0] || null;
      const latestMini = records.filter((entry) => entry && entry.message && entry.message.miniInfo).slice(-1)[0] || null;
      const initAck = records.filter((entry) => entry && entry.message && entry.message.ack === 'init').slice(-1)[0] || null;
      return {
        totalRecords: records.length,
        infoRecord,
        latestInfo,
        latestMini,
        initAck
      };
    }, expectedTier);

    if (last && last.infoRecord) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'tier-info', state: last };
}

function validateTierInfo(tier, info, sceneMinBitrateKbps) {
  if (!info) {
    return { ok: false, reason: 'missing_info' };
  }
  const assignedTier = String(info.assigned_tier || '').toLowerCase();
  if (assignedTier !== tier) {
    return { ok: false, reason: `assigned_tier=${assignedTier}` };
  }
  if (tier === 'lq') {
    if (Number(info.width_url) !== LQ_WIDTH || Number(info.height_url) !== LQ_HEIGHT) {
      return { ok: false, reason: `lq_resolution=${info.width_url}x${info.height_url}` };
    }
    if (Number(info.fps_url) !== LQ_FPS) {
      return { ok: false, reason: `lq_fps=${info.fps_url}` };
    }
    if (Number(info.quality_url) !== LQ_BITRATE) {
      return { ok: false, reason: `lq_bitrate=${info.quality_url}` };
    }
    return { ok: true };
  }
  if (Number(info.quality_url) < sceneMinBitrateKbps) {
    return { ok: false, reason: `hq_bitrate=${info.quality_url}` };
  }
  return { ok: true };
}

async function openRoleViewer(context, viewerUrl, role, expectedTier, config) {
  const page = await context.newPage();
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const peerState = await waitForSessionPeer(page, Math.max(10000, Math.floor(config.timeoutMs / 2)));
  if (!peerState || !peerState.ready) {
    return { ok: false, stage: `${role}-session-peer`, state: peerState, page };
  }

  const initPayload = {
    init: {
      role,
      room: true,
      video: true,
      audio: true,
      label: `${role}-viewer`,
      system: {
        app: 'game-capture-e2e-dual-quality',
        version: '1',
        platform: 'playwright',
        browser: 'chromium'
      }
    }
  };
  const initDeadlineMs = Math.max(8000, Math.floor(config.timeoutMs / 2));
  const initStart = Date.now();
  let sendResult = null;
  while (Date.now() - initStart < initDeadlineMs) {
    sendResult = await sendDataMessage(page, initPayload);
    if (sendResult && sendResult.ok) {
      break;
    }
    await wait(400);
  }
  if (!sendResult || !sendResult.ok) {
    return { ok: false, stage: `${role}-send-init`, state: sendResult, page };
  }

  const decodeResult = await waitForDecodedVideo(page, config.timeoutMs, `${role}-decoded`);
  if (!decodeResult.ok) {
    return { ok: false, stage: `${role}-decode`, state: decodeResult.state, page };
  }

  const videos = decodeResult.state && Array.isArray(decodeResult.state.videos) ? decodeResult.state.videos : [];
  const decoded = videos.find((video) =>
    video && Number(video.width) > 0 && Number(video.height) > 0 && Number(video.currentTime) > 0) || videos[0] || null;
  if (!decoded) {
    return { ok: false, stage: `${role}-decoded-metadata`, state: decodeResult.state, page };
  }

  if (expectedTier === 'lq') {
    if (Number(decoded.width) !== LQ_WIDTH || Number(decoded.height) !== LQ_HEIGHT) {
      return {
        ok: false,
        stage: `${role}-lq-dimensions`,
        state: { width: decoded.width, height: decoded.height, decoded: decodeResult.state },
        page
      };
    }
  } else if (Number(decoded.width) <= LQ_WIDTH && Number(decoded.height) <= LQ_HEIGHT) {
    return {
      ok: false,
      stage: `${role}-hq-dimensions`,
      state: { width: decoded.width, height: decoded.height, decoded: decodeResult.state },
      page
    };
  }

  return {
    ok: true,
    page,
    peerState,
    decodeState: decodeResult.state,
    decodedDimensions: { width: decoded.width, height: decoded.height }
  };
}

async function captureScreenshots(entries, screenshotDir, streamId, isFailure) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const out = [];
  for (const entry of entries) {
    if (!entry || !entry.page) {
      continue;
    }
    const role = entry.role || 'viewer';
    const shotPath = path.join(
      screenshotDir,
      `dual-quality-${isFailure ? 'fail' : 'pass'}-${streamId}-${role}-${nowStamp()}.png`
    );
    await entry.page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    out.push(shotPath);
  }
  return out;
}

function writeReport(config, startedAt, finishedAt, sceneResult, guestResult, failure, publisherOutput, screenshots) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `dual-quality-${nowStamp()}.md`);
  const passed = !failure;
  const lines = [
    '# Dual Quality E2E Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${passed ? 'PASS' : 'FAIL'}`,
    `- Duration (s): ${Math.round((finishedAt - startedAt) / 1000)}`,
    `- Stream: ${config.streamId}`,
    `- Room: ${config.room}`,
    `- Password: ${config.password}`,
    `- Scene role: ${config.sceneRole}`,
    `- Guest role: ${config.guestRole}`,
    '',
    '## Stream Validation',
    '',
    `- Scene decoded dimensions: ${sceneResult && sceneResult.decodedDimensions ? `${sceneResult.decodedDimensions.width}x${sceneResult.decodedDimensions.height}` : '(none)'}`,
    `- Guest decoded dimensions: ${guestResult && guestResult.decodedDimensions ? `${guestResult.decodedDimensions.width}x${guestResult.decodedDimensions.height}` : '(none)'}`,
    '',
    '## Expected LQ Profile',
    '',
    `- Width: ${LQ_WIDTH}`,
    `- Height: ${LQ_HEIGHT}`,
    `- FPS: ${LQ_FPS}`,
    `- Bitrate kbps: ${LQ_BITRATE}`
  ];

  if (failure) {
    lines.push('', '## Failure', '', `- Stage: ${failure.stage}`, `- State: ${JSON.stringify(failure.state || {})}`);
  }

  if (screenshots && screenshots.length) {
    lines.push('', '## Screenshots', '');
    for (const shot of screenshots) {
      lines.push(`- ${shot}`);
    }
  }

  lines.push('', '## Publisher Output (tail)', '', '```text');
  lines.push(...publisherOutput.trim().split(/\r?\n/).slice(-220));
  lines.push('```', '');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

async function main() {
  const config = parseArgs(process.argv);
  const viewerUrl = buildViewerUrl(config);

  console.log(`[DUAL-QUALITY] Stream: ${config.streamId}`);
  console.log(`[DUAL-QUALITY] Room: ${config.room}`);
  if (config.streamIdNormalized || config.roomNormalized) {
    console.log(
      `[DUAL-QUALITY] Normalized IDs from stream='${config.originalStreamId}' room='${config.originalRoom}'`
    );
  }
  console.log(`[DUAL-QUALITY] URL: ${viewerUrl}`);

  const publisher = spawnPublisher(config);
  console.log(`[DUAL-QUALITY] Spawned publisher: ${publisher.command} ${publisher.args.join(' ')}`);
  await wait(config.startupDelayMs);

  const browser = await chromium.launch({
    headless: !config.headful,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true
  });

  const startedAt = Date.now();
  const opened = [];
  let sceneResult = null;
  let guestResult = null;
  let failure = null;
  let screenshots = [];

  try {
    sceneResult = await openRoleViewer(context, viewerUrl, config.sceneRole, 'hq', config);
    sceneResult.role = 'scene';
    opened.push(sceneResult);
    if (!sceneResult.ok) {
      failure = { stage: sceneResult.stage, state: sceneResult.state };
      return;
    }
    console.log('[DUAL-QUALITY] Scene viewer validated (HQ)');

    guestResult = await openRoleViewer(context, viewerUrl, config.guestRole, 'lq', config);
    guestResult.role = 'guest';
    opened.push(guestResult);
    if (!guestResult.ok) {
      failure = { stage: guestResult.stage, state: guestResult.state };
      return;
    }
    console.log('[DUAL-QUALITY] Guest viewer validated (LQ)');

    await wait(config.holdMs);

    const sceneHold = await collectState(sceneResult.page);
    const guestHold = await collectState(guestResult.page);
    if (!sceneHold.hasDecodedVideo) {
      failure = { stage: 'scene-hold', state: sceneHold };
      return;
    }
    if (!guestHold.hasDecodedVideo) {
      failure = { stage: 'guest-hold', state: guestHold };
      return;
    }

    const publisherLog = publisher.stdout.join('');
    if (!publisherLog.includes('tier=hq') || !publisherLog.includes('tier=lq')) {
      failure = {
        stage: 'publisher-tier-log',
        state: {
          hasHq: publisherLog.includes('tier=hq'),
          hasLq: publisherLog.includes('tier=lq')
        }
      };
      return;
    }

    screenshots = await captureScreenshots(opened, config.screenshotDir, config.streamId, false);
    console.log('[DUAL-QUALITY] PASS');
  } finally {
    if (failure) {
      screenshots = await captureScreenshots(opened, config.screenshotDir, config.streamId, true);
      console.error(`[DUAL-QUALITY] FAIL at stage ${failure.stage}`);
      console.error(`[DUAL-QUALITY] State: ${JSON.stringify(failure.state || {})}`);
    }

    for (const entry of opened) {
      if (entry && entry.page) {
        await entry.page.close().catch(() => {});
      }
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    stopProcess(publisher.proc);

    const finishedAt = Date.now();
    const publisherOutput = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
    const reportPath = writeReport(
      config,
      startedAt,
      finishedAt,
      sceneResult && sceneResult.ok ? sceneResult : null,
      guestResult && guestResult.ok ? guestResult : null,
      failure,
      publisherOutput,
      screenshots
    );
    console.log(`[DUAL-QUALITY] Report: ${reportPath}`);
    process.exitCode = failure ? 1 : 0;
  }
}

main().catch((err) => {
  console.error('[DUAL-QUALITY] Unhandled error:', err);
  process.exit(1);
});

