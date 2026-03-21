#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

const CASES = {
  'host-only': { name: 'host_only', iceMode: 'host-only', remoteCandidateType: 'host' },
  'stun-only': { name: 'stun_only', iceMode: 'stun-only', remoteCandidateType: 'srflx' },
  relay: { name: 'relay', iceMode: 'relay', remoteCandidateType: 'relay' }
};

function remoteCandidateMatches(caseDef, observedType) {
  if (!observedType) {
    return false;
  }
  if (caseDef.iceMode === 'host-only') {
    return observedType === 'host' || observedType === 'prflx';
  }
  if (caseDef.iceMode === 'relay') {
    return observedType === 'relay' || observedType === 'prflx';
  }
  return observedType === caseDef.remoteCandidateType;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeId(value, maxLen, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replace(/[^A-Za-z0-9_ -]/g, '_').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

function parseArgs(argv) {
  const seed = Date.now();
  const args = {
    streamBase: `ice_connect_${seed}`,
    password: '',
    label: 'ice-connectivity',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    startupDelayMs: 7000,
    timeoutMs: 90000,
    holdMs: 4000,
    sourceWarmupMs: 2000,
    publisherPath: '',
    videoEncoder: '',
    ffmpegPath: '',
    ffmpegOptions: '',
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../qa/reports'),
    headful: false,
    caseKeys: ['host-only', 'stun-only', 'relay']
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--stream-base=')) {
      args.streamBase = arg.slice('--stream-base='.length);
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
      args.timeoutMs = Math.max(10000, Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs);
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Math.max(1000, Number(arg.slice('--hold-ms='.length)) || args.holdMs);
    } else if (arg.startsWith('--source-warmup-ms=')) {
      args.sourceWarmupMs = Math.max(500, Number(arg.slice('--source-warmup-ms='.length)) || args.sourceWarmupMs);
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
    } else if (arg.startsWith('--cases=')) {
      const requested = arg.slice('--cases='.length)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .map((value) => {
          if (value === 'host' || value === 'host_only') {
            return 'host-only';
          }
          if (value === 'stun' || value === 'stun_only') {
            return 'stun-only';
          }
          if (value === 'turn') {
            return 'relay';
          }
          return value;
        })
        .filter((value) => Object.prototype.hasOwnProperty.call(CASES, value));
      if (requested.length) {
        args.caseKeys = requested;
      }
    } else if (arg === '--headful') {
      args.headful = true;
    }
  }

  args.streamBase = sanitizeId(args.streamBase, 48, `ice_connect_${seed}`).replace(/ /g, '_');
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
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertOk(condition, message, state) {
  if (!condition) {
    const detail = state ? ` ${JSON.stringify(state)}` : '';
    throw new Error(`${message}${detail}`);
  }
}

function buildViewerUrl(streamId, password) {
  const query = new URLSearchParams();
  query.set('view', streamId);
  query.set('autostart', '');
  if (password) {
    query.set('password', password);
  }
  return `https://vdo.ninja/?${query.toString()}`;
}

function stopProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }
  proc.kill();
}

function publisherOutputText(publisher) {
  return `${publisher.stdout.join('')}\n${publisher.stderr.join('')}`;
}

function extractOfferSdps(output) {
  const offers = [];
  const regex = /\[WebRTC\] === SDP OFFER START ===([\s\S]*?)\[WebRTC\] === SDP OFFER END ===/gm;
  let match = null;
  while ((match = regex.exec(output)) !== null) {
    if (match[1]) {
      offers.push(match[1]);
    }
  }
  return offers;
}

function candidateLinesFromOffer(offerSdp) {
  return String(offerSdp || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('a=candidate:'));
}

function offerHasSection(offerSdp, mediaKind) {
  return new RegExp(`^m=${mediaKind}\\s`, 'm').test(String(offerSdp || ''));
}

