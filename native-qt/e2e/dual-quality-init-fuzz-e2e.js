#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ALLOWED_TIERS = new Set(['hq', 'lq', 'none', '']);

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
    streamId: `dual_init_fuzz_${seed}`,
    room: `dual_init_room_${seed}`,
    password: '',
    label: 'dual-quality-init-fuzz',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 60000,
    holdMs: 2500,
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
  args.streamId = sanitizeId(args.streamId, 64, `dual_init_fuzz_${fallbackSeed}`);
  args.room = sanitizeId(args.room, 30, `dual_init_room_${fallbackSeed}`);
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

  const durationMs = Math.max(300000, config.startupDelayMs + config.timeoutMs + config.holdMs + 120000);
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

function stopProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }
  proc.kill();
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
    // eslint-disable-next-line no-await-in-loop
    lastState = await collectState(page);
    if (lastState.hasDecodedVideo) {
      return { ok: true, state: lastState };
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(800);
  }
  return { ok: false, stage: stageLabel, state: lastState };
}

async function waitForSessionPeer(page, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
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
    // eslint-disable-next-line no-await-in-loop
    await wait(400);
  }
  return last || { ready: false, reason: 'timeout' };
}

async function waitForDataChannelOpen(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const state = await page.evaluate(() => {
      const sessionObj = window.session || null;
      if (!sessionObj) {
        return { ok: false, reason: 'no_session' };
      }
      const rpcIds = Object.keys(sessionObj.rpcs || {});
      if (!rpcIds.length) {
        return { ok: false, reason: 'no_rpcs' };
      }
      const uuid = rpcIds[0];
      const rpc = sessionObj.rpcs[uuid];
      const channel = rpc && (rpc.receiveChannel || rpc.sendChannel);
      if (!channel) {
        return { ok: false, reason: 'no_channel', uuid };
      }
      return {
        ok: channel.readyState === 'open',
        reason: channel.readyState || 'unknown',
        uuid
      };
    });
    if (state.ok) {
      return state;
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(250);
  }
  return { ok: false, reason: 'timeout' };
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

async function sendRawMessage(page, rawMessage) {
  return page.evaluate((raw) => {
    const sessionObj = window.session || null;
    if (!sessionObj) {
      return { ok: false, reason: 'no_session' };
    }
    const rpcIds = Object.keys(sessionObj.rpcs || {});
    if (!rpcIds.length) {
      return { ok: false, reason: 'no_rpcs' };
    }
    const uuid = rpcIds[0];
    const rpc = sessionObj.rpcs[uuid];
    const channel = rpc && (rpc.receiveChannel || rpc.sendChannel);
    if (!channel || channel.readyState !== 'open') {
      return { ok: false, reason: channel ? channel.readyState : 'no_channel', uuid };
    }
    channel.send(raw);
    return { ok: true, uuid };
  }, rawMessage);
}

async function sendWithRetry(page, type, payload, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    last = type === 'raw' ? await sendRawMessage(page, payload) : await sendDataMessage(page, payload);
    if (last && last.ok) {
      return last;
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(250);
  }
  return last || { ok: false, reason: 'timeout' };
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
          if (probe.records.length > 500) {
            probe.records.shift();
          }
        }
      } catch {
        // Ignore malformed data.
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

async function collectProbeSummary(page) {
  return page.evaluate(() => {
    const probe = window.__gameCaptureInfoProbe || { records: [] };
    const records = Array.isArray(probe.records) ? probe.records : [];
    const infoRecords = records
      .filter((entry) => entry && entry.message && entry.message.info)
      .map((entry) => ({
        ts: entry.ts,
        assignedTier: String(entry.message.info.assigned_tier || '').toLowerCase(),
        assignedRole: String(entry.message.info.assigned_role || '').toLowerCase(),
        roomInitReceived: Boolean(entry.message.info.room_init_received),
        peerVideoEnabled: Boolean(entry.message.info.peer_video_enabled),
        peerAudioEnabled: Boolean(entry.message.info.peer_audio_enabled)
      }));
    const ackCount = records.filter((entry) => entry && entry.message && entry.message.ack === 'init').length;
    return {
      totalRecords: records.length,
      ackCount,
      infoRecords
    };
  });
}

async function captureScreenshot(page, screenshotDir, streamId, prefix) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const shotPath = path.join(screenshotDir, `dual-quality-init-fuzz-${prefix}-${streamId}-${nowStamp()}.png`);
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
  return shotPath;
}

