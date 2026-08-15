#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const LQ_WIDTH = 640;
const LQ_HEIGHT = 360;
const DEFAULT_REMOTE_TOKEN = 'dual-requirements-token';
const ROOM_INIT_TIMEOUT_MS = 7000;
const ROOM_QUALITY_WARNING_SUFFIX =
  'continuing HQ-only without changing the selected codec or alpha workflow.';
const ROOM_QUALITY_REASON = Object.freeze({
  ENABLED: 'enabled',
  NOT_IN_ROOM: 'not-in-room',
  NOT_REQUESTED: 'not-requested',
  CODEC_NOT_H264: 'codec-not-h264'
});
const H265_STARTUP_FALLBACK_WARNING =
  'Selected H.265 encoder failed to initialize; trying H.264 fallback';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function roomQualityUnavailableWarning(codecName) {
  return `Room Quality is unavailable with ${codecName}; ${ROOM_QUALITY_WARNING_SUFFIX}`;
}

function resolveH265RoomQualityExpectation(roomQuality, publisherOutput) {
  const committedCodec = roomQuality && roomQuality.committed_codec;
  if (committedCodec === 'H.265') {
    return {
      caseTag: 'h265-selected',
      assignedTier: 'hq',
      codecName: 'H.265',
      requested: true,
      effective: false,
      reason: ROOM_QUALITY_REASON.CODEC_NOT_H264,
      unsupportedVideoBitrateKbps: 500,
      warningCount: 1,
      warningText: roomQualityUnavailableWarning('H.265'),
      noLq: true,
      alphaActive: false,
      selectionOutcome: 'preserved'
    };
  }
  if (committedCodec === 'H.264' &&
      String(publisherOutput || '').includes(H265_STARTUP_FALLBACK_WARNING)) {
    return {
      caseTag: 'h265-startup-fallback-h264',
      assignedTier: 'lq',
      codecName: 'H.264',
      requested: true,
      effective: true,
      reason: ROOM_QUALITY_REASON.ENABLED,
      unsupportedVideoBitrateKbps: 500,
      warningCount: 0,
      warningText: '',
      noLq: false,
      alphaActive: false,
      dimensionsTier: 'lq',
      selectionOutcome: 'explicit-encoder-unavailable-fallback'
    };
  }
  throw new Error(
    `H.265 startup resolved to unexpected codec ${JSON.stringify(committedCodec)} ` +
    `without the required explicit encoder-unavailable fallback evidence`
  );
}