function assertBootstrapOfferSequence(output, caseDef) {
  const offers = extractOfferSdps(output);
  assertOk(offers.length >= 2, `${caseDef.name}: expected bootstrap offer plus media renegotiation`, { offerCount: offers.length });

  const bootstrapOffer = offers[0];
  assertOk(/^m=application\s/m.test(bootstrapOffer), `${caseDef.name}: bootstrap offer missing datachannel m-line`);
  assertOk(!offerHasSection(bootstrapOffer, 'video'), `${caseDef.name}: bootstrap offer unexpectedly advertised video`);
  assertOk(!offerHasSection(bootstrapOffer, 'audio'), `${caseDef.name}: bootstrap offer unexpectedly advertised audio`);

  const mediaOffer = offers.find((offerSdp) => offerHasSection(offerSdp, 'video') && offerHasSection(offerSdp, 'audio'));
  assertOk(mediaOffer, `${caseDef.name}: never produced a renegotiated offer with audio and video`);

  return { offerCount: offers.length };
}

function assertOfferCandidateMode(output, caseDef) {
  const offers = extractOfferSdps(output);
  assertOk(offers.length > 0, `${caseDef.name}: missing SDP offer in publisher output`);

  let finalCandidateLines = [];
  for (const offerSdp of offers) {
    const candidateLines = candidateLinesFromOffer(offerSdp);
    assertOk(candidateLines.length > 0, `${caseDef.name}: offer contained no ICE candidates`);

    if (caseDef.iceMode === 'host-only') {
      assertOk(candidateLines.every((line) => / typ host/i.test(line)),
        `${caseDef.name}: offer leaked non-host candidates`,
        candidateLines);
    } else if (caseDef.iceMode === 'relay') {
      assertOk(candidateLines.every((line) => / typ relay/i.test(line)),
        `${caseDef.name}: offer leaked non-relay candidates`,
        candidateLines);
    } else if (caseDef.iceMode === 'stun-only') {
      assertOk(candidateLines.every((line) => / typ srflx/i.test(line)),
        `${caseDef.name}: offer leaked non-srflx candidates`,
        candidateLines);
    }

    finalCandidateLines = candidateLines;
  }
  return finalCandidateLines;
}

function assertIceSummaryLine(summaryLine, caseDef) {
  assertOk(summaryLine, `${caseDef.name}: missing ICE summary log`);
  if (caseDef.iceMode === 'host-only') {
    assertOk(!/stun:/i.test(summaryLine) && !/turns?:/i.test(summaryLine),
      `${caseDef.name}: host-only summary unexpectedly listed ICE servers`,
      summaryLine);
    return;
  }

  for (const stunUrl of DEFAULT_STUN_URLS) {
    assertOk(summaryLine.includes(stunUrl), `${caseDef.name}: missing default STUN server in ICE summary`, summaryLine);
  }
}

async function waitForPublisherOfferCount(publisher, minimumCount, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const output = publisherOutputText(publisher);
    const offers = extractOfferSdps(output);
    if (offers.length >= minimumCount) {
      return { ok: true, output, offerCount: offers.length };
    }
    await wait(250);
  }
  const output = publisherOutputText(publisher);
  return {
    ok: false,
    outputTail: output.trim().split(/\r?\n/).slice(-120).join('\n'),
    offerCount: extractOfferSdps(output).length
  };
}

function buildSourceHtml(windowTitle) {
  const title = String(windowTitle).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #07111c; color: #f4efe6; font-family: "Segoe UI", sans-serif; }
    #stage { width: 100vw; height: 100vh; display: block; }
    #hud {
      position: fixed; left: 24px; top: 20px; padding: 12px 16px;
      background: rgba(7, 17, 28, 0.72); border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px; backdrop-filter: blur(10px);
    }
    #hud strong { display: block; font-size: 18px; }
    #hud span { display: block; margin-top: 6px; font-size: 12px; opacity: 0.85; }
  </style>