function writeReport(config, startedAt, finishedAt, rows, summary, failure, publisherOutput, screenshotPath) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `dual-quality-init-fuzz-${nowStamp()}.md`);
  const lines = [
    '# Dual Quality Init Fuzz E2E Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${failure ? 'FAIL' : 'PASS'}`,
    `- Duration (s): ${Math.round((finishedAt - startedAt) / 1000)}`,
    `- Stream: ${config.streamId}`,
    `- Room: ${config.room}`,
    `- Password: ${config.password}`,
    '',
    '| Case | Payload type | Sent | Publisher alive |',
    '|---|---|:---:|:---:|'
  ];

  for (const row of rows) {
    lines.push(`| ${row.name} | ${row.type} | ${row.sent ? 'yes' : 'no'} | ${row.publisherAlive ? 'yes' : 'no'} |`);
  }

  lines.push(
    '',
    '## Probe Summary',
    '',
    `- Total probe records: ${summary ? summary.totalRecords : 0}`,
    `- Init ack records: ${summary ? summary.ackCount : 0}`,
    `- Info records: ${summary ? summary.infoRecords.length : 0}`
  );

  if (summary && summary.infoRecords.length) {
    lines.push('', '| Assigned tier | Assigned role | room_init_received | video | audio |', '|---|---|:---:|:---:|:---:|');
    for (const record of summary.infoRecords.slice(-20)) {
      lines.push(
        `| ${record.assignedTier || '(empty)'} | ${record.assignedRole || '(empty)'} | ${record.roomInitReceived ? 'yes' : 'no'} | ${record.peerVideoEnabled ? 'yes' : 'no'} | ${record.peerAudioEnabled ? 'yes' : 'no'} |`
      );
    }
  }

  if (screenshotPath) {
    lines.push('', '## Screenshot', '', `- ${screenshotPath}`);
  }

  if (failure) {
    lines.push('', '## Failure', '', `- Stage: ${failure.stage}`, `- State: ${JSON.stringify(failure.state || {})}`);
  }

  lines.push('', '## Publisher Output (tail)', '', '```text');
  lines.push(...publisherOutput.trim().split(/\r?\n/).slice(-240));
  lines.push('```', '');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