function publisherOutputText(publisher) {
  if (!publisher) {
    return '';
  }
  return `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
}

function countLiteralOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) {
      break;
    }
    count++;
    offset = index + needle.length;
  }
  return count;
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
    cases: [],
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
    } else if (arg.startsWith('--cases=')) {
      args.cases = arg
        .slice('--cases='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
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
  args.caseFilter = args.cases.length ? new Set(args.cases) : null;
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

  if (options.roomModeLqEnabled === false) {
    args.push('--disable-room-lq');
  }
  if (options.videoCodec) {
    args.push(`--video-codec=${options.videoCodec}`);
  }
  if (options.alphaWorkflow) {
    args.push('--alpha-workflow');
  }
  if (options.diagnosticsOut) {
    args.push(`--diagnostics-out=${options.diagnosticsOut}`);
  }

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
    env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM ||
      (fs.existsSync(path.join(qtPluginPath, 'platforms', 'qoffscreen.dll')) ? 'offscreen' : 'windows');
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
        if (parsed && typeof parsed === 'object') {
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

async function waitForInfoProbe(page, uuid, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    last = await installInfoProbe(page, uuid);
    if (last && last.ok) {
      return last;
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(250);
  }
  return last || { ok: false, reason: 'timeout' };
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

async function getInfoRecordCount(page) {
  return page.evaluate(() => {
    const probe = window.__gameCaptureInfoProbe || { records: [] };
    return Array.isArray(probe.records) ? probe.records.length : 0;
  });
}

async function waitForInfoFieldAfter(page, fieldName, expectedValue, minRecordCount, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ field, expected, minCount }) => {
      const probe = window.__gameCaptureInfoProbe || { records: [] };
      const records = Array.isArray(probe.records) ? probe.records : [];
      const newRecords = records.slice(Math.max(0, minCount));
      const infoRecords = newRecords
        .filter((entry) => entry && entry.message && entry.message.info)
        .map((entry) => entry.message.info);
      const match = infoRecords.find((info) => info && info[field] === expected) || null;
      return {
        total: records.length,
        minCount,
        latest: infoRecords.length ? infoRecords[infoRecords.length - 1] : null,
        match,
      };
    }, { field: fieldName, expected: expectedValue, minCount: minRecordCount });
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'info-field-after', state: last };
}

async function waitForInfoState(page, expected, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((expectedValues) => {
      const probe = window.__gameCaptureInfoProbe || { records: [] };
      const records = Array.isArray(probe.records) ? probe.records : [];
      const infoRecords = records
        .filter((entry) => entry && entry.message && entry.message.info)
        .map((entry) => entry.message.info);
      const matches = infoRecords.filter((info) => Object.entries(expectedValues).every(([key, value]) => {
        if (key === 'audio') {
          return Boolean(info.muted) === !value;
        }
        if (key === 'video') {
          return Boolean(info.video_muted_init) === !value;
        }
        return info[key] === value;
      }));
      return {
        total: records.length,
        infoCount: infoRecords.length,
        latest: records.length ? records[records.length - 1].message : null,
        match: matches.length ? matches[matches.length - 1] : null
      };
    }, expected);
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'info-state', state: last };
}

async function waitForInfoStateAfter(page, expected, minRecordCount, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ expectedValues, minCount }) => {
      const probe = window.__gameCaptureInfoProbe || { records: [] };
      const records = Array.isArray(probe.records) ? probe.records : [];
      const infoRecords = records
        .slice(Math.max(0, minCount))
        .filter((entry) => entry && entry.message && entry.message.info)
        .map((entry) => entry.message.info);
      const matches = infoRecords.filter((info) => Object.entries(expectedValues).every(([key, value]) => {
        if (key === 'audio') {
          return Boolean(info.muted) === !value;
        }
        if (key === 'video') {
          return Boolean(info.video_muted_init) === !value;
        }
        return info[key] === value;
      }));
      return {
        total: records.length,
        minCount,
        infoCount: infoRecords.length,
        latest: infoRecords.length ? infoRecords[infoRecords.length - 1] : null,
        match: matches.length ? matches[matches.length - 1] : null
      };
    }, { expectedValues: expected, minCount: minRecordCount });
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'info-state-after', state: last };
}

async function waitForRejectedControlAfter(page, controlName, minRecordCount, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    last = await page.evaluate(({ expectedControl, minCount }) => {
      const probe = window.__gameCaptureInfoProbe || { records: [] };
      const records = Array.isArray(probe.records) ? probe.records : [];
      const newRecords = records.slice(Math.max(0, minCount));
      const match = newRecords.find(
        (entry) => entry && entry.message && entry.message.rejected === expectedControl
      ) || null;
      return {
        total: records.length,
        minCount,
        latest: newRecords.length ? newRecords[newRecords.length - 1].message : null,
        match: match ? match.message : null
      };
    }, { expectedControl: controlName, minCount: minRecordCount });
    if (last && last.match) {
      return { ok: true, state: last };
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(250);
  }
  return { ok: false, stage: 'rejected-control-after', state: last };
}

async function getInfoRecords(page) {
  return page.evaluate(() => {
    const probe = window.__gameCaptureInfoProbe || { records: [] };
    const records = Array.isArray(probe.records) ? probe.records : [];
    return records
      .filter((entry) => entry && entry.message && entry.message.info)
      .map((entry) => entry.message.info);
  });
}

async function waitForPublisherDiagnostics(diagnosticsPath, expectedRoomQuality, timeoutMs) {
  const start = Date.now();
  let last = null;
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = fs.readFileSync(diagnosticsPath, 'utf8').replace(/^\uFEFF/, '');
      last = JSON.parse(raw);
      const actual = last && last.room_quality;
      if (actual && Object.entries(expectedRoomQuality).every(([key, value]) => actual[key] === value)) {
        return { ok: true, diagnostics: last };
      }
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    await wait(250);
  }
  return {
    ok: false,
    stage: 'publisher-diagnostics',
    path: diagnosticsPath,
    expected: expectedRoomQuality,
    diagnostics: last,
    actual: last && last.room_quality,
    lastError
  };
}

function countRoomQualityUnavailableWarnings(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) =>
      line.includes('Room Quality is unavailable with ') &&
      line.includes(ROOM_QUALITY_WARNING_SUFFIX))
    .length;
}

function collectRoomQualityLqLeakObservations(evidence) {
  const infoRecords = evidence && Array.isArray(evidence.infoRecords) ? evidence.infoRecords : [];
  const output = evidence && evidence.publisherOutput ? evidence.publisherOutput : '';
  const diagnosticsVideo = evidence && evidence.diagnostics && evidence.diagnostics.video;
  const diagnosticsFieldPresent = !!diagnosticsVideo &&
    typeof diagnosticsVideo === 'object' &&
    Object.prototype.hasOwnProperty.call(diagnosticsVideo, 'lq_encoder_initialized');
  const diagnosticsValue = diagnosticsFieldPresent
    ? diagnosticsVideo.lq_encoder_initialized
    : undefined;
  return {
    receiverInfoLqAssignment: infoRecords.some(
      (record) => record && record.assigned_tier === 'lq'
    ),
    publisherPeerLqAssignment: /Peer init .*roomMode=1 .*tier=lq/i.test(output),
    publisherLqEncoderActive: /LQ encoder active/i.test(output),
    diagnosticsLqEncoderInitializedPresent: diagnosticsFieldPresent,
    diagnosticsLqEncoderInitialized:
      typeof diagnosticsValue === 'boolean' ? diagnosticsValue : null,
    diagnosticsLqEncoderInitializedType: typeof diagnosticsValue
  };
}

function evaluateRoomQualityContractEvidence(evidence, expected) {
  const failures = [];
  const info = evidence && evidence.info ? evidence.info : {};
  const diagnostics = evidence && evidence.diagnostics ? evidence.diagnostics.room_quality : null;
  const output = evidence && evidence.publisherOutput ? evidence.publisherOutput : '';
  const lqLeakObservations = collectRoomQualityLqLeakObservations(evidence);
  const expectedInfo = {
    assigned_tier: expected.assignedTier,
    codec_url: expected.codecName,
    video_codec: expected.codecName,
    room_quality_requested: expected.requested,
    room_quality_effective: expected.effective,
    room_quality_reason: expected.reason
  };
  if (Number.isFinite(expected.unsupportedVideoBitrateKbps)) {
    expectedInfo.requested_video_bitrate_kbps = -1;
  }
  if (expected.alphaActive === true) {
    expectedInfo.alpha_active = true;
    expectedInfo.alpha_send = 'vp9-dualtrack-v1';
  }

  for (const [field, value] of Object.entries(expectedInfo)) {
    if (info[field] !== value) {
      failures.push(`info.${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(info[field])}`);
    }
  }

  if (expected.noLq && lqLeakObservations.receiverInfoLqAssignment) {
    failures.push('receiver info emitted an LQ assignment');
  }
  if (expected.noLq && lqLeakObservations.publisherPeerLqAssignment) {
    failures.push('publisher log emitted an LQ room-peer assignment');
  }
  if (expected.noLq && lqLeakObservations.publisherLqEncoderActive) {
    failures.push('publisher log reported an active LQ encoder');
  }
  if (expected.noLq &&
      lqLeakObservations.diagnosticsLqEncoderInitializedType !== 'boolean') {
    failures.push('diagnostics.video.lq_encoder_initialized must be an explicit boolean false');
  } else if (expected.noLq && lqLeakObservations.diagnosticsLqEncoderInitialized) {
    failures.push('diagnostics.video.lq_encoder_initialized was true');
  }
  if (expected.alphaActive && !/VP9 alpha encoder active/i.test(output)) {
    failures.push('publisher never reported an active VP9 alpha encoder');
  }
  if (expected.alphaActive && /streaming without alpha|alpha output was disabled/i.test(output)) {
    failures.push('publisher reported that the selected alpha workflow was disabled');
  }
  if (expected.dimensionsTier && (!evidence.dimensions || !evidence.dimensions.ok)) {
    failures.push(`decoded output did not retain ${expected.dimensionsTier.toUpperCase()} dimensions`);
  }

  const expectedDiagnostics = {
    requested: expected.requested,
    effective: expected.effective,
    reason: expected.reason
  };
  if (!diagnostics) {
    failures.push('diagnostics.room_quality is missing');
  } else {
    for (const [field, value] of Object.entries(expectedDiagnostics)) {
      if (diagnostics[field] !== value) {
        failures.push(
          `diagnostics.room_quality.${field}: expected ${JSON.stringify(value)}, ` +
          `got ${JSON.stringify(diagnostics[field])}`
        );
      }
    }
  }

  const warningCount = countRoomQualityUnavailableWarnings(output);
  if (warningCount !== expected.warningCount) {
    failures.push(`Room Quality unavailable warning count: expected ${expected.warningCount}, got ${warningCount}`);
  }
  if (expected.warningText) {
    const exactCount = countLiteralOccurrences(output, expected.warningText);
    if (exactCount !== expected.warningCount) {
      failures.push(`exact warning count: expected ${expected.warningCount}, got ${exactCount}`);
    }
  }

  return failures;
}

function assertRoomQualityContractEvidence(evidence, expected, label) {
  const failures = evaluateRoomQualityContractEvidence(evidence, expected);
  assertOk(failures.length === 0, `${label}: Room Quality contract mismatch`, {
    failures,
    info: evidence.info,
    roomQualityDiagnostics: evidence.diagnostics && evidence.diagnostics.room_quality
  });
}

function extractPackagedRedReportEvidence(markdown) {
  const text = String(markdown || '');
  const shaMatch = /^- Publisher SHA-256:\s*([0-9a-f]{64})\s*$/im.exec(text);
  const argsMatch = /^- Publisher args:\s*(\[[^\r\n]*\])\s*$/im.exec(text);
  const failureLine = text.split(/\r?\n/).find((line) => line.startsWith('- Failure:')) || '';
  const jsonStart = failureLine.indexOf('{');
  let failureState = null;
  if (jsonStart >= 0) {
    try {
      failureState = JSON.parse(failureLine.slice(jsonStart));
    } catch {
      failureState = null;
    }
  }
  let publisherArgs = [];
  if (argsMatch) {
    try {
      publisherArgs = JSON.parse(argsMatch[1]);
    } catch {
      publisherArgs = [];
    }
  }
  const info = failureState && failureState.latest ? failureState.latest : {};
  return {
    publisherSha256: shaMatch ? shaMatch[1].toLowerCase() : '',
    publisherArgs,
    failureState,
    contractEvidence: {
      info,
      infoRecords: info && Object.keys(info).length ? [info] : [],
      diagnostics: null,
      dimensions: null,
      publisherOutput: text
    }
  };
}

async function waitForExpectedDimensions(page, expectedTier, timeoutMs, initialState = null) {
  const deadline = Date.now() + timeoutMs;
  let lastState = initialState;
  let decoded = pickDecodedVideo(lastState);

  while (Date.now() < deadline) {
    if (!decoded || !lastState || !lastState.hasDecodedVideo) {
      // eslint-disable-next-line no-await-in-loop
      lastState = await collectState(page);
      decoded = pickDecodedVideo(lastState) || decoded;
    }

    if (decoded) {
      const dims = {
        width: Number(decoded.width) || 0,
        height: Number(decoded.height) || 0
      };
      if (expectedTier === 'lq') {
        if (dims.width === LQ_WIDTH && dims.height === LQ_HEIGHT) {
          return { ok: true, state: lastState, decoded };
        }
      } else if (!(dims.width <= LQ_WIDTH && dims.height <= LQ_HEIGHT)) {
        return { ok: true, state: lastState, decoded };
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await wait(250);
    // eslint-disable-next-line no-await-in-loop
    lastState = await collectState(page);
    decoded = pickDecodedVideo(lastState) || decoded;
  }

  return { ok: false, state: lastState, decoded };
}

async function installControlInfoProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc' };
    }
    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__gameCaptureControlProbe || { messages: [] };
    if (!Array.isArray(probe.messages)) {
      probe.messages = [];
    }
    window.__gameCaptureControlProbe = probe;

    const parseMessage = (event, channelName) => {
      if (!event || typeof event.data !== 'string') {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && (parsed.info || parsed.miniInfo || parsed.remoteStats)) {
          probe.messages.push({
            ts: Date.now(),
            channel: channelName,
            message: parsed
          });
          if (probe.messages.length > 100) {
            probe.messages.shift();
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

async function waitForControlInfo(page, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(() => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const okInfo = messages.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        const width = Number(info && info.width_url);
        const height = Number(info && info.height_url);
        return info &&
          Number(info.quality_url) === 3500 &&
          width > 0 && width <= 960 &&
          height > 0 && height <= 540 &&
          (width === 960 || height === 540);
      }) || null;
      const latest = messages.length ? messages[messages.length - 1] : null;
      return { count: messages.length, okInfo, latest };
    });
    if (last && last.okInfo) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'control-info', state: last };
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

async function extractPublisherViewUrl(publisher, timeoutMs) {
  const start = Date.now();
  const pattern = /VIEW URL:\s*(https?:\/\/\S+)/;
  while (Date.now() - start < timeoutMs) {
    const output = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
    const match = pattern.exec(output);
    if (match) {
      return { ok: true, url: match[1] };
    }
    await wait(250);
  }
  return { ok: false };
}

async function openRoleInfoViewerOnce(
  context,
  viewerUrl,
  room,
  role,
  expectedInfo,
  config,
  tag
) {
  const page = await context.newPage();
  try {
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peerState = await waitForSessionPeer(page, Math.max(10000, Math.floor(config.timeoutMs / 2)));
    assertOk(peerState && peerState.ready, `${tag}: session peer unavailable`, peerState);

    const probeInstall = await waitForInfoProbe(
      page,
      peerState.uuid,
      Math.max(6000, Math.floor(config.timeoutMs / 3))
    );
    assertOk(probeInstall && probeInstall.ok, `${tag}: info probe unavailable`, probeInstall);

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

    const infoState = await waitForInfoState(
      page,
      expectedInfo,
      Math.max(6000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(infoState.ok, `${tag}: info contract mismatch`, infoState.state || infoState);

    return {
      page,
      peerUuid: peerState.uuid,
      info: infoState.state.match,
      infoState: infoState.state
    };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function openRoleInfoViewer(context, viewerUrl, room, role, expectedInfo, config, tag, attempts = 3) {
  const maxAttempts = Math.max(1, attempts);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await openRoleInfoViewerOnce(
        context,
        viewerUrl,
        room,
        role,
        expectedInfo,
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
  throw lastError || new Error(`${tag}: openRoleInfoViewer failed`);
}

async function openRoleViewerOnce(context, viewerUrl, room, role, expectedTier, config, tag) {
  const viewer = await openRoleInfoViewerOnce(
    context,
    viewerUrl,
    room,
    role,
    { assigned_tier: expectedTier },
    config,
    tag
  );
  const { page } = viewer;
  try {

    const decodeResult = await waitForDecodedVideo(page, config.timeoutMs, `${tag}-decode`);
    assertOk(decodeResult.ok, `${tag}: decode failed`, decodeResult.state || decodeResult);

    const dimsResult = await waitForExpectedDimensions(
      page,
      expectedTier,
      Math.max(4000, Math.floor(config.timeoutMs / 4)),
      decodeResult.state
    );
    assertOk(
      dimsResult.ok,
      `${tag}: expected ${expectedTier.toUpperCase()} dimensions`,
      dimsResult.decoded || dimsResult.state
    );

    const decoded = dimsResult.decoded || pickDecodedVideo(decodeResult.state);
    assertOk(decoded, `${tag}: missing decoded metadata`, decodeResult.state);
    const dims = { width: Number(decoded.width) || 0, height: Number(decoded.height) || 0 };

    return {
      page,
      peerUuid: viewer.peerUuid,
      info: viewer.info,
      infoState: viewer.infoState,
      dimensions: dims,
      decodeState: dimsResult.state || decodeResult.state
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
  fs.mkdirSync(config.reportDir, { recursive: true });
  const diagnosticsPath = path.join(
    config.reportDir,
    `dual-quality-requirements-${name}-${nowStamp()}-diagnostics.json`
  );
  const publisher = spawnPublisher(config, {
    streamId,
    room,
    label: caseLabel,
    maxViewers: opts.maxViewers || 8,
    remoteToken: opts.remoteToken || '',
    roomModeLqEnabled: opts.roomModeLqEnabled,
    videoCodec: opts.videoCodec || '',
    alphaWorkflow: !!opts.alphaWorkflow,
    diagnosticsOut: diagnosticsPath
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
    publisherOutput: '',
    publisherCommand: publisher.command,
    publisherArgs: publisher.args,
    publisherSha256: sha256File(publisher.command),
    diagnosticsPath,
    publisherDiagnostics: null,
    contractEvidence: null
  };

  let browser = null;
  let context = null;
  const openedPages = [];

  try {
    await wait(config.startupDelayMs);
    browser = await chromium.launch({
      headless: !config.headful,
      args: ['--autoplay-policy=no-user-gesture-required']
    });
    context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      ignoreHTTPSErrors: true
    });
    caseState.browserVersion = browser.version();
    const metadataPage = await context.newPage();
    caseState.userAgent = await metadataPage.evaluate(() => navigator.userAgent);
    await metadataPage.close();

    await scenarioFn({
      config,
      caseState,
      context,
      publisher,
      options: opts,
      diagnosticsPath,
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
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    stopProcess(publisher.proc);
    caseState.finishedAt = Date.now();
    caseState.publisherOutput = publisherOutputText(publisher);
    if (fs.existsSync(diagnosticsPath)) {
      try {
        caseState.publisherDiagnostics = JSON.parse(
          fs.readFileSync(diagnosticsPath, 'utf8').replace(/^\uFEFF/, '')
        );
      } catch {
        // The scenario failure already carries the last diagnostics parse state.
      }
    }
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

async function caseRoomImplicitViewerFallback(input) {
  const { context, viewerUrl, openedPages, publisher } = input;
  const page = await context.newPage();
  openedPages.push(page);
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const peerState = await waitForSessionPeer(page, 12000);
  assertOk(peerState && peerState.ready, 'room-implicit-viewer-fallback: session peer unavailable', peerState);

  const decode = await waitForDecodedVideo(page, 20000, 'room-implicit-viewer-fallback');
  assertOk(decode.ok, 'room-implicit-viewer-fallback: decode failed', decode.state || decode);

  const fallbackLog = await waitForPublisherLog(publisher, /Implicit room init fallback .*viewer\/lq/i, 8000);
  const explicitInitLog = await waitForPublisherLog(
    publisher,
    /Peer init .*roomMode=1 role=.*roleValid=true tier=/i,
    2000
  );
  assertOk(
    fallbackLog.ok || explicitInitLog.ok,
    'room-implicit-viewer-fallback: missing fallback or explicit room init log',
    { fallbackLog, explicitInitLog }
  );

  const timeoutLog = await waitForPublisherLog(publisher, /missing init payload/i, 2000);
  assertOk(!timeoutLog.ok, 'room-implicit-viewer-fallback: unexpected init-timeout disconnect', timeoutLog);
}

function roomQualityExpectedInfo(expected) {
  return {
    assigned_tier: expected.assignedTier,
    codec_url: expected.codecName,
    video_codec: expected.codecName,
    room_quality_requested: expected.requested,
    room_quality_effective: expected.effective,
    room_quality_reason: expected.reason
  };
}

async function runRoomQualityContractCase(input, expected) {
  const {
    context,
    viewerUrl,
    openedPages,
    room,
    config,
    publisher,
    diagnosticsPath,
    caseState
  } = input;
  const tag = `room-quality-${expected.caseTag}`;
  const viewer = await openRoleInfoViewer(
    context,
    viewerUrl,
    room,
    'guest',
    room ? { room_init: true, room_init_received: true } : { room_init: false },
    config,
    tag,
    4
  );
  openedPages.push(viewer.page);

  if (expected.alphaActive) {
    const alphaCapability = await sendWithRetry(
      viewer.page,
      { info: { alpha_receive: 'vp9-dualtrack-v1' } },
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(alphaCapability && alphaCapability.ok, `${tag}: alpha capability request failed`, alphaCapability);
  }

  let observedInfo = viewer.info;
  if (Number.isFinite(expected.unsupportedVideoBitrateKbps)) {
    const beforeCount = await getInfoRecordCount(viewer.page);
    const bitrateRequest = await sendWithRetry(
      viewer.page,
      { bitrate: expected.unsupportedVideoBitrateKbps },
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(bitrateRequest && bitrateRequest.ok, `${tag}: bitrate request failed`, bitrateRequest);
    const rejection = await waitForRejectedControlAfter(
      viewer.page,
      'bitrate',
      beforeCount,
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(rejection.ok, `${tag}: unsupported bitrate was not rejected`, rejection.state || rejection);
    const afterRejectionCount = await getInfoRecordCount(viewer.page);
    const resumeVideo = await sendWithRetry(
      viewer.page,
      { bitrate: false },
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(resumeVideo && resumeVideo.ok, `${tag}: video-on request failed`, resumeVideo);
    const postRequest = await waitForInfoStateAfter(
      viewer.page,
      { requested_video_bitrate_kbps: -1 },
      afterRejectionCount,
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    assertOk(postRequest.ok, `${tag}: no post-video-on info response`, postRequest.state || postRequest);
    observedInfo = postRequest.state.match;
  } else {
    const fullInfo = await waitForInfoState(
      viewer.page,
      roomQualityExpectedInfo(expected),
      Math.max(8000, Math.floor(config.timeoutMs / 2))
    );
    if (fullInfo.ok) {
      observedInfo = fullInfo.state.match;
    }
  }

  let dimensions = null;
  if (expected.dimensionsTier) {
    const decode = await waitForDecodedVideo(
      viewer.page,
      Math.max(12000, Math.floor(config.timeoutMs / 2)),
      `${tag}-decode`
    );
    dimensions = decode.ok
      ? await waitForExpectedDimensions(
          viewer.page,
          expected.dimensionsTier,
          Math.max(6000, Math.floor(config.timeoutMs / 3)),
          decode.state
        )
      : decode;
  }

  const expectedDiagnostics = {
    requested: expected.requested,
    effective: expected.effective,
    reason: expected.reason
  };
  const diagnosticsResult = await waitForPublisherDiagnostics(
    diagnosticsPath,
    expectedDiagnostics,
    Math.max(7000, Math.floor(config.timeoutMs / 4))
  );
  caseState.publisherDiagnostics = diagnosticsResult.diagnostics || null;

  if (expected.warningCount > 0 && expected.warningText) {
    await waitForPublisherLog(
      publisher,
      expected.warningText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      Math.max(5000, Math.floor(config.timeoutMs / 4))
    );
  }
  await wait(750);

  const infoRecords = await getInfoRecords(viewer.page);
  const evidence = {
    info: observedInfo || {},
    infoRecords,
    diagnostics: diagnosticsResult.diagnostics || null,
    dimensions,
    publisherOutput: publisherOutputText(publisher)
  };
  caseState.contractEvidence = {
    expected,
    observedInfo: evidence.info,
    infoRecordCount: infoRecords.length,
    roomQualityDiagnostics: evidence.diagnostics && evidence.diagnostics.room_quality,
    dimensions: dimensions && {
      ok: !!dimensions.ok,
      decoded: dimensions.decoded || null
    },
    unavailableWarningCount: countRoomQualityUnavailableWarnings(evidence.publisherOutput),
    exactWarningCount: expected.warningText
      ? countLiteralOccurrences(evidence.publisherOutput, expected.warningText)
      : 0,
    lqLeakObservations: collectRoomQualityLqLeakObservations(evidence)
  };
  assertRoomQualityContractEvidence(evidence, expected, tag);
}

async function caseRoomQualityNotInRoom(input) {
  return runRoomQualityContractCase(input, {
    caseTag: 'not-in-room-h264',
    assignedTier: 'hq',
    codecName: 'H.264',
    requested: true,
    effective: false,
    reason: ROOM_QUALITY_REASON.NOT_IN_ROOM,
    warningCount: 0,
    warningText: '',
    noLq: true,
    dimensionsTier: 'hq'
  });
}

async function caseRoomQualityH264EnabledLq(input) {
  return runRoomQualityContractCase(input, {
    caseTag: 'h264-enabled',
    assignedTier: 'lq',
    codecName: 'H.264',
    requested: true,
    effective: true,
    reason: ROOM_QUALITY_REASON.ENABLED,
    unsupportedVideoBitrateKbps: 500,
    warningCount: 0,
    warningText: '',
    noLq: false,
    dimensionsTier: 'lq'
  });
}

async function caseRoomQualityDisabledStaysHq(input) {
  return runRoomQualityContractCase(input, {
    caseTag: 'h264-not-requested',
    assignedTier: 'hq',
    codecName: 'H.264',
    requested: false,
    effective: false,
    reason: ROOM_QUALITY_REASON.NOT_REQUESTED,
    unsupportedVideoBitrateKbps: 500,
    warningCount: 0,
    warningText: '',
    noLq: true,
    dimensionsTier: 'hq'
  });
}

function nonH264RoomQualityCase(codecName, caseTag, alphaActive = false) {
  return async (input) => runRoomQualityContractCase(input, {
    caseTag,
    assignedTier: 'hq',
    codecName,
    requested: true,
    effective: false,
    reason: ROOM_QUALITY_REASON.CODEC_NOT_H264,
    unsupportedVideoBitrateKbps: 500,
    warningCount: 1,
    warningText: roomQualityUnavailableWarning(codecName),
    noLq: true,
    alphaActive
  });
}

const caseRoomQualityPreservesVp9Selection = nonH264RoomQualityCase(
  'VP9',
  'vp9-selected'
);
async function caseRoomQualityPreservesH265Selection(input) {
  const expected = {
    caseTag: 'h265-negotiated-fallback-h264',
    assignedTier: 'lq',
    codecName: 'H.264',
    requested: true,
    effective: true,
    reason: ROOM_QUALITY_REASON.ENABLED,
    unsupportedVideoBitrateKbps: 500,
    warningCount: 1,
    warningText: roomQualityUnavailableWarning('H.265'),
    noLq: false,
    alphaActive: false,
    dimensionsTier: 'lq',
    selectionOutcome: 'receiver-rejected-h265-fallback-h264'
  };
  await runRoomQualityContractCase(input, expected);
  if (input.caseState.contractEvidence) {
    input.caseState.contractEvidence.selectionOutcome = expected.selectionOutcome;
  }
}
const caseRoomQualityPreservesAv1Selection = nonH264RoomQualityCase(
  'AV1',
  'av1-selected'
);
const caseRoomQualityPreservesVp9Alpha = nonH264RoomQualityCase(
  'VP9',
  'vp9-alpha-selected',
  true
);

async function caseSpecialCharPassword(input) {
  const { context, openedPages, publisher, viewerUrl } = input;

  // Step 1: Verify publisher-generated VIEW URL has proper encoding
  const extracted = await extractPublisherViewUrl(publisher, 15000);
  assertOk(extracted.ok, 'special-char-password: publisher did not emit VIEW URL', extracted);

  const publisherUrl = extracted.url;
  assertOk(
    !publisherUrl.includes('&password=Test$') && !publisherUrl.includes('#'),
    'special-char-password: VIEW URL contains unencoded special characters',
    { url: publisherUrl }
  );

  // Step 2: Connect using harness-built URL (URLSearchParams-encoded) to test
  // that the room with special-char password actually works end-to-end
  let lastPeerState = null;
  let lastDecode = null;
  let finalPage = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peerState = await waitForSessionPeer(page, 12000);
    lastPeerState = peerState;
    if (!(peerState && peerState.ready)) {
      await page.close().catch(() => {});
      continue;
    }

    const decode = await waitForDecodedVideo(page, 20000, `special-char-password-attempt-${attempt}`);
    lastDecode = decode;
    if (decode.ok) {
      finalPage = page;
      break;
    }

    if (attempt < 3) {
      console.warn(`[DUAL-REQ] special-char-password attempt ${attempt}/3 failed; retrying`);
    }
    await page.close().catch(() => {});
    await wait(1500);
  }

  assertOk(lastPeerState && lastPeerState.ready, 'special-char-password: session peer unavailable', lastPeerState);
  assertOk(
    finalPage && lastDecode && lastDecode.ok,
    'special-char-password: decode failed',
    lastDecode ? (lastDecode.state || lastDecode) : lastPeerState
  );
  openedPages.push(finalPage);
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

  const mutedInfo = await waitForInfoState(guest.page, { audio: false }, 8000);
  assertOk(mutedInfo.ok, 'reconnect-control-media: missing audio=false info update', mutedInfo.state || mutedInfo);

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

  const unmutedInfo = await waitForInfoState(guest.page, { audio: true }, 8000);
  assertOk(unmutedInfo.ok, 'reconnect-control-media: missing audio=true info update', unmutedInfo.state || unmutedInfo);

  const controlProbe = await installControlInfoProbe(scene.page, scene.peerUuid);
  assertOk(controlProbe.ok, 'reconnect-control-media: failed to install control info probe', controlProbe);

  const controlSend = await sendWithRetry(scene.page, {
    keyframe: true,
    requestStats: true,
    targetBitrate: 3500,
    requestResolution: { w: 960, h: 540, f: 30 },
    remote: config.remoteToken
  }, 8000);
  assertOk(controlSend.ok, 'reconnect-control-media: failed to send control payload', controlSend);

  const controlInfo = await waitForControlInfo(scene.page, 10000);
  assertOk(controlInfo.ok, 'reconnect-control-media: missing control info update', controlInfo.state || controlInfo);

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

  const guestDims = await waitForExpectedDimensions(
    guest.page,
    'lq',
    Math.max(4000, Math.floor(config.timeoutMs / 4)),
    guestPostResult.state
  );
  assertOk(
    guestDims.ok,
    'reconnect-control-media: guest dimensions changed from LQ after control',
    guestDims.decoded || guestDims.state
  );

  const guestDecoded = guestDims.decoded || pickDecodedVideo(guestPostResult.state);
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
    lines.push(`- Publisher: ${entry.publisherCommand || '(unavailable)'}`);
    lines.push(`- Publisher SHA-256: ${entry.publisherSha256 || '(unavailable)'}`);
    lines.push(`- Publisher args: ${JSON.stringify(entry.publisherArgs || [])}`);
    lines.push(`- Publisher diagnostics: ${entry.diagnosticsPath || '(unavailable)'}`);
    lines.push(
      `- Room Quality diagnostics: ${JSON.stringify(
        entry.publisherDiagnostics && entry.publisherDiagnostics.room_quality || null
      )}`
    );
    lines.push(`- Contract evidence: ${JSON.stringify(entry.contractEvidence || null)}`);
    lines.push(`- Browser version: ${entry.browserVersion || '(unavailable)'}`);
    lines.push(`- Browser UA: ${entry.userAgent || '(unavailable)'}`);
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

  async function maybeExecuteCase(name, caseConfig, execConfig, fn) {
    if (config.caseFilter && !config.caseFilter.has(name)) {
      return null;
    }
    let result;
    try {
      result = await executeCase(name, caseConfig, execConfig, fn);
    } catch (err) {
      const failedAt = Date.now();
      result = {
        name,
        startedAt: failedAt,
        finishedAt: failedAt,
        streamId: '(setup failed)',
        room: execConfig.roomMode ? '(setup failed)' : '',
        viewerUrl: '(unavailable)',
        pass: false,
        failure: {
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? String(err.stack) : ''
        },
        screenshots: [],
        publisherOutput: ''
      };
    }
    cases.push(result);
    return result;
  }

  let entry = await maybeExecuteCase(
    'direct_hq_only',
    config,
    { roomMode: false, maxViewers: 4, remoteToken: '', idSuffix: 'dirhq' },
    caseDirectHqOnly
  );
  if (entry) {
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

  await maybeExecuteCase(
    'room_implicit_viewer_fallback',
    config,
    { roomMode: true, maxViewers: 4, remoteToken: '', idSuffix: 'inittime' },
    caseRoomImplicitViewerFallback
  );

  await maybeExecuteCase(
    'room_quality_not_in_room',
    config,
    {
      roomMode: false,
      roomModeLqEnabled: true,
      videoCodec: 'h264',
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqdirect'
    },
    caseRoomQualityNotInRoom
  );

  await maybeExecuteCase(
    'room_quality_h264_requested_on_lq',
    config,
    {
      roomMode: true,
      roomModeLqEnabled: true,
      videoCodec: 'h264',
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqh264on'
    },
    caseRoomQualityH264EnabledLq
  );

  await maybeExecuteCase(
    'room_quality_disabled_stays_hq',
    config,
    {
      roomMode: true,
      roomModeLqEnabled: false,
      videoCodec: 'h264',
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqoff'
    },
    caseRoomQualityDisabledStaysHq
  );

  await maybeExecuteCase(
    'room_quality_preserves_vp9_selection',
    config,
    {
      roomMode: true,
      roomModeLqEnabled: true,
      videoCodec: 'vp9',
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqvp9'
    },
    caseRoomQualityPreservesVp9Selection
  );

  await maybeExecuteCase(
    'room_quality_preserves_h265_selection',
    config,
    {
      roomMode: true,
      roomModeLqEnabled: true,
      videoCodec: 'h265',
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqh265'
    },
    caseRoomQualityPreservesH265Selection
  );

  await maybeExecuteCase(
    'room_quality_preserves_av1_selection',
    config,
    {
      roomMode: true,
      roomModeLqEnabled: true,
      videoCodec: 'av1',
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqav1'
    },
    caseRoomQualityPreservesAv1Selection
  );

  await maybeExecuteCase(
    'room_quality_preserves_vp9_alpha',
    config,
    {
      roomMode: true,
      roomModeLqEnabled: true,
      videoCodec: 'vp9',
      alphaWorkflow: true,
      maxViewers: 4,
      remoteToken: '',
      idSuffix: 'roomqvp9alpha'
    },
    caseRoomQualityPreservesVp9Alpha
  );

  const specPwConfig = { ...config, password: 'Test$&Room#1!' };
  await maybeExecuteCase(
    'special_char_password',
    specPwConfig,
    { roomMode: true, maxViewers: 4, remoteToken: '', idSuffix: 'specpw' },
    caseSpecialCharPassword
  );

  await maybeExecuteCase(
    'room_max_viewers',
    config,
    { roomMode: true, maxViewers: 2, remoteToken: '', idSuffix: 'maxv' },
    caseMaxViewers
  );

  await maybeExecuteCase(
    'reconnect_control_media',
    config,
    {
      roomMode: true,
      maxViewers: 6,
      remoteToken: config.remoteToken || DEFAULT_REMOTE_TOKEN,
      idSuffix: 'ctrlrec'
    },
    caseReconnectControlMedia
  );

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

module.exports = {
  ROOM_QUALITY_REASON,
  ROOM_QUALITY_WARNING_SUFFIX,
  H265_STARTUP_FALLBACK_WARNING,
  collectRoomQualityLqLeakObservations,
  countLiteralOccurrences,
  countRoomQualityUnavailableWarnings,
  evaluateRoomQualityContractEvidence,
  extractPackagedRedReportEvidence,
  resolveH265RoomQualityExpectation,
  roomQualityUnavailableWarning
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[DUAL-REQ] Unhandled error:', err);
    process.exit(1);
  });
}
