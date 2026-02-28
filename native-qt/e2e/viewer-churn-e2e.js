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
    streamId: `viewer_churn_${Date.now()}`,
    room: '',
    password: '',
    label: 'viewer-churn-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 45000,
    holdMs: 3000,
    joinGapMs: 250,
    leaveGapMs: 250,
    viewers: 4,
    cycles: 6,
    headful: false,
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../qa/reports'),
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    initRole: '',
    initVideo: true,
    initAudio: true
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
    } else if (arg.startsWith('--join-gap-ms=')) {
      args.joinGapMs = Math.max(0, Number(arg.slice('--join-gap-ms='.length)) || args.joinGapMs);
    } else if (arg.startsWith('--leave-gap-ms=')) {
      args.leaveGapMs = Math.max(0, Number(arg.slice('--leave-gap-ms='.length)) || args.leaveGapMs);
    } else if (arg.startsWith('--viewers=')) {
      args.viewers = Math.max(1, Number(arg.slice('--viewers='.length)) || args.viewers);
    } else if (arg.startsWith('--cycles=')) {
      args.cycles = Math.max(1, Number(arg.slice('--cycles='.length)) || args.cycles);
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
    } else if (arg.startsWith('--report-dir=')) {
      args.reportDir = path.resolve(arg.slice('--report-dir='.length));
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
    const resolved = path.resolve(explicitPath);
    return fs.existsSync(resolved) ? resolved : '';
  }

  const candidates = [
    path.resolve(__dirname, '../build-review2/bin/Release/versus-qt.exe'),
    path.resolve(__dirname, '../build-test/bin/Release/versus-qt.exe'),
    path.resolve(__dirname, '../build/bin/Release/versus-qt.exe')
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
    throw new Error('Could not find versus-qt.exe. Build native-qt first or pass --publisher-path.');
  }

  const cycleBudgetMs = (config.timeoutMs + config.holdMs + 2000) * config.cycles;
  const durationMs = Math.max(240000, config.startupDelayMs + cycleBudgetMs + 90000);
  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--password=${config.password}`,
    `--room=${config.room}`,
    `--label=${config.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    `--max-viewers=${Math.max(config.viewers + 2, 8)}`
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

    return {
      ok: sent,
      uuid
    };
  }, payload);
}