</head>
<body>
  <canvas id="stage" width="1280" height="720"></canvas>
  <div id="hud"><strong>${title}</strong><span id="clock">warming up</span></div>
  <script>
    (() => {
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d');
      const clock = document.getElementById('clock');
      let frame = 0;
      let audioContext = null;
      let audioStarted = false;
      function resize() {
        canvas.width = Math.max(640, window.innerWidth || 1280);
        canvas.height = Math.max(360, window.innerHeight || 720);
      }
      function draw() {
        frame += 1;
        const width = canvas.width;
        const height = canvas.height;
        const time = frame / 60;
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#10243b');
        gradient.addColorStop(0.5, '#16425b');
        gradient.addColorStop(1, '#ad5c2d');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        for (let i = 0; i < 6; i++) {
          const phase = time + (i * 0.33);
          const x = width * (0.12 + (0.13 * i)) + Math.sin(phase * 1.4) * 80;
          const y = height * 0.5 + Math.cos(phase * 1.1) * 120;
          const radius = 42 + (i * 10) + (Math.sin(phase * 2.2) * 12);
          ctx.beginPath();
          ctx.fillStyle = i % 2 === 0 ? 'rgba(248, 210, 114, 0.26)' : 'rgba(255, 255, 255, 0.16)';
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#f7f2ea';
        ctx.font = '700 64px Segoe UI';
        ctx.fillText('ICE MEDIA SOURCE', 70, 120);
        ctx.font = '500 28px Segoe UI';
        ctx.fillText('Animated canvas + Web Audio tone', 74, 168);
        ctx.font = '500 22px Consolas';
        ctx.fillText('frame=' + frame, 74, height - 70);
        ctx.fillText('audio=' + (audioStarted ? 'running' : 'starting'), 74, height - 40);
        clock.textContent = 'frame ' + frame + ' | ' + new Date().toLocaleTimeString();
        requestAnimationFrame(draw);
      }
      async function startSource() {
        if (audioStarted) {
          return { ok: true, state: audioContext ? audioContext.state : 'running' };
        }
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) {
          return { ok: false, reason: 'no-audio-context' };
        }
        audioContext = new AudioCtor();
        const gain = audioContext.createGain();
        gain.gain.value = 0.06;
        const oscillator = audioContext.createOscillator();
        oscillator.type = 'sawtooth';
        oscillator.frequency.value = 220;
        const lfo = audioContext.createOscillator();
        lfo.frequency.value = 0.8;
        const lfoGain = audioContext.createGain();
        lfoGain.gain.value = 60;
        lfo.connect(lfoGain);
        lfoGain.connect(oscillator.frequency);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        lfo.start();
        await audioContext.resume();
        audioStarted = audioContext.state === 'running';
        return { ok: audioStarted, state: audioContext.state };
      }
      window.startSource = startSource;
      window.getSourceState = () => ({ title: document.title, frame, audioStarted, audioState: audioContext ? audioContext.state : 'none' });
      resize();
      window.addEventListener('resize', resize);
      requestAnimationFrame(draw);
    })();
  </script>
</body>
</html>`;
}

function spawnPublisher(config, caseConfig) {
  const command = detectPublisherBinary(config.publisherPath);
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build native-qt first or pass --publisher-path.');
  }

  const durationMs = Math.max(
    240000,
    config.startupDelayMs + config.timeoutMs + config.holdMs + 120000
  );
  const args = [
    '--headless',
    `--stream=${caseConfig.streamId}`,
    `--password=${config.password}`,
    '--room=',
    `--label=${caseConfig.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    '--max-viewers=2',
    `--ice-mode=${caseConfig.iceMode}`,
    `--window=${caseConfig.windowFilter}`
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

async function waitForPublisherLog(publisher, pattern, timeoutMs) {
  const start = Date.now();
  const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  while (Date.now() - start < timeoutMs) {
    const output = publisherOutputText(publisher);
    if (regex.test(output)) {
      return { ok: true, output };
    }
    await wait(250);
  }
  const output = publisherOutputText(publisher);
  return { ok: false, outputTail: output.trim().split(/\r?\n/).slice(-80).join('\n') };
}

async function createCaptureSource(runLabel, sourceWarmupMs) {
  const windowTitle = sanitizeId(`GC ICE Source ${runLabel}`, 80, `GC_ICE_Source_${Date.now()}`);
  const browser = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1280,720']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();
  await page.setContent(buildSourceHtml(windowTitle), { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForFunction((expectedTitle) => document.title === expectedTitle, windowTitle, { timeout: 10000 });

  const audioResult = await page.evaluate(async () => window.startSource());
  assertOk(audioResult && audioResult.ok, 'capture source audio failed to start', audioResult);

  await wait(sourceWarmupMs);
  const state = await page.evaluate(() => window.getSourceState());
  assertOk(state && state.frame > 0, 'capture source did not animate', state);
  assertOk(state && state.audioStarted, 'capture source audio is not running', state);

  return { browser, context, page, windowTitle, state };
}

async function saveScreenshot(page, dir, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${prefix}-${nowStamp()}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  return target;
}

async function ensureMediaElementsPlaying(page) {
  return page.evaluate(async () => {
    const mediaElements = Array.from(document.querySelectorAll('video, audio'));
    const errors = [];
    for (const element of mediaElements) {
      try {
        if ('muted' in element) {
          element.muted = false;
        }
        if ('volume' in element) {
          element.volume = 1;
        }
        if (typeof element.play === 'function') {
          const result = element.play();
          if (result && typeof result.then === 'function') {
            await result.catch((err) => {
              errors.push(String(err && err.message ? err.message : err));
            });
          }
        }
      } catch (err) {
        errors.push(String(err && err.message ? err.message : err));
      }
    }
    return { mediaCount: mediaElements.length, errors };
  });
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
        return { ready: false, reason: 'no_rpcs' };
      }
      return { ready: true, uuid: rpcIds[0] };
    });
    if (last.ready) {
      return last;
    }
    await wait(500);
  }
  return last || { ready: false, reason: 'timeout' };
}

