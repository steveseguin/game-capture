#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const LQ_WIDTH = 640;
const LQ_HEIGHT = 360;
const DEFAULT_REMOTE_TOKEN = 'dual-requirements-token';
const ROOM_INIT_TIMEOUT_MS = 7000;

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

function buildScopedId(base, maxLen, suffix, fallbackPrefix) {
  const safeSuffix = sanitizeId(suffix, Math.max(1, maxLen - 2), 'case');
  const withSuffix = `_${safeSuffix}`;
  const baseLimit = Math.max(1, maxLen - withSuffix.length);
  const fallback = `${fallbackPrefix}_${Date.now()}`;
  const normalizedBase = sanitizeId(base, baseLimit, fallback);
  const scopedBase = normalizedBase.length > baseLimit ? normalizedBase.slice(0, baseLimit) : normalizedBase;
  return `${scopedBase}${withSuffix}`;
}

function parseArgs(argv) {
  const seed = Date.now();
  const args = {
    streamId: `dual_req_${seed}`,
    room: `dual_req_room_${seed}`,
    password: '',
    label: 'dual-quality-requirements',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 60000,
    holdMs: 2500,
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    remoteToken: DEFAULT_REMOTE_TOKEN,
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
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--video-encoder=')) {
      args.videoEncoder = arg.slice('--video-encoder='.length);
    } else if (arg.startsWith('--ffmpeg-path=')) {
      args.ffmpegPath = arg.slice('--ffmpeg-path='.length);
    } else if (arg.startsWith('--ffmpeg-options=')) {
      args.ffmpegOptions = arg.slice('--ffmpeg-options='.length);
    } else if (arg.startsWith('--remote-token=')) {
      args.remoteToken = arg.slice('--remote-token='.length);
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
  args.streamId = sanitizeId(args.streamId, 64, `dual_req_${fallbackSeed}`);
  args.room = sanitizeId(args.room, 30, `dual_req_room_${fallbackSeed}`);
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

function buildViewerUrl(streamId, room, password) {
  const query = new URLSearchParams();
  query.set('view', streamId);
  query.set('autostart', '');
  query.set('muted', '');
  if (room) {
    query.set('room', room);
    query.set('solo', '');
  }
  if (password) {
    query.set('password', password);
  }
  return `https://vdo.ninja/?${query.toString()}`;
}

function spawnPublisher(config, options) {
  const command = detectPublisherBinary(config.publisherPath);
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
  }

  const durationMs = Math.max(
    240000,
    config.startupDelayMs + (config.timeoutMs * 2) + config.holdMs + 90000
  );
  const args = [
    '--headless',
    `--stream=${options.streamId}`,
    `--password=${config.password}`,
    `--room=${options.room}`,
    `--label=${options.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    `--max-viewers=${Math.max(1, Number(options.maxViewers) || 1)}`
  ];

  if (options.remoteToken) {
    args.push('--remote-control');
    args.push(`--remote-token=${options.remoteToken}`);
  }
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

function stopProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }
  proc.kill();
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertOk(condition, message, state) {
  if (!condition) {
    const detail = state ? ` ${JSON.stringify(state)}` : '';
    throw new Error(`${message}${detail}`);
  }
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

function pickDecodedVideo(state) {
  const videos = state && Array.isArray(state.videos) ? state.videos : [];
  return videos.find((v) =>
    v && Number(v.width) > 0 && Number(v.height) > 0 && Number(v.currentTime) > 0) || videos[0] || null;
}

async function waitForDecodedVideo(page, timeoutMs, stageLabel) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await collectState(page);
    if (last.hasDecodedVideo) {
      return { ok: true, state: last };
    }
    await wait(1000);
  }
  return { ok: false, stage: stageLabel, state: last };
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

async function sendWithRetry(page, payload, timeoutMs, intervalMs = 350) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await sendDataMessage(page, payload);
    if (last && last.ok) {
      return last;
    }
    await wait(intervalMs);
  }
  return last || { ok: false, reason: 'timeout' };
}

async function sendInitMessage(page, room, role, video, audio, label, timeoutMs) {
  const payload = {
    init: {
      role,
      room: !!room,
      video: !!video,
      audio: !!audio,
      label,
      system: {
        app: 'game-capture-e2e-dual-requirements',
        version: '1',
        platform: 'playwright',
        browser: 'chromium'
      }
    }
  };
  return sendWithRetry(page, payload, timeoutMs);
}

async function installInfoProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc' };
    }
    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__gameCaptureInfoProbe || { records: [] };
    if (!Array.isArray(probe.records)) {
      probe.records = [];
    }
    window.__gameCaptureInfoProbe = probe;

    const parseMessage = (event, channelName) => {
      if (!event || typeof event.data !== 'string') {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && (parsed.info || parsed.ack)) {
          probe.records.push({
            ts: Date.now(),
            channel: channelName,
            message: parsed
          });
          if (probe.records.length > 400) {
            probe.records.shift();
          }
        }
      } catch {
        // Ignore malformed payloads.
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

    return {
      ok: attach(rpc.receiveChannel, 'receiveChannel') || attach(rpc.sendChannel, 'sendChannel')
    };
  }, uuid);
}

async function waitForInfoField(page, fieldName, expectedValue, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ field, expected }) => {
      const probe = window.__gameCaptureInfoProbe || { records: [] };
      const records = Array.isArray(probe.records) ? probe.records : [];
      const infoRecords = records
        .filter((entry) => entry && entry.message && entry.message.info)
        .map((entry) => entry.message.info);
      const match = infoRecords.find((info) => {
        const value = info ? info[field] : undefined;
        return value === expected;
      }) || null;
      const latest = infoRecords.length ? infoRecords[infoRecords.length - 1] : null;
      return {
        total: records.length,
        infoCount: infoRecords.length,
        latest,
        match
      };
    }, { field: fieldName, expected: expectedValue });
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'info-field', state: last };
}

async function installControlAckProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc' };
    }
    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__gameCaptureControlProbe || { acks: [] };
    if (!Array.isArray(probe.acks)) {
      probe.acks = [];
    }
    window.__gameCaptureControlProbe = probe;

    const parseMessage = (event, channelName) => {
      if (!event || typeof event.data !== 'string') {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && parsed.ack === 'control') {
          probe.acks.push({
            ts: Date.now(),
            channel: channelName,
            message: parsed
          });
          if (probe.acks.length > 100) {
            probe.acks.shift();
          }
        }
      } catch {
        // Ignore malformed payloads.
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

    return {
      ok: attach(rpc.receiveChannel, 'receiveChannel') || attach(rpc.sendChannel, 'sendChannel')
    };
  }, uuid);
}

async function waitForControlAck(page, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(() => {
      const probe = window.__gameCaptureControlProbe || { acks: [] };
      const acks = Array.isArray(probe.acks) ? probe.acks : [];
      const okAck = acks.find((entry) => entry && entry.message && entry.message.ok === true) || null;
      const latest = acks.length ? acks[acks.length - 1] : null;
      return { count: acks.length, okAck, latest };
    });
    if (last && last.okAck) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'control-ack', state: last };
}

async function waitForPublisherLog(publisher, pattern, timeoutMs) {
  const start = Date.now();
  const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  while (Date.now() - start < timeoutMs) {
    const output = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
    if (regex.test(output)) {
      return { ok: true };
    }
    await wait(250);
  }
  const finalOutput = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
  return { ok: false, outputTail: finalOutput.trim().split(/\r?\n/).slice(-40).join('\n') };
}

async function openRoleViewerOnce(context, viewerUrl, room, role, expectedTier, config, tag) {
  const page = await context.newPage();
  try {
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peerState = await waitForSessionPeer(page, Math.max(10000, Math.floor(config.timeoutMs / 2)));
    assertOk(peerState && peerState.ready, `${tag}: session peer unavailable`, peerState);

    const initResult = await sendInitMessage(
      page,
      room,
      role,
      true,
      true,
      `${tag}-${role}`,
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(initResult && initResult.ok, `${tag}: init send failed`, initResult);

    const decodeResult = await waitForDecodedVideo(page, config.timeoutMs, `${tag}-decode`);
    assertOk(decodeResult.ok, `${tag}: decode failed`, decodeResult.state || decodeResult);

    const decoded = pickDecodedVideo(decodeResult.state);
    assertOk(decoded, `${tag}: missing decoded metadata`, decodeResult.state);

    const dims = { width: Number(decoded.width) || 0, height: Number(decoded.height) || 0 };
    if (expectedTier === 'lq') {
      assertOk(
        dims.width === LQ_WIDTH && dims.height === LQ_HEIGHT,
        `${tag}: expected LQ dimensions`,
        dims
      );
    } else if (expectedTier === 'hq') {
      assertOk(
        !(dims.width <= LQ_WIDTH && dims.height <= LQ_HEIGHT),
        `${tag}: expected HQ dimensions`,
        dims
      );
    }

    return {
      page,
      peerUuid: peerState.uuid,
      dimensions: dims,
      decodeState: decodeResult.state
    };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function openRoleViewer(context, viewerUrl, room, role, expectedTier, config, tag, attempts = 3) {
  const maxAttempts = Math.max(1, attempts);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await openRoleViewerOnce(
        context,
        viewerUrl,
        room,
        role,
        expectedTier,
        config,
        `${tag}-attempt-${attempt}`
      );
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await wait(1200);
      }
    }
  }
  throw lastError || new Error(`${tag}: openRoleViewer failed`);
}

async function captureCaseScreenshots(caseResult, pages) {
  if (!pages || !pages.length) {
    return [];
  }
  fs.mkdirSync(caseResult.screenshotDir, { recursive: true });
  const shots = [];
  for (let i = 0; i < pages.length; i++) {
    if (i >= 3) {
      break;
    }
    const page = pages[i];
    if (!page || page.isClosed()) {
      continue;
    }
    const shotPath = path.join(
      caseResult.screenshotDir,
      `dual-quality-requirements-${caseResult.name}-fail-${i + 1}-${nowStamp()}.png`
    );
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    shots.push(shotPath);
  }
  return shots;
}

async function executeCase(name, config, opts, scenarioFn) {
  const caseIdSuffix = sanitizeId(opts.idSuffix || name, 20, 'case');
  const streamId = buildScopedId(config.streamId, 64, caseIdSuffix, 'dual_req');
  const room = opts.roomMode ? buildScopedId(config.room, 30, caseIdSuffix, 'dual_room') : '';
  const caseLabel = `${config.label}-${name}`;
  const viewerUrl = buildViewerUrl(streamId, room, config.password);
  const publisher = spawnPublisher(config, {
    streamId,
    room,
    label: caseLabel,
    maxViewers: opts.maxViewers || 8,
    remoteToken: opts.remoteToken || ''
  });

  const startedAt = Date.now();
  const caseState = {
    name,
    startedAt,
    streamId,
    room,
    viewerUrl,
    screenshotDir: config.screenshotDir,
    pass: false,
    failure: null,
    screenshots: [],
    publisherOutput: ''
  };

  await wait(config.startupDelayMs);

  const browser = await chromium.launch({
    headless: !config.headful,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true
  });
  const openedPages = [];

  try {
    await scenarioFn({
      config,
      caseState,
      context,
      publisher,
      streamId,
      room,
      viewerUrl,
      openedPages
    });
    caseState.pass = true;
  } catch (err) {
    caseState.failure = {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : ''
    };
    caseState.screenshots = await captureCaseScreenshots(caseState, openedPages);
  } finally {
    for (const page of openedPages) {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    stopProcess(publisher.proc);
    caseState.finishedAt = Date.now();
    caseState.publisherOutput = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
  }

  return caseState;
}

async function caseDirectHqOnly(input) {
  const { context, viewerUrl, openedPages, caseState } = input;
  console.log(`[DUAL-REQ] [${caseState.name}] URL: ${viewerUrl}`);

  const page = await context.newPage();
  openedPages.push(page);
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const decode = await waitForDecodedVideo(page, 45000, 'direct-decode');
  assertOk(decode.ok, 'direct-hq-only: decode failed', decode.state || decode);

  const decoded = pickDecodedVideo(decode.state);
  assertOk(decoded, 'direct-hq-only: missing decoded metadata', decode.state);
  const dims = { width: Number(decoded.width) || 0, height: Number(decoded.height) || 0 };
  assertOk(
    !(dims.width <= LQ_WIDTH && dims.height <= LQ_HEIGHT),
    'direct-hq-only: expected HQ dimensions',
    dims
  );
}

async function caseRoomInitTimeout(input) {
  const { context, viewerUrl, openedPages, publisher } = input;
  const page = await context.newPage();
  openedPages.push(page);
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const peerState = await waitForSessionPeer(page, 12000);
  assertOk(peerState && peerState.ready, 'room-init-timeout: session peer unavailable', peerState);

  await wait(ROOM_INIT_TIMEOUT_MS + 3500);
  const state = await collectState(page);
  assertOk(!state.hasDecodedVideo, 'room-init-timeout: decoded video before init timeout', state);

  const timeoutLog = await waitForPublisherLog(publisher, /missing init payload/i, 6000);
  assertOk(timeoutLog.ok, 'room-init-timeout: missing timeout disconnect log', timeoutLog);
}

async function caseMaxViewers(input) {
  const { context, viewerUrl, openedPages, room, config, publisher } = input;
  const scene = await openRoleViewer(context, viewerUrl, room, 'scene', 'hq', config, 'max-scene', 4);
  const guest = await openRoleViewer(context, viewerUrl, room, 'guest', 'lq', config, 'max-guest', 4);
  openedPages.push(scene.page);
  openedPages.push(guest.page);

  const thirdPage = await context.newPage();
  openedPages.push(thirdPage);
  await thirdPage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const peerState = await waitForSessionPeer(thirdPage, 8000);
  if (peerState && peerState.ready) {
    const initResult = await sendInitMessage(
      thirdPage,
      room,
      'guest',
      true,
      true,
      'max-third',
      5000
    );
    if (initResult && initResult.ok) {
      const decode = await waitForDecodedVideo(thirdPage, 12000, 'max-third-decode');
      assertOk(!decode.ok, 'max-viewers: third viewer unexpectedly decoded', decode.state || decode);
    }
  }

  const limitLog = await waitForPublisherLog(publisher, /Viewer limit reached/i, 10000);
  assertOk(limitLog.ok, 'max-viewers: missing viewer limit log', limitLog);

  const sceneHold = await collectState(scene.page);
  const guestHold = await collectState(guest.page);
  assertOk(sceneHold.hasDecodedVideo, 'max-viewers: scene dropped after third join', sceneHold);
  assertOk(guestHold.hasDecodedVideo, 'max-viewers: guest dropped after third join', guestHold);
}

async function caseReconnectControlMedia(input) {
  const { context, viewerUrl, openedPages, room, config } = input;

  const scene = await openRoleViewer(context, viewerUrl, room, 'scene', 'hq', config, 'ctrl-scene', 6);
  const guest = await openRoleViewer(context, viewerUrl, room, 'guest', 'lq', config, 'ctrl-guest', 4);
  openedPages.push(scene.page);
  openedPages.push(guest.page);

  const guestProbe = await installInfoProbe(guest.page, guest.peerUuid);
  assertOk(guestProbe.ok, 'reconnect-control-media: failed to install guest info probe', guestProbe);

  const muteGuest = await sendInitMessage(
    guest.page,
    room,
    'guest',
    true,
    false,
    'guest-no-audio',
    8000
  );
  assertOk(muteGuest.ok, 'reconnect-control-media: failed to send guest audio=false init', muteGuest);

  const mutedInfo = await waitForInfoField(guest.page, 'peer_audio_enabled', false, 8000);
  assertOk(mutedInfo.ok, 'reconnect-control-media: missing peer_audio_enabled=false info', mutedInfo.state || mutedInfo);

  const unmuteGuest = await sendInitMessage(
    guest.page,
    room,
    'guest',
    true,
    true,
    'guest-audio-recovery',
    8000
  );
  assertOk(unmuteGuest.ok, 'reconnect-control-media: failed to send guest audio=true init', unmuteGuest);

  const unmutedInfo = await waitForInfoField(guest.page, 'peer_audio_enabled', true, 8000);
  assertOk(unmutedInfo.ok, 'reconnect-control-media: missing peer_audio_enabled=true info', unmutedInfo.state || unmutedInfo);

  const controlProbe = await installControlAckProbe(scene.page, scene.peerUuid);
  assertOk(controlProbe.ok, 'reconnect-control-media: failed to install control ack probe', controlProbe);

  const controlSend = await sendWithRetry(scene.page, {
    keyframe: true,
    requestStats: true,
    targetBitrate: 3500,
    requestResolution: { w: 960, h: 540, f: 30 },
    remote: config.remoteToken
  }, 8000);
  assertOk(controlSend.ok, 'reconnect-control-media: failed to send control payload', controlSend);

  const controlAck = await waitForControlAck(scene.page, 10000);
  assertOk(controlAck.ok, 'reconnect-control-media: missing control ack', controlAck.state || controlAck);

  await wait(config.holdMs);
  const scenePostResult = await waitForDecodedVideo(scene.page, 15000, 'ctrl-scene-post-control');
  const guestPostResult = await waitForDecodedVideo(guest.page, 15000, 'ctrl-guest-post-control');
  assertOk(
    scenePostResult.ok,
    'reconnect-control-media: scene decode lost after control',
    scenePostResult.state || scenePostResult
  );
  assertOk(
    guestPostResult.ok,
    'reconnect-control-media: guest decode lost after control',
    guestPostResult.state || guestPostResult
  );

  const guestDecoded = pickDecodedVideo(guestPostResult.state);
  assertOk(
    guestDecoded && Number(guestDecoded.width) === LQ_WIDTH && Number(guestDecoded.height) === LQ_HEIGHT,
    'reconnect-control-media: guest dimensions changed from LQ after control',
    guestDecoded
  );

  await guest.page.close().catch(() => {});
  const idx = openedPages.indexOf(guest.page);
  if (idx >= 0) {
    openedPages.splice(idx, 1);
  }

  const rejoinedGuest = await openRoleViewer(
    context,
    viewerUrl,
    room,
    'guest',
    'lq',
    config,
    'ctrl-guest-rejoin',
    4
  );
  openedPages.push(rejoinedGuest.page);

  const sceneAfterRejoin = await collectState(scene.page);
  assertOk(sceneAfterRejoin.hasDecodedVideo, 'reconnect-control-media: scene decode lost after guest reconnect', sceneAfterRejoin);
}

function summarizeCaseFailure(caseResult) {
  if (caseResult.pass) {
    return '';
  }
  if (!caseResult.failure) {
    return 'unknown failure';
  }
  return caseResult.failure.message || 'unknown failure';
}

function writeReport(config, startedAt, finishedAt, cases) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `dual-quality-requirements-${nowStamp()}.md`);
  const allPass = cases.every((entry) => entry.pass);
  const lines = [
    '# Dual Quality Requirements E2E Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${allPass ? 'PASS' : 'FAIL'}`,
    `- Duration (s): ${Math.round((finishedAt - startedAt) / 1000)}`,
    `- Stream base: ${config.streamId}`,
    `- Room base: ${config.room}`,
    `- Password: ${config.password}`,
    `- Remote token length: ${config.remoteToken.length}`,
    '',
    '| Case | Stream | Room | Duration (s) | Result |',
    '|---|---|---|---:|:---:|'
  ];

  for (const entry of cases) {
    const durationSec = Math.round(((entry.finishedAt || entry.startedAt) - entry.startedAt) / 1000);
    lines.push(
      `| ${entry.name} | ${entry.streamId} | ${entry.room || '(none)'} | ${durationSec} | ${entry.pass ? 'PASS' : 'FAIL'} |`
    );
  }

  for (const entry of cases) {
    lines.push('', `## Case: ${entry.name}`, '');
    lines.push(`- Result: ${entry.pass ? 'PASS' : 'FAIL'}`);
    lines.push(`- URL: ${entry.viewerUrl}`);
    if (!entry.pass) {
      lines.push(`- Failure: ${summarizeCaseFailure(entry)}`);
      if (entry.screenshots && entry.screenshots.length) {
        lines.push('- Screenshots:');
        for (const shot of entry.screenshots) {
          lines.push(`  - ${shot}`);
        }
      }
    }
    lines.push('', '```text');
    lines.push(...entry.publisherOutput.trim().split(/\r?\n/).slice(-180));
    lines.push('```');
  }

  lines.push('');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return { reportPath, allPass };
}

async function main() {
  const config = parseArgs(process.argv);
  console.log(`[DUAL-REQ] Stream base: ${config.streamId}`);
  console.log(`[DUAL-REQ] Room base: ${config.room}`);
  if (config.streamIdNormalized || config.roomNormalized) {
    console.log(
      `[DUAL-REQ] Normalized IDs from stream='${config.originalStreamId}' room='${config.originalRoom}'`
    );
  }

  const cases = [];
  const startedAt = Date.now();

  cases.push(await executeCase(
    'direct_hq_only',
    config,
    { roomMode: false, maxViewers: 4, remoteToken: '', idSuffix: 'dirhq' },
    caseDirectHqOnly
  ));
  {
    const entry = cases[cases.length - 1];
    if (entry.pass) {
      const output = entry.publisherOutput || '';
      if (/tier=lq/i.test(output) || /LQ encoder active/i.test(output)) {
        entry.pass = false;
        entry.failure = {
          message: 'direct-hq-only: observed LQ path in publisher output'
        };
      }
    }
  }

  if (cases[cases.length - 1].pass) {
    cases.push(await executeCase(
      'room_init_timeout',
      config,
      { roomMode: true, maxViewers: 4, remoteToken: '', idSuffix: 'inittime' },
      caseRoomInitTimeout
    ));
  }

  if (cases[cases.length - 1].pass) {
    cases.push(await executeCase(
      'room_max_viewers',
      config,
      { roomMode: true, maxViewers: 2, remoteToken: '', idSuffix: 'maxv' },
      caseMaxViewers
    ));
  }

  if (cases[cases.length - 1].pass) {
    cases.push(await executeCase(
      'reconnect_control_media',
      config,
      {
        roomMode: true,
        maxViewers: 6,
        remoteToken: config.remoteToken || DEFAULT_REMOTE_TOKEN,
        idSuffix: 'ctrlrec'
      },
      caseReconnectControlMedia
    ));
  }

  const finishedAt = Date.now();
  const { reportPath, allPass } = writeReport(config, startedAt, finishedAt, cases);
  console.log(`[DUAL-REQ] Report: ${reportPath}`);
  if (allPass) {
    console.log('[DUAL-REQ] PASS');
    process.exit(0);
  }

  const failed = cases.find((entry) => !entry.pass);
  console.error('[DUAL-REQ] FAIL');
  if (failed) {
    console.error(`[DUAL-REQ] Failed case: ${failed.name}`);
    console.error(`[DUAL-REQ] Reason: ${summarizeCaseFailure(failed)}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[DUAL-REQ] Unhandled error:', err);
  process.exit(1);
});