async function main() {
  const config = parseArgs(process.argv);
  const viewerUrl = buildViewerUrl(config);
  console.log(`[DUAL-INIT-FUZZ] Stream: ${config.streamId}`);
  console.log(`[DUAL-INIT-FUZZ] Room: ${config.room}`);
  if (config.streamIdNormalized || config.roomNormalized) {
    console.log(
      `[DUAL-INIT-FUZZ] Normalized IDs from stream='${config.originalStreamId}' room='${config.originalRoom}'`
    );
  }
  console.log(`[DUAL-INIT-FUZZ] URL: ${viewerUrl}`);

  const publisher = spawnPublisher(config);
  console.log(`[DUAL-INIT-FUZZ] Spawned publisher: ${publisher.command} ${publisher.args.join(' ')}`);
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

  const startedAt = Date.now();
  const rows = [];
  let summary = null;
  let screenshotPath = '';
  let failure = null;

  const makeInit = (role, video, audio, label) => ({
    init: {
      role,
      room: true,
      video,
      audio,
      label,
      system: {
        app: 'game-capture-e2e-dual-init-fuzz',
        version: '1',
        platform: 'playwright',
        browser: 'chromium'
      }
    }
  });

  const cases = [
    { name: 'raw-malformed-json', type: 'raw', payload: '{"init":{"role":"scene"' },
    { name: 'raw-random-text', type: 'raw', payload: 'not-json-init-payload' },
    { name: 'missing-fields', type: 'obj', payload: { init: {} } },
    { name: 'unknown-role', type: 'obj', payload: makeInit('bogus-role', true, true, 'unknown-role') },
    { name: 'inline-unknown-role', type: 'obj', payload: { role: 'bogus-inline', room: true, video: true, audio: true } },
    { name: 'repeat-viewer', type: 'obj', payload: makeInit('viewer', true, true, 'viewer') },
    { name: 'repeat-scene', type: 'obj', payload: makeInit('scene', true, true, 'scene') },
    { name: 'repeat-guest-no-audio', type: 'obj', payload: makeInit('guest', true, false, 'guest-muted') },
    { name: 'repeat-scene-no-video', type: 'obj', payload: makeInit('scene', false, true, 'scene-no-video') },
    { name: 'final-scene', type: 'obj', payload: makeInit('scene', true, true, 'scene-final') }
  ];

  try {
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const peer = await waitForSessionPeer(page, Math.max(10000, Math.floor(config.timeoutMs / 2)));
    if (!peer || !peer.ready) {
      failure = { stage: 'session-peer', state: peer };
      return;
    }

    const channelReady = await waitForDataChannelOpen(page, Math.max(8000, Math.floor(config.timeoutMs / 3)));
    if (!channelReady.ok) {
      failure = { stage: 'data-channel-open', state: channelReady };
      return;
    }

    const probeInstall = await installInfoProbe(page, peer.uuid);
    if (!probeInstall.ok) {
      failure = { stage: 'install-probe', state: probeInstall };
      return;
    }

    for (const fuzzCase of cases) {
      // eslint-disable-next-line no-await-in-loop
      const sendResult = await sendWithRetry(
        page,
        fuzzCase.type,
        fuzzCase.payload,
        Math.max(5000, Math.floor(config.timeoutMs / 3))
      );
      // eslint-disable-next-line no-await-in-loop
      await wait(300);
      const publisherAlive = publisher.proc.exitCode === null;
      rows.push({
        name: fuzzCase.name,
        type: fuzzCase.type,
        sent: Boolean(sendResult && sendResult.ok),
        publisherAlive
      });
      if (!sendResult || !sendResult.ok) {
        failure = { stage: `send-${fuzzCase.name}`, state: sendResult };
        break;
      }
      if (!publisherAlive) {
        failure = { stage: `publisher-exit-${fuzzCase.name}`, state: { exitCode: publisher.proc.exitCode } };
        break;
      }
    }

    if (failure) {
      return;
    }

    const decode = await waitForDecodedVideo(page, Math.max(8000, Math.floor(config.timeoutMs / 2)), 'final-scene-decode');
    if (!decode.ok) {
      failure = { stage: decode.stage || 'decode', state: decode.state };
      return;
    }

    await wait(config.holdMs);
    summary = await collectProbeSummary(page);
    const infoRecords = summary && Array.isArray(summary.infoRecords) ? summary.infoRecords : [];
    if (!infoRecords.length) {
      failure = { stage: 'probe-info-empty', state: summary };
      return;
    }

    const invalidTierRecord = infoRecords.find((record) => !ALLOWED_TIERS.has(String(record.assignedTier || '').toLowerCase()));
    if (invalidTierRecord) {
      failure = { stage: 'invalid-tier-state', state: invalidTierRecord };
      return;
    }

    const sawHq = infoRecords.some((record) => String(record.assignedTier || '').toLowerCase() === 'hq');
    if (!sawHq) {
      failure = { stage: 'missing-hq-tier', state: summary };
      return;
    }

    screenshotPath = await captureScreenshot(page, config.screenshotDir, config.streamId, 'pass');
    console.log('[DUAL-INIT-FUZZ] PASS');
  } finally {
    if (failure) {
      screenshotPath = await captureScreenshot(page, config.screenshotDir, config.streamId, 'fail');
      console.error(`[DUAL-INIT-FUZZ] FAIL at stage ${failure.stage}`);
      console.error(`[DUAL-INIT-FUZZ] State: ${JSON.stringify(failure.state || {})}`);
    }

    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    stopProcess(publisher.proc);

    const finishedAt = Date.now();
    const publisherOutput = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
    const reportPath = writeReport(
      config,
      startedAt,
      finishedAt,
      rows,
      summary,
      failure,
      publisherOutput,
      screenshotPath
    );
    console.log(`[DUAL-INIT-FUZZ] Report: ${reportPath}`);
    process.exitCode = failure ? 1 : 0;
  }
}

main().catch((err) => {
  console.error('[DUAL-INIT-FUZZ] Unhandled error:', err);
  process.exit(1);
});