async function collectPeerSnapshot(page, uuid) {
  return page.evaluate(async (peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc', peerUuid };
    }

    const rpcEntry = sessionObj.rpcs[peerUuid];
    const peerConnection =
      rpcEntry && typeof rpcEntry.getStats === 'function'
        ? rpcEntry
        : (rpcEntry && rpcEntry.whep && typeof rpcEntry.whep.getStats === 'function' ? rpcEntry.whep : null);
    if (!peerConnection) {
      return { ok: false, reason: 'no_getStats', peerUuid };
    }

    const statsMap = await peerConnection.getStats();
    const reports = [];
    statsMap.forEach((report) => {
      const plain = { id: report.id, type: report.type, timestamp: report.timestamp };
      for (const key in report) {
        plain[key] = report[key];
      }
      reports.push(plain);
    });

    const byId = {};
    for (const report of reports) {
      byId[report.id] = report;
    }

    let selectedPair = null;
    for (const report of reports) {
      if (report.type === 'transport' && report.selectedCandidatePairId && byId[report.selectedCandidatePairId]) {
        selectedPair = byId[report.selectedCandidatePairId];
        break;
      }
    }
    if (!selectedPair) {
      selectedPair = reports.find((report) =>
        report.type === 'candidate-pair' &&
        (report.selected === true || (report.nominated === true && report.state === 'succeeded'))
      ) || null;
    }

    const localCandidate = selectedPair && selectedPair.localCandidateId ? (byId[selectedPair.localCandidateId] || null) : null;
    const remoteCandidate = selectedPair && selectedPair.remoteCandidateId ? (byId[selectedPair.remoteCandidateId] || null) : null;
    const inboundAudio = reports.find((report) =>
      report.type === 'inbound-rtp' &&
      !report.isRemote &&
      (report.kind === 'audio' || report.mediaType === 'audio')
    ) || null;
    const inboundVideo = reports.find((report) =>
      report.type === 'inbound-rtp' &&
      !report.isRemote &&
      (report.kind === 'video' || report.mediaType === 'video')
    ) || null;

    const mediaElements = Array.from(document.querySelectorAll('video, audio')).map((element) => {
      const info = {
        tag: element.tagName.toLowerCase(),
        readyState: Number(element.readyState || 0),
        currentTime: Number(element.currentTime || 0),
        paused: !!element.paused,
        ended: !!element.ended,
        width: Number(element.videoWidth || 0),
        height: Number(element.videoHeight || 0),
        totalVideoFrames: 0,
        trackStates: []
      };
      try {
        if (typeof element.getVideoPlaybackQuality === 'function') {
          info.totalVideoFrames = Number(element.getVideoPlaybackQuality().totalVideoFrames || 0);
        }
      } catch {
        // Ignore playback quality access failures.
      }
      try {
        if (element.srcObject && typeof element.srcObject.getTracks === 'function') {
          info.trackStates = element.srcObject.getTracks().map((track) => ({
            kind: track.kind,
            enabled: !!track.enabled,
            muted: !!track.muted,
            readyState: track.readyState || ''
          }));
        }
      } catch {
        // Ignore track enumeration failures.
      }
      return info;
    });

    return {
      ok: true,
      peerUuid,
      connectionState: peerConnection.connectionState || rpcEntry.connectionState || '',
      iceConnectionState: peerConnection.iceConnectionState || rpcEntry.iceConnectionState || '',
      selectedPair: selectedPair ? {
        state: selectedPair.state || '',
        bytesReceived: Number(selectedPair.bytesReceived || 0),
        bytesSent: Number(selectedPair.bytesSent || 0)
      } : null,
      localCandidate: localCandidate ? {
        candidateType: localCandidate.candidateType || localCandidate.type || '',
        protocol: localCandidate.protocol || '',
        address: localCandidate.address || localCandidate.ip || ''
      } : null,
      remoteCandidate: remoteCandidate ? {
        candidateType: remoteCandidate.candidateType || remoteCandidate.type || '',
        protocol: remoteCandidate.protocol || '',
        address: remoteCandidate.address || remoteCandidate.ip || ''
      } : null,
      inboundAudio: inboundAudio ? {
        packetsReceived: Number(inboundAudio.packetsReceived || 0),
        bytesReceived: Number(inboundAudio.bytesReceived || 0),
        totalSamplesReceived: Number(inboundAudio.totalSamplesReceived || 0)
      } : null,
      inboundVideo: inboundVideo ? {
        packetsReceived: Number(inboundVideo.packetsReceived || 0),
        bytesReceived: Number(inboundVideo.bytesReceived || 0),
        framesReceived: Number(inboundVideo.framesReceived || 0),
        framesDecoded: Number(inboundVideo.framesDecoded || 0),
        frameWidth: Number(inboundVideo.frameWidth || 0),
        frameHeight: Number(inboundVideo.frameHeight || 0)
      } : null,
      mediaElements,
      hasDecodedVideo: mediaElements.some((item) =>
        item.tag === 'video' &&
        item.readyState >= 2 &&
        item.width > 0 &&
        item.height > 0 &&
        item.currentTime > 0 &&
        !item.ended
      ),
      hasAudioTrack: mediaElements.some((item) =>
        Array.isArray(item.trackStates) &&
        item.trackStates.some((track) => track.kind === 'audio')
      )
    };
  }, uuid);
}