async function sendViewerInitIfConfigured(page, config) {
  if (!config.initRole) {
    return { ok: true, skipped: true };
  }

  const initDeadlineMs = Math.max(8000, Math.floor(config.timeoutMs / 2));
  const peerState = await waitForSessionPeer(page, initDeadlineMs);
  if (!peerState || !peerState.ready) {
    return { ok: false, stage: 'session-peer', state: peerState };
  }

  const initPayload = {
    init: {
      role: config.initRole,
      room: !!config.room,
      video: config.initVideo,
      audio: config.initAudio,
      label: config.label,
      system: {
        app: 'versus-e2e-viewer-churn',
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

async function openAndVerifyViewer(context, viewerUrl, timeoutMs, stageLabel, config) {
  const page = await context.newPage();
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const initResult = await sendViewerInitIfConfigured(page, config);
  if (!initResult.ok) {
    await page.close().catch(() => {});
    return { ok: false, page: null, state: initResult.state || initResult, stage: initResult.stage || stageLabel };
  }
  const result = await waitForDecodedVideo(page, timeoutMs, stageLabel);
  if (!result.ok) {
    await page.close().catch(() => {});
    return { ok: false, page: null, state: result.state, stage: result.stage };
  }
  return { ok: true, page, state: result.state, stage: stageLabel };
}

async function closeAllPages(pages, leaveGapMs) {
  for (const page of pages) {
    await page.close().catch(() => {});
    if (leaveGapMs > 0) {
      await wait(leaveGapMs);
    }
  }
}

function writeReport(config, startedAt, finishedAt, cycleRows, failure, publisherOutput, screenshotPaths) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `viewer-churn-${nowStamp()}.md`);
  const allPassed = !failure && cycleRows.every((row) => row.result === 'PASS');
  const lines = [
    '# Viewer Churn E2E Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${allPassed ? 'PASS' : 'FAIL'}`,
    `- Duration (s): ${Math.round((finishedAt - startedAt) / 1000)}`,
    `- Stream: ${config.streamId}`,
    `- Room: ${config.room || '(none)'}`,
    `- Password: ${config.password}`,
    `- Viewers per cycle: ${config.viewers}`,
    `- Cycles: ${config.cycles}`,
    `- Hold per cycle (ms): ${config.holdMs}`,
    `- Join gap (ms): ${config.joinGapMs}`,
    `- Leave gap (ms): ${config.leaveGapMs}`,
    `- Init role: ${config.initRole || '(none)'}`,
    `- Init media flags: video=${config.initVideo} audio=${config.initAudio}`,
    `- Video encoder: ${config.videoEncoder || '(default)'}`,
    `- FFmpeg path override: ${config.ffmpegPath || '(auto)'}`,
    '',
    '| Cycle | Result | Stage |',
    '|---:|:---:|---|'
  ];

  for (const row of cycleRows) {
    lines.push(`| ${row.cycle} | ${row.result} | ${row.stage} |`);
  }

  if (failure) {
    lines.push('', '## Failure', '');
    lines.push(`- Stage: ${failure.stage}`);
    lines.push(`- State: ${JSON.stringify(failure.state || {})}`);
  }

  if (screenshotPaths.length > 0) {
    lines.push('', '## Screenshots', '');
    for (const shot of screenshotPaths) {
      lines.push(`- ${shot}`);
    }
  }

  lines.push('', '## Publisher Output (tail)', '', '```text');
  lines.push(...publisherOutput.trim().split(/\r?\n/).slice(-200));
  lines.push('```', '');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

async function captureScreenshots(pages, screenshotDir, streamId, isFailure) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const paths = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const shotPath = path.join(
      screenshotDir,
      `viewer-churn-${isFailure ? 'fail' : 'pass'}-${streamId}-v${i + 1}-${nowStamp()}.png`
    );
    // Keep only first 4 screenshots to control artifact volume.
    if (i >= 4) {
      break;
    }
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    paths.push(shotPath);
  }
  return paths;
}

async function main() {
  const config = parseArgs(process.argv);
  const viewerUrl = buildViewerUrl(config);
  const publisher = spawnPublisher(config);
  const startedAt = Date.now();
  let browser = null;
  let context = null;
  let pages = [];
  let failure = null;
  const cycleRows = [];
  let screenshotPaths = [];

  console.log(`[VIEWER-CHURN] Stream ID: ${config.streamId}`);
  console.log(`[VIEWER-CHURN] Viewers per cycle: ${config.viewers}`);
  console.log(`[VIEWER-CHURN] Cycles: ${config.cycles}`);
  if (config.initRole) {
    console.log(`[VIEWER-CHURN] Data init role: ${config.initRole} (video=${config.initVideo}, audio=${config.initAudio})`);
  }
  console.log(`[VIEWER-CHURN] URL: ${viewerUrl}`);
  console.log(`[VIEWER-CHURN] Spawned publisher: ${publisher.command} ${publisher.args.join(' ')}`);
  await wait(config.startupDelayMs);

  try {
    browser = await chromium.launch({
      headless: !config.headful,
      args: ['--autoplay-policy=no-user-gesture-required']
    });
    context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      ignoreHTTPSErrors: true
    });

    for (let cycle = 1; cycle <= config.cycles; cycle++) {
      await closeAllPages(pages, config.leaveGapMs);
      pages = [];
      if (config.leaveGapMs > 0) {
        await wait(config.leaveGapMs);
      }

      let cycleStage = `cycle-${cycle}`;
      for (let v = 1; v <= config.viewers; v++) {
        cycleStage = `cycle-${cycle}-viewer-${v}`;
        console.log(`[VIEWER-CHURN] ${cycleStage}: join`);
        const opened = await openAndVerifyViewer(context, viewerUrl, config.timeoutMs, cycleStage, config);
        if (!opened.ok) {
          failure = opened;
          break;
        }
        pages.push(opened.page);
        console.log(`[VIEWER-CHURN] ${cycleStage}: decode PASS`);
        if (config.joinGapMs > 0 && v < config.viewers) {
          await wait(config.joinGapMs);
        }
      }

      if (failure) {
        cycleRows.push({ cycle, result: 'FAIL', stage: failure.stage || cycleStage });
        break;
      }

      if (config.holdMs > 0) {
        await wait(config.holdMs);
      }
      cycleRows.push({ cycle, result: 'PASS', stage: `cycle-${cycle}-stable` });
    }

    if (!failure) {
      screenshotPaths = await captureScreenshots(pages, config.screenshotDir, config.streamId, false);
    } else {
      screenshotPaths = await captureScreenshots(pages, config.screenshotDir, config.streamId, true);
    }
  } finally {
    await closeAllPages(pages, 0);
    if (browser) {
      await browser.close().catch(() => {});
    }
    stopProcess(publisher.proc);
  }

  const finishedAt = Date.now();
  const publisherOutput = `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
  const reportPath = writeReport(
    config,
    startedAt,
    finishedAt,
    cycleRows,
    failure,
    publisherOutput,
    screenshotPaths
  );
  console.log(`[VIEWER-CHURN] Report: ${reportPath}`);

  if (failure) {
    console.error('[VIEWER-CHURN] FAIL');
    console.error(`[VIEWER-CHURN] Stage: ${failure.stage}`);
    console.error(`[VIEWER-CHURN] State: ${JSON.stringify(failure.state || {})}`);
    process.exit(1);
  }

  console.log('[VIEWER-CHURN] PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('[VIEWER-CHURN] Unhandled error:', err);
  process.exit(1);
});