async function collectViewerDiagnostics(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    const rpcEntry = sessionObj && sessionObj.rpcs ? sessionObj.rpcs[peerUuid] || null : null;
    const peerConnection =
      rpcEntry && typeof rpcEntry.getStats === 'function'
        ? rpcEntry
        : (rpcEntry && rpcEntry.whep && typeof rpcEntry.whep.getStats === 'function' ? rpcEntry.whep : null);

    return {
      reliabilityCounters: sessionObj && sessionObj.reliabilityCounters ? { ...sessionObj.reliabilityCounters } : null,
      rpc: rpcEntry ? {
        session: rpcEntry.session || '',
        signalingState: rpcEntry.signalingState || '',
        connectionState: rpcEntry.connectionState || '',
        iceConnectionState: rpcEntry.iceConnectionState || '',
        localDescriptionType: rpcEntry.localDescription && rpcEntry.localDescription.type ? rpcEntry.localDescription.type : '',
        remoteDescriptionType: rpcEntry.remoteDescription && rpcEntry.remoteDescription.type ? rpcEntry.remoteDescription.type : '',
        remoteVideoSections: rpcEntry.remoteDescription && rpcEntry.remoteDescription.sdp ? (rpcEntry.remoteDescription.sdp.match(/^m=video /mg) || []).length : 0,
        remoteAudioSections: rpcEntry.remoteDescription && rpcEntry.remoteDescription.sdp ? (rpcEntry.remoteDescription.sdp.match(/^m=audio /mg) || []).length : 0,
        localVideoSections: rpcEntry.localDescription && rpcEntry.localDescription.sdp ? (rpcEntry.localDescription.sdp.match(/^m=video /mg) || []).length : 0,
        localAudioSections: rpcEntry.localDescription && rpcEntry.localDescription.sdp ? (rpcEntry.localDescription.sdp.match(/^m=audio /mg) || []).length : 0,
        hasRemoteVideo: Array.isArray(rpcEntry.remoteTracks) ? rpcEntry.remoteTracks.some((track) => track && track.kind === 'video') : false
      } : null,
      peerConnection: peerConnection ? {
        signalingState: peerConnection.signalingState || '',
        connectionState: peerConnection.connectionState || '',
        iceConnectionState: peerConnection.iceConnectionState || '',
        transceiverCount: typeof peerConnection.getTransceivers === 'function' ? peerConnection.getTransceivers().length : -1,
        receiverCount: typeof peerConnection.getReceivers === 'function' ? peerConnection.getReceivers().length : -1
      } : null
    };
  }, uuid);
}

function maxVideoCurrentTime(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.mediaElements)) {
    return 0;
  }
  return snapshot.mediaElements
    .filter((item) => item.tag === 'video')
    .reduce((maxValue, item) => Math.max(maxValue, Number(item.currentTime) || 0), 0);
}

function snapshotReady(snapshot, caseDef) {
  if (!snapshot || !snapshot.ok) {
    return false;
  }
  if (!(snapshot.connectionState === 'connected' || snapshot.iceConnectionState === 'connected' || snapshot.iceConnectionState === 'completed')) {
    return false;
  }
  if (!snapshot.remoteCandidate || !remoteCandidateMatches(caseDef, snapshot.remoteCandidate.candidateType)) {
    return false;
  }
  const audio = snapshot.inboundAudio || {};
  const video = snapshot.inboundVideo || {};
  const audioFlow =
    Number(audio.packetsReceived) > 0 ||
    Number(audio.bytesReceived) > 0 ||
    Number(audio.totalSamplesReceived) > 0;
  const videoFlow =
    snapshot.hasDecodedVideo &&
    (Number(video.framesDecoded) > 0 || Number(video.framesReceived) > 0 || Number(video.bytesReceived) > 0);
  return audioFlow && videoFlow;
}

async function waitForPlayablePeer(page, uuid, timeoutMs, caseDef) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    await ensureMediaElementsPlaying(page);
    last = await collectPeerSnapshot(page, uuid);
    if (snapshotReady(last, caseDef)) {
      return { ok: true, snapshot: last };
    }
    await wait(1000);
  }
  return { ok: false, snapshot: last };
}

function assertPlaybackProgress(before, after, caseDef) {
  assertOk(after && after.ok, 'missing post-hold snapshot', after);
  assertOk(after.remoteCandidate && remoteCandidateMatches(caseDef, after.remoteCandidate.candidateType),
    'selected remote candidate changed unexpectedly', after);
  assertOk(after.hasDecodedVideo, 'decoded video was lost during hold', after);

  const audioBefore = before && before.inboundAudio ? before.inboundAudio : {};
  const audioAfter = after.inboundAudio || {};
  const videoBefore = before && before.inboundVideo ? before.inboundVideo : {};
  const videoAfter = after.inboundVideo || {};

  const audioAdvanced =
    Number(audioAfter.bytesReceived) > Number(audioBefore.bytesReceived) ||
    Number(audioAfter.packetsReceived) > Number(audioBefore.packetsReceived) ||
    Number(audioAfter.totalSamplesReceived) > Number(audioBefore.totalSamplesReceived);
  const videoAdvanced =
    Number(videoAfter.bytesReceived) > Number(videoBefore.bytesReceived) ||
    Number(videoAfter.framesDecoded) > Number(videoBefore.framesDecoded) ||
    Number(videoAfter.framesReceived) > Number(videoBefore.framesReceived);

  assertOk(audioAdvanced, 'audio stats did not advance during hold', { before: audioBefore, after: audioAfter });
  assertOk(videoAdvanced, 'video stats did not advance during hold', { before: videoBefore, after: videoAfter });
  assertOk(maxVideoCurrentTime(after) > maxVideoCurrentTime(before),
    'video currentTime did not advance during hold',
    { before: maxVideoCurrentTime(before), after: maxVideoCurrentTime(after) });
}

function summarizeFailure(entry) {
  return entry && entry.failure && entry.failure.message ? entry.failure.message : 'unknown failure';
}

function writeReport(config, startedAt, finishedAt, results) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const reportPath = path.join(config.reportDir, `ice-connectivity-${nowStamp()}.md`);
  const lines = [
    '# ICE Connectivity E2E Report',
    '',
    `- Date: ${new Date(startedAt).toISOString()}`,
    `- Result: ${results.every((entry) => entry.pass) ? 'PASS' : 'FAIL'}`,
    `- Duration (s): ${Math.round((finishedAt - startedAt) / 1000)}`,
    `- Stream base: ${config.streamBase}`,
    '',
    '| Case | ICE Mode | Candidate | Result |',
    '|---|---|---|:---:|'
  ];

  for (const entry of results) {
    lines.push(`| ${entry.name} | ${entry.iceMode} | ${entry.remoteCandidateType} | ${entry.pass ? 'PASS' : 'FAIL'} |`);
  }

  for (const entry of results) {
    lines.push('', `## Case: ${entry.name}`, '');
    lines.push(`- Result: ${entry.pass ? 'PASS' : 'FAIL'}`);
    lines.push(`- Viewer URL: ${entry.viewerUrl}`);
    lines.push(`- Capture filter: ${entry.windowFilter}`);
    if (entry.iceSummary) {
      lines.push(`- ICE summary: ${entry.iceSummary}`);
    }
    if (entry.offerSummary) {
      lines.push(`- Offer summary: ${entry.offerSummary}`);
    }
    if (entry.initialSnapshot) {
      lines.push(`- Initial snapshot: ${JSON.stringify(entry.initialSnapshot)}`);
    }
    if (entry.finalSnapshot) {
      lines.push(`- Final snapshot: ${JSON.stringify(entry.finalSnapshot)}`);
    }
    if (entry.viewerDiagnostics) {
      lines.push(`- Viewer diagnostics: ${JSON.stringify(entry.viewerDiagnostics)}`);
    }
    if (entry.viewerConsole && entry.viewerConsole.length) {
      lines.push(`- Viewer console tail: ${JSON.stringify(entry.viewerConsole.slice(-20))}`);
    }
    if (!entry.pass) {
      lines.push(`- Failure: ${summarizeFailure(entry)}`);
    }
    if (entry.screenshot) {
      lines.push(`- Screenshot: ${entry.screenshot}`);
    }
    lines.push('', '```text');
    const output = (entry.publisherOutput || '').trim();
    if (output) {
      lines.push(...output.split(/\r?\n/).slice(-220));
    }
    lines.push('```');
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

async function executeCase(config, caseDef) {
  const streamId = sanitizeId(`${config.streamBase}_${caseDef.name}`, 64, `ice_${Date.now()}`).replace(/ /g, '_');
  const viewerUrl = buildViewerUrl(streamId, config.password);
  const result = {
    name: caseDef.name,
    iceMode: caseDef.iceMode,
    remoteCandidateType: caseDef.remoteCandidateType,
    streamId,
    viewerUrl,
    pass: false,
    failure: null,
    screenshot: '',
    iceSummary: '',
    offerSummary: '',
    initialSnapshot: null,
    finalSnapshot: null,
    viewerDiagnostics: null,
    viewerConsole: [],
    publisherOutput: '',
    windowFilter: ''
  };

  let source = null;
  let publisher = null;
  let browser = null;
  let context = null;
  let page = null;
  let peerUuid = '';

  try {
    source = await createCaptureSource(`${config.streamBase}_${caseDef.name}`, config.sourceWarmupMs);
    result.windowFilter = source.windowTitle;

    publisher = spawnPublisher(config, {
      streamId,
      label: `${config.label}-${caseDef.name}`,
      iceMode: caseDef.iceMode,
      windowFilter: source.windowTitle
    });

    assertOk((await waitForPublisherLog(publisher, /\[Headless\] Found .* capturing:/i, 20000)).ok,
      `${caseDef.name}: publisher did not capture the source window`);
    assertOk((await waitForPublisherLog(publisher, /\[App\] VIEW URL:/i, 20000)).ok,
      `${caseDef.name}: publisher did not publish a view URL`);
    assertOk((await waitForPublisherLog(
      publisher,
      new RegExp(`\\[ICE\\] Mode=${caseDef.iceMode}`, 'i'),
      20000
    )).ok, `${caseDef.name}: missing ICE summary log`);

    result.iceSummary = publisherOutputText(publisher)
      .split(/\r?\n/)
      .find((line) => /\[ICE\] Mode=/i.test(line)) || '';
    assertIceSummaryLine(result.iceSummary, caseDef);

    await wait(config.startupDelayMs);

    browser = await chromium.launch({
      headless: !config.headful,
      args: ['--autoplay-policy=no-user-gesture-required']
    });
    context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();
    page.on('console', (msg) => {
      result.viewerConsole.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      result.viewerConsole.push(`[pageerror] ${err && err.message ? err.message : String(err)}`);
    });
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peerState = await waitForSessionPeer(page, 20000);
    assertOk(peerState && peerState.ready, `${caseDef.name}: viewer peer never appeared`, peerState);
    peerUuid = peerState.uuid;
    const offerState = await waitForPublisherOfferCount(publisher, 2, 30000);
    assertOk(offerState.ok, `${caseDef.name}: publisher never emitted bootstrap + media offers`, offerState);
    const offerSequence = assertBootstrapOfferSequence(offerState.output, caseDef);
    assertOfferCandidateMode(offerState.output, caseDef);
    result.offerSummary = `offers=${offerSequence.offerCount} bootstrap=datachannel-only media=audio+video`;

    const playable = await waitForPlayablePeer(page, peerUuid, config.timeoutMs, caseDef);
    assertOk(playable.ok, `${caseDef.name}: did not reach playable media state`, playable.snapshot || playable);
    result.initialSnapshot = playable.snapshot;

    await wait(config.holdMs);
    await ensureMediaElementsPlaying(page);
    result.finalSnapshot = await collectPeerSnapshot(page, peerUuid);
    result.viewerDiagnostics = await collectViewerDiagnostics(page, peerUuid);
    assertPlaybackProgress(playable.snapshot, result.finalSnapshot, caseDef);

    result.screenshot = await saveScreenshot(page, config.screenshotDir, `ice-connectivity-pass-${caseDef.name}`);
    result.pass = true;
  } catch (err) {
    result.failure = {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : ''
    };
    if (page && peerUuid) {
      result.viewerDiagnostics = await collectViewerDiagnostics(page, peerUuid).catch(() => result.viewerDiagnostics);
    }
    if (page) {
      result.screenshot = await saveScreenshot(page, config.screenshotDir, `ice-connectivity-fail-${caseDef.name}`);
    }
  } finally {
    if (publisher) {
      stopProcess(publisher.proc);
      result.publisherOutput = publisherOutputText(publisher);
    }
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (source) {
      await source.context.close().catch(() => {});
      await source.browser.close().catch(() => {});
    }
  }

  return result;
}

async function main() {
  const config = parseArgs(process.argv);
  console.log(`[ICE-E2E] Stream base: ${config.streamBase}`);
  console.log(`[ICE-E2E] Cases: ${config.caseKeys.join(', ')}`);

  const startedAt = Date.now();
  const results = [];
  for (const caseKey of config.caseKeys) {
    const caseDef = CASES[caseKey];
    console.log(`[ICE-E2E] Running case: ${caseDef.name} (${caseDef.iceMode})`);
    const result = await executeCase(config, caseDef);
    results.push(result);
    if (result.pass) {
      console.log(`[ICE-E2E] PASS ${result.name}`);
    } else {
      console.error(`[ICE-E2E] FAIL ${result.name}: ${summarizeFailure(result)}`);
    }
  }

  const finishedAt = Date.now();
  const reportPath = writeReport(config, startedAt, finishedAt, results);
  console.log(`[ICE-E2E] Report: ${reportPath}`);

  if (results.every((entry) => entry.pass)) {
    console.log('[ICE-E2E] PASS');
    process.exit(0);
  }
  console.error('[ICE-E2E] FAIL');
  process.exit(1);
}

main().catch((err) => {
  console.error('[ICE-E2E] Unhandled error:', err);
  process.exit(1);
});
