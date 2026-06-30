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
    publisherDefaultBitrateKbps: 12000,
    targetAudioBitrateKbps: 48,
    publisherDefaultAudioBitrateKbps: 192,
    requestResolution: '',
    remoteToken: 'control-token',
    viewerBaseUrl: 'https://vdo.ninja/',
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
    } else if (arg.startsWith('--publisher-default-bitrate-kbps=')) {
      args.publisherDefaultBitrateKbps = Number(arg.slice('--publisher-default-bitrate-kbps='.length)) || args.publisherDefaultBitrateKbps;
    } else if (arg.startsWith('--target-audio-bitrate-kbps=')) {
      args.targetAudioBitrateKbps = Number(arg.slice('--target-audio-bitrate-kbps='.length)) || args.targetAudioBitrateKbps;
    } else if (arg.startsWith('--publisher-default-audio-bitrate-kbps=')) {
      args.publisherDefaultAudioBitrateKbps = Number(arg.slice('--publisher-default-audio-bitrate-kbps='.length)) || args.publisherDefaultAudioBitrateKbps;
    } else if (arg.startsWith('--request-resolution=')) {
      args.requestResolution = arg.slice('--request-resolution='.length).trim();
    } else if (arg.startsWith('--remote-token=')) {
      args.remoteToken = arg.slice('--remote-token='.length);
    } else if (arg.startsWith('--viewer-base-url=')) {
      args.viewerBaseUrl = arg.slice('--viewer-base-url='.length);
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
  return `${config.viewerBaseUrl}?${query.toString()}`;
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

async function waitForPublisherStdout(publisher, predicate, timeoutMs, stageLabel) {
  const start = Date.now();
  let stdoutText = '';
  while (Date.now() - start < timeoutMs) {
    stdoutText = publisher.stdout.join('');
    if (predicate(stdoutText)) {
      return { ok: true, state: { stdoutLength: stdoutText.length } };
    }
    await wait(250);
  }
  return {
    ok: false,
    stage: stageLabel,
    state: { stdoutTail: stdoutText.slice(-4000) }
  };
}

function offerIceUfragAfter(stdoutText, markerIndex) {
  if (markerIndex < 0) {
    return '';
  }
  const offerStart = stdoutText.indexOf('[WebRTC] === SDP OFFER START ===', markerIndex);
  if (offerStart < 0) {
    return '';
  }
  const offerEnd = stdoutText.indexOf('[WebRTC] === SDP OFFER END ===', offerStart);
  const offerText = stdoutText.slice(offerStart, offerEnd >= 0 ? offerEnd : undefined);
  const match = offerText.match(/^a=ice-ufrag:([^\r\n]+)/m);
  return match ? match[1] : '';
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

function clampEvenDimension(value, minimum, maximum) {
  const clamped = Math.min(Math.max(Math.round(value), minimum), maximum);
  return Math.max(2, clamped & ~1);
}

function completeVdoScaleResolution(requestedWidth, requestedHeight, baseWidth, baseHeight, cover = false) {
  const nativeWidth = baseWidth > 0 ? baseWidth : 16;
  const nativeHeight = baseHeight > 0 ? baseHeight : 9;
  const hasWidth = requestedWidth > 0;
  const hasHeight = requestedHeight > 0;
  if (!hasWidth && !hasHeight) {
    return null;
  }

  let scale = 1;
  if (!hasWidth) {
    scale = requestedHeight / nativeHeight;
  } else if (!hasHeight) {
    scale = requestedWidth / nativeWidth;
  } else {
    const widthScale = requestedWidth / nativeWidth;
    const heightScale = requestedHeight / nativeHeight;
    scale = cover ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);
  }
  if (!(scale > 0)) {
    return null;
  }
  scale = Math.min(scale, 1);

  return {
    w: clampEvenDimension(nativeWidth * scale, 160, 3840),
    h: clampEvenDimension(nativeHeight * scale, 90, 2160)
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

async function sendControlMessageWithRetry(page, payload, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    await waitForSessionPeer(page, Math.min(2000, Math.max(500, timeoutMs)));
    last = await sendControlMessage(page, payload);
    if (last && last.ok) {
      return last;
    }
    await wait(500);
  }
  return last || { ok: false, reason: 'timeout' };
}

async function sendSignalingMessage(page, payload) {
  return page.evaluate((msg) => {
    const sessionObj = window.session || null;
    if (!sessionObj) {
      return { ok: false, reason: 'no_session' };
    }

    const rpcIds = Object.keys(sessionObj.rpcs || {});
    const uuid = msg.UUID || rpcIds[0] || '';
    if (!uuid) {
      return { ok: false, reason: 'no_uuid' };
    }

    const message = { ...msg, UUID: uuid };
    if (typeof sessionObj.sendMsg === 'function') {
      sessionObj.sendMsg(message);
      return { ok: true, uuid, route: 'sendMsg' };
    }

    if (sessionObj.ws && sessionObj.ws.readyState === 1 && typeof sessionObj.ws.send === 'function') {
      sessionObj.ws.send(JSON.stringify(message));
      return { ok: true, uuid, route: 'ws.send' };
    }

    return { ok: false, uuid, reason: 'no_signaling_send' };
  }, payload);
}

async function sendInitMessage(page, payload) {
  return sendControlMessage(page, payload);
}

async function installControlMessageProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc', uuid: peerUuid };
    }

    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__gameCaptureControlProbe || { messages: [] };
    if (!Array.isArray(probe.messages)) {
      probe.messages = [];
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
        probe.messages.push({
          ts: Date.now(),
          channel: channelName,
          message: parsed
        });
        if (probe.messages.length > 100) {
          probe.messages.shift();
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

async function waitForControlInfo(page, timeoutMs, expectedBitrate, expectedResolution, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ bitrate, resolution, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const latest = messages.length ? messages[messages.length - 1] : null;
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        if (!info) {
          return false;
        }
        const bitrateOk = !Number.isFinite(bitrate) ||
          bitrate <= 0 ||
          Number(info.quality_url) === Number(bitrate);
        const resolutionOk = !resolution ||
          (Number(info.width_url) === Number(resolution.w) &&
           Number(info.height_url) === Number(resolution.h));
        return bitrateOk && resolutionOk;
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest,
        success
      };
    }, { bitrate: expectedBitrate, resolution: expectedResolution || null, minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }

  return { ok: false, stage: 'control-info', state: lastState };
}

async function waitForNoControlInfoBitrate(page, timeoutMs, unexpectedBitrate, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ bitrate, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const match = candidates.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        return info && Number(info.quality_url) === Number(bitrate);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        match
      };
    }, { bitrate: unexpectedBitrate, minCount: minMessageCount });

    if (lastState && lastState.match) {
      return { ok: false, stage: 'unexpected-control-info-bitrate', state: lastState };
    }
    await wait(250);
  }

  return { ok: true, state: lastState };
}

async function waitForRateLimitInfo(page, timeoutMs, expectedVideoBitrate, expectedAudioBitrate, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ videoBitrate, audioBitrate, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        if (!info) {
          return false;
        }
        return Number(info.requested_video_bitrate_kbps) === Number(videoBitrate) &&
          Number(info.requested_audio_bitrate_kbps) === Number(audioBitrate);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, { videoBitrate: expectedVideoBitrate, audioBitrate: expectedAudioBitrate, minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'rate-limit-info', state: lastState };
}

async function getProbeMessageCount(page) {
  return page.evaluate(() => {
    const probe = window.__gameCaptureControlProbe || { messages: [] };
    const messages = Array.isArray(probe.messages) ? probe.messages : [];
    return messages.length;
  });
}

async function waitForProbeMessageField(page, timeoutMs, field, expectedValue, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ key, value, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const message = entry && entry.message ? entry.message : null;
        if (!message || !(key in message)) {
          return false;
        }
        return message[key] === value;
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, { key: field, value: expectedValue, minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: `${field}-message`, state: lastState };
}

async function waitForRequestedVideoInfo(page, timeoutMs, expectedVideoBitrate, expectedMuted, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ videoBitrate, muted, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        if (!info) {
          return false;
        }
        return Number(info.requested_video_bitrate_kbps) === Number(videoBitrate) &&
          Boolean(info.video_muted_init) === Boolean(muted);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, { videoBitrate: expectedVideoBitrate, muted: expectedMuted, minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'requested-video-info', state: lastState };
}

async function waitForRequestedAudioInfo(
  page,
  timeoutMs,
  expectedAudioBitrate,
  minMessageCount = 0,
  expectedResolution = null
) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ audioBitrate, minCount, resolution }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const info = entry && entry.message ? entry.message.info : null;
        if (!info) {
          return false;
        }
        const audioBitrateOk = Number(info.requested_audio_bitrate_kbps) === Number(audioBitrate);
        const resolutionOk = !resolution ||
          (Number(info.width_url) === Number(resolution.w) &&
           Number(info.height_url) === Number(resolution.h));
        return audioBitrateOk && resolutionOk;
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, {
      audioBitrate: expectedAudioBitrate,
      minCount: minMessageCount,
      resolution: expectedResolution || null
    });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'requested-audio-info', state: lastState };
}

async function waitForSettingsPayload(page, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate((minCount) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const audioOptions = candidates.find((entry) =>
        entry && entry.message && Array.isArray(entry.message.audioOptions)) || null;
      const videoOptions = candidates.find((entry) =>
        entry && entry.message && entry.message.videoOptions &&
        typeof entry.message.videoOptions === 'object') || null;
      const mediaDevices = candidates.find((entry) =>
        entry && entry.message && Array.isArray(entry.message.mediaDevices)) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        audioOptions,
        videoOptions,
        mediaDevices,
        success: !!audioOptions && !!videoOptions && !!mediaDevices
      };
    }, minMessageCount);

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'settings-payload', state: lastState };
}

async function waitForVideoSettingsPayload(page, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate((minCount) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const videoOptions = candidates.find((entry) =>
        entry && entry.message && entry.message.videoOptions &&
        typeof entry.message.videoOptions === 'object') || null;
      const mediaDevices = candidates.find((entry) =>
        entry && entry.message && Array.isArray(entry.message.mediaDevices)) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        videoOptions,
        mediaDevices,
        success: !!videoOptions && !!mediaDevices
      };
    }, minMessageCount);

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'video-settings-payload', state: lastState };
}

async function waitForNoSettingsPayload(page, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate((minCount) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const payload = candidates.find((entry) => {
        const message = entry && entry.message ? entry.message : null;
        if (!message || typeof message !== 'object') {
          return false;
        }
        return Array.isArray(message.audioOptions) ||
          (message.videoOptions && typeof message.videoOptions === 'object') ||
          Array.isArray(message.mediaDevices);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        payload
      };
    }, minMessageCount);

    if (lastState && lastState.payload) {
      return { ok: false, stage: 'unauthorized-settings-payload', state: lastState };
    }
    await wait(250);
  }
  return { ok: true, state: lastState };
}

async function waitForVideoOptionsFrameRate(page, timeoutMs, expectedFrameRate, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ frameRate, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const options = entry && entry.message ? entry.message.videoOptions : null;
        const current = options && options.currentCameraConstraints;
        if (!current) {
          return false;
        }
        return Number(current.frameRate) === Number(frameRate);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, { frameRate: expectedFrameRate, minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'video-options-framerate', state: lastState };
}

async function waitForVideoOptionsDimensions(page, timeoutMs, expectedWidth, expectedHeight, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ width, height, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const options = entry && entry.message ? entry.message.videoOptions : null;
        const current = options && options.currentCameraConstraints;
        if (!current) {
          return false;
        }
        return Number(current.width) === Number(width) &&
          Number(current.height) === Number(height);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, { width: expectedWidth, height: expectedHeight, minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'video-options-dimensions', state: lastState };
}

async function waitForNoVideoOptionsFrameRate(page, timeoutMs, unexpectedFrameRate, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ frameRate, minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const match = candidates.find((entry) => {
        const options = entry && entry.message ? entry.message.videoOptions : null;
        const current = options && options.currentCameraConstraints;
        if (!current) {
          return false;
        }
        return Number(current.frameRate) === Number(frameRate);
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        match
      };
    }, { frameRate: unexpectedFrameRate, minCount: minMessageCount });

    if (lastState && lastState.match) {
      return { ok: false, stage: 'unexpected-video-options-framerate', state: lastState };
    }
    await wait(250);
  }
  return { ok: true, state: lastState };
}

async function waitForRemoteStats(page, timeoutMs, minMessageCount = 0) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await page.evaluate(({ minCount }) => {
      const probe = window.__gameCaptureControlProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const candidates = messages.slice(Math.max(0, minCount));
      const success = candidates.find((entry) => {
        const msg = entry && entry.message;
        if (!msg || !msg.remoteStats || !Object.keys(msg.remoteStats).length) {
          return false;
        }
        return Object.values(msg.remoteStats).some((stats) => {
          if (!stats || typeof stats !== 'object') {
            return false;
          }
          const bitrate = Number(stats.video_bitrate_kbps);
          const resolution = String(stats.resolution || '');
          const encoder = String(stats.video_encoder || '');
          return Number.isFinite(bitrate) &&
            bitrate >= 0 &&
            /\d+\s*x\s*\d+/i.test(resolution) &&
            encoder.length > 0;
        });
      }) || null;
      return {
        messageCount: messages.length,
        minCount,
        latest: messages.length ? messages[messages.length - 1] : null,
        success
      };
    }, { minCount: minMessageCount });

    if (lastState && lastState.success) {
      return { ok: true, state: lastState };
    }
    await wait(250);
  }
  return { ok: false, stage: 'remote-stats', state: lastState };
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

    const probeResult = await installControlMessageProbe(page, peerState.uuid);
    if (!probeResult.ok) {
      failure = { stage: 'control-probe', state: probeResult };
      return;
    }

    let probeMessageCount = await getProbeMessageCount(page);
    const unauthorizedSettingsSend = await sendControlMessage(page, { getAudioSettings: true, getVideoSettings: true });
    if (!unauthorizedSettingsSend.ok) {
      failure = { stage: 'send-unauthorized-settings-request', state: unauthorizedSettingsSend };
      return;
    }
    const unauthorizedSettingsResult = await waitForNoSettingsPayload(
      page,
      2500,
      probeMessageCount
    );
    if (!unauthorizedSettingsResult.ok) {
      failure = unauthorizedSettingsResult;
      return;
    }
    console.log('[CONTROL] VDO settings unauthorized guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const remoteTokenSettingsSend = await sendControlMessage(page, {
      getAudioSettings: true,
      getVideoSettings: true,
      remote: config.remoteToken
    });
    if (!remoteTokenSettingsSend.ok) {
      failure = { stage: 'send-remote-token-settings-request', state: remoteTokenSettingsSend };
      return;
    }
    const remoteTokenSettingsResult = await waitForNoSettingsPayload(
      page,
      2500,
      probeMessageCount
    );
    if (!remoteTokenSettingsResult.ok) {
      failure = remoteTokenSettingsResult;
      return;
    }
    console.log('[CONTROL] VDO settings remote-token guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const aliasTokenRefreshVideoSend = await sendControlMessage(page, {
      refreshVideo: true,
      token: config.remoteToken
    });
    if (!aliasTokenRefreshVideoSend.ok) {
      failure = { stage: 'send-refresh-video-token-alias-request', state: aliasTokenRefreshVideoSend };
      return;
    }
    const aliasTokenRefreshVideoRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'refreshVideo',
      probeMessageCount
    );
    if (!aliasTokenRefreshVideoRejected.ok) {
      failure = aliasTokenRefreshVideoRejected;
      return;
    }
    console.log('[CONTROL] VDO refreshVideo token-alias guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const remoteTokenRefreshVideoSend = await sendControlMessage(page, {
      refreshVideo: true,
      remote: config.remoteToken
    });
    if (!remoteTokenRefreshVideoSend.ok) {
      failure = { stage: 'send-refresh-video-request', state: remoteTokenRefreshVideoSend };
      return;
    }
    const refreshVideoResult = await waitForVideoSettingsPayload(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      probeMessageCount
    );
    if (!refreshVideoResult.ok) {
      failure = refreshVideoResult;
      return;
    }
    console.log('[CONTROL] VDO refreshVideo remote-token payload PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const remoteTokenRefreshMicrophoneSend = await sendControlMessage(page, {
      refreshMicrophone: true,
      remote: config.remoteToken
    });
    if (!remoteTokenRefreshMicrophoneSend.ok) {
      failure = { stage: 'send-refresh-microphone-request', state: remoteTokenRefreshMicrophoneSend };
      return;
    }
    const refreshMicrophoneRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'refreshMicrophone',
      probeMessageCount
    );
    if (!refreshMicrophoneRejected.ok) {
      failure = refreshMicrophoneRejected;
      return;
    }
    console.log('[CONTROL] VDO refreshMicrophone remote-token guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const unauthorizedHangupSend = await sendControlMessage(page, { hangup: true });
    if (!unauthorizedHangupSend.ok) {
      failure = { stage: 'send-unauthorized-hangup', state: unauthorizedHangupSend };
      return;
    }
    const unauthorizedHangupRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'hangup',
      probeMessageCount
    );
    if (!unauthorizedHangupRejected.ok) {
      failure = unauthorizedHangupRejected;
      return;
    }
    console.log('[CONTROL] VDO hangup unauthorized guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const unsupportedAudioHackSend = await sendControlMessage(page, {
      requestAudioHack: true,
      keyname: 'gain',
      value: 1,
      remote: config.remoteToken
    });
    if (!unsupportedAudioHackSend.ok) {
      failure = { stage: 'send-unsupported-audio-hack', state: unsupportedAudioHackSend };
      return;
    }
    const unsupportedAudioHackRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'requestAudioHack',
      probeMessageCount
    );
    if (!unsupportedAudioHackRejected.ok) {
      failure = unsupportedAudioHackRejected;
      return;
    }
    console.log('[CONTROL] VDO unsupported requestAudioHack rejection PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const unsupportedLowcutSend = await sendControlMessage(page, {
      requestChangeLowcut: true,
      value: 80,
      track: 0,
      remote: config.remoteToken
    });
    if (!unsupportedLowcutSend.ok) {
      failure = { stage: 'send-unsupported-lowcut', state: unsupportedLowcutSend };
      return;
    }
    const unsupportedLowcutRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'requestChangeLowcut',
      probeMessageCount
    );
    if (!unsupportedLowcutRejected.ok) {
      failure = unsupportedLowcutRejected;
      return;
    }
    console.log('[CONTROL] VDO unsupported requestChangeLowcut rejection PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const unsupportedRestartWhipSend = await sendControlMessage(page, {
      restartWhip: true
    });
    if (!unsupportedRestartWhipSend.ok) {
      failure = { stage: 'send-unsupported-restart-whip', state: unsupportedRestartWhipSend };
      return;
    }
    const unsupportedRestartWhipRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'restartWhip',
      probeMessageCount
    );
    if (!unsupportedRestartWhipRejected.ok) {
      failure = unsupportedRestartWhipRejected;
      return;
    }
    console.log('[CONTROL] VDO unsupported restartWhip rejection PASS');

    const unsupportedControlSamples = [
      ['obsCommand', { obsCommand: 'getScenes', remote: config.remoteToken }],
      ['getOBSState', { getOBSState: true, remote: config.remoteToken }],
      ['reload', { reload: true }],
      ['scale', { scale: 50 }],
      ['zoom', { zoom: 0.5, remote: config.remoteToken, abs: false }],
      ['autofocus', { autofocus: true, remote: config.remoteToken }],
      ['exposure', { exposure: 0.25, remote: config.remoteToken, abs: false }],
      ['keyframeRate', { keyframeRate: 5000, remote: config.remoteToken }]
    ];
    for (const [controlName, payload] of unsupportedControlSamples) {
      probeMessageCount = await getProbeMessageCount(page);
      const sendResult = await sendControlMessage(page, payload);
      if (!sendResult.ok) {
        failure = { stage: `send-unsupported-${controlName}`, state: sendResult };
        return;
      }
      const rejection = await waitForProbeMessageField(
        page,
        Math.max(3000, Math.floor(config.timeoutMs / 5)),
        'rejected',
        controlName,
        probeMessageCount
      );
      if (!rejection.ok) {
        failure = rejection;
        return;
      }
      console.log(`[CONTROL] VDO unsupported ${controlName} rejection PASS`);
    }

    probeMessageCount = await getProbeMessageCount(page);
    const unauthorizedVideoHackFrameRate = 24;
    const unauthorizedVideoHackSend = await sendControlMessage(page, {
      requestVideoHack: true,
      keyname: 'frameRate',
      value: unauthorizedVideoHackFrameRate,
      ctrl: true
    });
    if (!unauthorizedVideoHackSend.ok) {
      failure = { stage: 'send-unauthorized-video-hack-framerate', state: unauthorizedVideoHackSend };
      return;
    }
    const unauthorizedVideoHackResult = await waitForNoVideoOptionsFrameRate(
      page,
      2500,
      unauthorizedVideoHackFrameRate,
      probeMessageCount
    );
    if (!unauthorizedVideoHackResult.ok) {
      failure = unauthorizedVideoHackResult;
      return;
    }
    console.log('[CONTROL] VDO requestVideoHack unauthorized guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const videoHackFrameRate = 30;
    const videoHackSend = await sendControlMessage(page, {
      requestVideoHack: true,
      keyname: 'frameRate',
      value: videoHackFrameRate,
      ctrl: true,
      remote: config.remoteToken
    });
    if (!videoHackSend.ok) {
      failure = { stage: 'send-video-hack-framerate', state: videoHackSend };
      return;
    }
    const videoOptionsResult = await waitForVideoOptionsFrameRate(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      videoHackFrameRate,
      probeMessageCount
    );
    if (!videoOptionsResult.ok) {
      failure = videoOptionsResult;
      return;
    }
    console.log(`[CONTROL] VDO requestVideoHack frameRate PASS (${JSON.stringify(videoOptionsResult.state.success.message.videoOptions)})`);

    const currentVideoConstraints = videoOptionsResult.state.success.message.videoOptions.currentCameraConstraints;
    const currentVideoWidth = Number(currentVideoConstraints.width);
    const currentVideoHeight = Number(currentVideoConstraints.height);
    const noCtrlHeight = currentVideoHeight === 720 ? 540 : 720;
    probeMessageCount = await getProbeMessageCount(page);
    const noCtrlHeightSend = await sendControlMessage(page, {
      requestVideoHack: true,
      keyname: 'height',
      value: noCtrlHeight,
      ctrl: false,
      remote: config.remoteToken
    });
    if (!noCtrlHeightSend.ok) {
      failure = { stage: 'send-video-hack-height-no-ctrl', state: noCtrlHeightSend };
      return;
    }
    const noCtrlHeightResult = await waitForVideoOptionsDimensions(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      currentVideoWidth,
      noCtrlHeight,
      probeMessageCount
    );
    if (!noCtrlHeightResult.ok) {
      failure = noCtrlHeightResult;
      return;
    }
    console.log(`[CONTROL] VDO requestVideoHack height no-ctrl PASS (${currentVideoWidth}x${noCtrlHeight})`);

    const vdoStatsResolutionRequest = { w: 4096, h: noCtrlHeight, s: false, c: false };
    const vdoStatsResolutionExpected = completeVdoScaleResolution(
      vdoStatsResolutionRequest.w,
      vdoStatsResolutionRequest.h,
      currentVideoWidth,
      currentVideoHeight,
      vdoStatsResolutionRequest.c
    );
    probeMessageCount = await getProbeMessageCount(page);
    const vdoStatsResolutionSend = await sendControlMessage(page, {
      requestResolution: vdoStatsResolutionRequest,
      remote: config.remoteToken
    });
    if (!vdoStatsResolutionSend.ok) {
      failure = { stage: 'send-vdo-stats-resolution', state: vdoStatsResolutionSend };
      return;
    }
    const vdoStatsResolutionInfo = await waitForControlInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      null,
      vdoStatsResolutionExpected,
      probeMessageCount
    );
    if (!vdoStatsResolutionInfo.ok) {
      failure = vdoStatsResolutionInfo;
      return;
    }
    console.log(`[CONTROL] VDO stats requestResolution scale PASS (${JSON.stringify(vdoStatsResolutionInfo.state.success.message.info)})`);
    const postVdoStatsResolutionVideo = await waitForDecodedVideo(
      page,
      Math.max(10000, Math.floor(config.timeoutMs / 3)),
      'post-vdo-stats-resolution-video'
    );
    if (!postVdoStatsResolutionVideo.ok) {
      failure = postVdoStatsResolutionVideo;
      return;
    }
    await wait(500);

    const controlMessage = {
      keyframe: true,
      requestStats: true,
      targetBitrate: config.bitrateKbps,
      targetAudioBitrate: config.targetAudioBitrateKbps,
      remote: config.remoteToken
    };
    const requestedResolution = parseResolution(config.requestResolution);
    if (requestedResolution) {
      controlMessage.requestResolution = requestedResolution;
    }

    probeMessageCount = await getProbeMessageCount(page);
    const sendResult = await sendControlMessageWithRetry(
      page,
      controlMessage,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    );
    if (!sendResult.ok) {
      failure = { stage: 'send-control', state: sendResult };
      return;
    }
    console.log(`[CONTROL] Control message sent via ${sendResult.hasSendRequest ? 'session.sendRequest' : 'data channel direct'} to ${sendResult.uuid}`);

    const infoResult = await waitForControlInfo(
      page,
      Math.max(5000, config.timeoutMs / 2),
      config.bitrateKbps,
      requestedResolution,
      probeMessageCount
    );
    if (!infoResult.ok) {
      failure = infoResult;
      return;
    }
    console.log(`[CONTROL] Control info PASS (${JSON.stringify(infoResult.state.success.message.info)})`);

    const audioTargetInfo = await waitForRequestedAudioInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      config.targetAudioBitrateKbps,
      probeMessageCount,
      requestedResolution
    );
    if (!audioTargetInfo.ok) {
      failure = audioTargetInfo;
      return;
    }
    console.log(`[CONTROL] VDO targetAudioBitrate info PASS (${JSON.stringify(audioTargetInfo.state.success.message.info)})`);

    probeMessageCount = await getProbeMessageCount(page);
    const metadataFanoutSend = await sendControlMessage(page, {
      info: {
        label: 'control-e2e metadata refresh',
        system: {
          app: 'game-capture-control-e2e'
        }
      },
      keyframe: true,
      requestStats: true,
      remote: config.remoteToken
    });
    if (!metadataFanoutSend.ok) {
      failure = { stage: 'send-metadata-fanout', state: metadataFanoutSend };
      return;
    }
    const metadataFanoutStats = await waitForRemoteStats(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      probeMessageCount
    );
    if (!metadataFanoutStats.ok) {
      failure = {
        stage: 'metadata-fanout-remote-stats',
        state: metadataFanoutStats
      };
      return;
    }
    console.log('[CONTROL] VDO metadata fanout requestStats PASS');

    const rateLimitVideoKbps = 500;
    const rateLimitAudioKbps = 16;
    const rateLimitSend = await sendControlMessage(page, { bitrate: rateLimitVideoKbps, audioBitrate: rateLimitAudioKbps });
    if (!rateLimitSend.ok) {
      failure = { stage: 'send-rate-limit', state: rateLimitSend };
      return;
    }
    const rateLimitInfo = await waitForRateLimitInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      rateLimitVideoKbps,
      rateLimitAudioKbps
    );
    if (!rateLimitInfo.ok) {
      failure = rateLimitInfo;
      return;
    }
    console.log(`[CONTROL] VDO rate-limit info PASS (${JSON.stringify(rateLimitInfo.state.success.message.info)})`);

    probeMessageCount = await getProbeMessageCount(page);
    const routeDisableSend = await sendControlMessage(page, { bitrate: 0, audioBitrate: 0 });
    if (!routeDisableSend.ok) {
      failure = { stage: 'send-route-disable', state: routeDisableSend };
      return;
    }
    const routeDisableVideoInfo = await waitForRequestedVideoInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      0,
      false,
      probeMessageCount
    );
    if (!routeDisableVideoInfo.ok) {
      failure = routeDisableVideoInfo;
      return;
    }
    const routeDisableAudioInfo = await waitForRequestedAudioInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      0,
      probeMessageCount
    );
    if (!routeDisableAudioInfo.ok) {
      failure = routeDisableAudioInfo;
      return;
    }
    console.log(`[CONTROL] VDO bitrate/audioBitrate zero route disable info PASS (${JSON.stringify(routeDisableVideoInfo.state.success.message.info)})`);

    probeMessageCount = await getProbeMessageCount(page);
    const routeRestoreSend = await sendControlMessage(page, { bitrate: rateLimitVideoKbps, audioBitrate: rateLimitAudioKbps });
    if (!routeRestoreSend.ok) {
      failure = { stage: 'send-route-restore', state: routeRestoreSend };
      return;
    }
    const routeRestoreInfo = await waitForRateLimitInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      rateLimitVideoKbps,
      rateLimitAudioKbps,
      probeMessageCount
    );
    if (!routeRestoreInfo.ok) {
      failure = routeRestoreInfo;
      return;
    }
    console.log(`[CONTROL] VDO bitrate/audioBitrate route restore info PASS (${JSON.stringify(routeRestoreInfo.state.success.message.info)})`);

    let requestAsMismatchBitrate = config.bitrateKbps + 2222;
    if (requestAsMismatchBitrate === config.publisherDefaultBitrateKbps) {
      requestAsMismatchBitrate += 333;
    }
    probeMessageCount = await getProbeMessageCount(page);
    const requestAsMismatchSend = await sendControlMessage(page, {
      UUID: 'control-e2e-requester',
      requestAs: `${config.streamId}-not-native`,
      targetBitrate: requestAsMismatchBitrate,
      keyframe: true,
      remote: config.remoteToken
    });
    if (!requestAsMismatchSend.ok) {
      failure = { stage: 'send-request-as-mismatch', state: requestAsMismatchSend };
      return;
    }
    const requestAsMismatchInfo = await waitForNoControlInfoBitrate(
      page,
      Math.max(2500, Math.floor(config.timeoutMs / 8)),
      requestAsMismatchBitrate,
      probeMessageCount
    );
    if (!requestAsMismatchInfo.ok) {
      failure = requestAsMismatchInfo;
      return;
    }
    console.log('[CONTROL] VDO requestAs mismatch guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const targetRestoreSend = await sendControlMessage(page, {
      UUID: 'control-e2e-requester',
      requestAs: config.streamId,
      targetBitrate: config.bitrateKbps,
      keyframe: true,
      remote: config.remoteToken
    });
    if (!targetRestoreSend.ok) {
      failure = { stage: 'send-request-as-target-video-restore', state: targetRestoreSend };
      return;
    }
    const targetRestoreInfo = await waitForRequestedVideoInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      config.bitrateKbps,
      false,
      probeMessageCount
    );
    if (!targetRestoreInfo.ok) {
      failure = targetRestoreInfo;
      return;
    }
    console.log(`[CONTROL] VDO requestAs targetBitrate restore info PASS (${JSON.stringify(targetRestoreInfo.state.success.message.info)})`);

    probeMessageCount = await getProbeMessageCount(page);
    const targetUnlockSend = await sendControlMessage(page, { targetBitrate: false, keyframe: true });
    if (!targetUnlockSend.ok) {
      failure = { stage: 'send-target-video-unlock', state: targetUnlockSend };
      return;
    }
    const targetUnlockRouteInfo = await waitForRequestedVideoInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      -1,
      false,
      probeMessageCount
    );
    if (!targetUnlockRouteInfo.ok) {
      failure = targetUnlockRouteInfo;
      return;
    }
    const targetUnlockInfo = await waitForControlInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      config.publisherDefaultBitrateKbps,
      requestedResolution,
      probeMessageCount
    );
    if (!targetUnlockInfo.ok) {
      failure = targetUnlockInfo;
      return;
    }
    console.log(`[CONTROL] VDO targetBitrate unlock info PASS (${JSON.stringify(targetUnlockInfo.state.success.message.info)})`);

    probeMessageCount = await getProbeMessageCount(page);
    const targetAudioUnlockSend = await sendControlMessage(page, { targetAudioBitrate: false });
    if (!targetAudioUnlockSend.ok) {
      failure = { stage: 'send-target-audio-unlock', state: targetAudioUnlockSend };
      return;
    }
    const targetAudioUnlockInfo = await waitForRequestedAudioInfo(
      page,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      -1,
      probeMessageCount
    );
    if (!targetAudioUnlockInfo.ok) {
      failure = targetAudioUnlockInfo;
      return;
    }
    console.log(`[CONTROL] VDO targetAudioBitrate unlock info PASS (${JSON.stringify(targetAudioUnlockInfo.state.success.message.info)})`);

    probeMessageCount = await getProbeMessageCount(page);
    const unauthorizedRemoteVideoMuteSend = await sendControlMessage(page, { remoteVideoMuted: true });
    if (!unauthorizedRemoteVideoMuteSend.ok) {
      failure = { stage: 'send-unauthorized-remote-video-muted', state: unauthorizedRemoteVideoMuteSend };
      return;
    }
    const unauthorizedRemoteVideoMuteRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'remoteVideoMuted',
      probeMessageCount
    );
    if (!unauthorizedRemoteVideoMuteRejected.ok) {
      failure = unauthorizedRemoteVideoMuteRejected;
      return;
    }
    console.log('[CONTROL] VDO remoteVideoMuted unauthorized guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const remoteVideoMuteSend = await sendControlMessage(page, {
      remoteVideoMuted: true,
      remote: config.remoteToken
    });
    if (!remoteVideoMuteSend.ok) {
      failure = { stage: 'send-remote-video-muted', state: remoteVideoMuteSend };
      return;
    }
    const remoteVideoMuteRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'remoteVideoMuted',
      probeMessageCount
    );
    if (!remoteVideoMuteRejected.ok) {
      failure = remoteVideoMuteRejected;
      return;
    }
    console.log('[CONTROL] VDO remoteVideoMuted remote-token guard PASS');

    const statsSend = await sendControlMessage(page, { requestStatsContinuous: true });
    if (!statsSend.ok) {
      failure = { stage: 'send-continuous-stats', state: statsSend };
      return;
    }
    const remoteStats = await waitForRemoteStats(page, Math.max(5000, Math.floor(config.timeoutMs / 3)));
    if (!remoteStats.ok) {
      failure = remoteStats;
      return;
    }
    console.log('[CONTROL] VDO requestStatsContinuous remoteStats PASS');
    await sendControlMessage(page, { requestStatsContinuous: false });

    probeMessageCount = await getProbeMessageCount(page);
    const unauthorizedRefreshConnectionSend = await sendControlMessage(page, { refreshConnection: true });
    if (!unauthorizedRefreshConnectionSend.ok) {
      failure = { stage: 'send-unauthorized-refresh-connection', state: unauthorizedRefreshConnectionSend };
      return;
    }
    const unauthorizedRefreshConnectionRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'refreshConnection',
      probeMessageCount
    );
    if (!unauthorizedRefreshConnectionRejected.ok) {
      failure = unauthorizedRefreshConnectionRejected;
      return;
    }
    console.log('[CONTROL] VDO refreshConnection unauthorized guard PASS');

    probeMessageCount = await getProbeMessageCount(page);
    const unauthorizedRefreshAllSend = await sendControlMessage(page, { refreshAll: true });
    if (!unauthorizedRefreshAllSend.ok) {
      failure = { stage: 'send-unauthorized-refresh-all', state: unauthorizedRefreshAllSend };
      return;
    }
    const unauthorizedRefreshAllRejected = await waitForProbeMessageField(
      page,
      Math.max(3000, Math.floor(config.timeoutMs / 5)),
      'rejected',
      'refreshAll',
      probeMessageCount
    );
    if (!unauthorizedRefreshAllRejected.ok) {
      failure = unauthorizedRefreshAllRejected;
      return;
    }
    console.log('[CONTROL] VDO refreshAll unauthorized guard PASS');

    const beforeRefreshConnectionText = publisher.stdout.join('');
    const refreshConnectionSend = await sendControlMessage(page, {
      refreshConnection: true,
      remote: config.remoteToken
    });
    if (!refreshConnectionSend.ok) {
      failure = { stage: 'send-refresh-connection', state: refreshConnectionSend };
      return;
    }
    console.log('[CONTROL] VDO refreshConnection sent');

    await wait(config.holdMs);
    result = await waitForDecodedVideo(page, config.timeoutMs, 'post-control-video');
    if (!result.ok) {
      failure = result;
      return;
    }
    console.log('[CONTROL] Post-control decode PASS');

    const stdoutText = publisher.stdout.join('');
    if (stdoutText.includes(`[App] Applying runtime bitrate update: ${requestAsMismatchBitrate} kbps`)) {
      failure = { stage: 'publisher-request-as-mismatch-log', state: { requestAsMismatchBitrate } };
      return;
    }
    console.log('[CONTROL] Publisher requestAs mismatch did not reconfigure bitrate');
    const bitrateApplied =
      stdoutText.includes(`[App] Applying runtime bitrate update: ${config.bitrateKbps} kbps`) ||
      stdoutText.includes(`[App] Applying runtime video reconfigure`);
    if (bitrateApplied) {
      console.log('[CONTROL] Publisher runtime control log observed');
    } else {
      console.log('[CONTROL] Publisher runtime control log not observed; using info-based validation');
    }
    if (!stdoutText.includes(`[App] Applying runtime audio bitrate update: ${config.targetAudioBitrateKbps} kbps`)) {
      failure = { stage: 'publisher-audio-target-log', state: { targetAudioBitrateKbps: config.targetAudioBitrateKbps } };
      return;
    }
    console.log('[CONTROL] Publisher runtime audio target log observed');
    if (!stdoutText.includes(`[App] Applying runtime audio bitrate update: ${config.publisherDefaultAudioBitrateKbps} kbps`)) {
      failure = { stage: 'publisher-audio-target-unlock-log', state: { publisherDefaultAudioBitrateKbps: config.publisherDefaultAudioBitrateKbps } };
      return;
    }
    console.log('[CONTROL] Publisher runtime audio target unlock log observed');
    if (!stdoutText.includes(`[App] Applying runtime bitrate update: ${config.publisherDefaultBitrateKbps} kbps`)) {
      failure = { stage: 'publisher-video-target-unlock-log', state: { publisherDefaultBitrateKbps: config.publisherDefaultBitrateKbps } };
      return;
    }
    console.log('[CONTROL] Publisher runtime video target unlock log observed');
    const refreshConnectionResult = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('reason=refresh-connection rebuildPeerConnection=true', beforeRefreshConnectionText.length) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-refresh-connection-log'
    );
    if (!refreshConnectionResult.ok) {
      failure = refreshConnectionResult;
      return;
    }
    console.log('[CONTROL] Publisher refreshConnection offer log observed');
    const refreshConnectionText = publisher.stdout.join('');
    const refreshOfferIndex =
      refreshConnectionText.indexOf('reason=refresh-connection rebuildPeerConnection=true', beforeRefreshConnectionText.length);
    if (refreshOfferIndex < 0) {
      failure = { stage: 'publisher-refresh-connection-rebuild-log', state: {} };
      return;
    }
    const refreshAnswer = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('[App] Applying peer answer', refreshOfferIndex) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-refresh-connection-answer-log'
    );
    if (!refreshAnswer.ok) {
      failure = refreshAnswer;
      return;
    }
    console.log('[CONTROL] Publisher refreshConnection answer log observed');
    console.log('[CONTROL] Publisher refreshConnection rebuild log observed');
    const refreshFanoutText = publisher.stdout.join('');
    if (refreshFanoutText.indexOf('Control recovery refresh-connection', beforeRefreshConnectionText.length) < 0 ||
        refreshFanoutText.indexOf('rebuilding 1 peer connection(s)', beforeRefreshConnectionText.length) < 0) {
      failure = { stage: 'publisher-refresh-connection-fanout-log', state: {} };
      return;
    }
    console.log('[CONTROL] Publisher refreshConnection fan-out log observed');
    const bootstrapOfferIndex = stdoutText.indexOf('reason=bootstrap');
    const bootstrapIceUfrag = offerIceUfragAfter(stdoutText, bootstrapOfferIndex);
    const refreshIceUfrag = offerIceUfragAfter(refreshFanoutText, refreshOfferIndex);
    if (!bootstrapIceUfrag || !refreshIceUfrag || bootstrapIceUfrag === refreshIceUfrag) {
      failure = {
        stage: 'publisher-refresh-connection-ice-ufrag-change',
        state: { bootstrapIceUfrag, refreshIceUfrag }
      };
      return;
    }
    console.log('[CONTROL] Publisher refreshConnection ICE credentials changed');

    const beforeDataChannelIceText = publisher.stdout.join('');
    const dataChannelIceRestartSend = await sendControlMessageWithRetry(
      page,
      { iceRestartRequest: true },
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    );
    if (!dataChannelIceRestartSend.ok) {
      failure = { stage: 'send-datachannel-ice-restart', state: dataChannelIceRestartSend };
      return;
    }
    const dataChannelIceOffer = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('reason=datachannel-ice-restart rebuildPeerConnection=true', beforeDataChannelIceText.length) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-datachannel-ice-restart-offer-log'
    );
    if (!dataChannelIceOffer.ok) {
      failure = dataChannelIceOffer;
      return;
    }
    console.log('[CONTROL] Publisher data-channel iceRestartRequest offer log observed');
    const dataChannelIceText = publisher.stdout.join('');
    const dataChannelIceOfferIndex =
      dataChannelIceText.indexOf('reason=datachannel-ice-restart rebuildPeerConnection=true', beforeDataChannelIceText.length);
    if (dataChannelIceOfferIndex < 0) {
      failure = { stage: 'publisher-datachannel-ice-rebuild-log', state: {} };
      return;
    }
    console.log('[CONTROL] Publisher data-channel iceRestartRequest rebuild log observed');
    const dataChannelIceAnswer = await waitForPublisherStdout(
      publisher,
      (text) => dataChannelIceOfferIndex >= 0 && text.indexOf('[App] Applying peer answer', dataChannelIceOfferIndex) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-datachannel-ice-restart-answer-log'
    );
    if (!dataChannelIceAnswer.ok) {
      failure = dataChannelIceAnswer;
      return;
    }
    console.log('[CONTROL] Publisher data-channel iceRestartRequest answer log observed');

    const beforeSignalingIceText = publisher.stdout.join('');
    const signalingIceRestartSend = await sendSignalingMessage(page, { iceRestartRequest: true });
    if (!signalingIceRestartSend.ok) {
      failure = { stage: 'send-signaling-ice-restart', state: signalingIceRestartSend };
      return;
    }
    const signalingIceOffer = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('reason=signaling-ice-restart rebuildPeerConnection=true', beforeSignalingIceText.length) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-signaling-ice-restart-offer-log'
    );
    if (!signalingIceOffer.ok) {
      failure = signalingIceOffer;
      return;
    }
    console.log(`[CONTROL] Publisher signaling iceRestartRequest offer log observed via ${signalingIceRestartSend.route}`);
    const signalingIceText = publisher.stdout.join('');
    const signalingIceOfferIndex =
      signalingIceText.indexOf('reason=signaling-ice-restart rebuildPeerConnection=true', beforeSignalingIceText.length);
    if (signalingIceOfferIndex < 0) {
      failure = { stage: 'publisher-signaling-ice-rebuild-log', state: {} };
      return;
    }
    console.log('[CONTROL] Publisher signaling iceRestartRequest rebuild log observed');
    const signalingIceAnswer = await waitForPublisherStdout(
      publisher,
      (text) => signalingIceOfferIndex >= 0 && text.indexOf('[App] Applying peer answer', signalingIceOfferIndex) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-signaling-ice-restart-answer-log'
    );
    if (!signalingIceAnswer.ok) {
      failure = signalingIceAnswer;
      return;
    }
    console.log('[CONTROL] Publisher signaling iceRestartRequest answer log observed');

    const cleanupPage = await context.newPage();
    await cleanupPage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const cleanupPeerState = await waitForSessionPeer(cleanupPage, Math.max(10000, config.timeoutMs / 2));
    if (!cleanupPeerState || !cleanupPeerState.ready) {
      failure = { stage: 'cleanup-session-peer', state: cleanupPeerState };
      return;
    }
    const cleanupVideo = await waitForDecodedVideo(cleanupPage, Math.max(10000, Math.floor(config.timeoutMs / 2)), 'cleanup-video');
    if (!cleanupVideo.ok) {
      failure = cleanupVideo;
      return;
    }

    const beforePeerByeText = publisher.stdout.join('');
    const byeSend = await sendControlMessage(cleanupPage, { bye: true });
    if (!byeSend.ok) {
      failure = { stage: 'send-peer-bye', state: byeSend };
      return;
    }
    const peerBye = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('reason=peer-bye', beforePeerByeText.length) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-peer-bye-log'
    );
    if (!peerBye.ok) {
      failure = peerBye;
      return;
    }
    console.log('[CONTROL] Publisher peer bye cleanup log observed');
    await cleanupPage.close().catch(() => {});

    const requestCleanupPage = await context.newPage();
    await requestCleanupPage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const requestCleanupPeerState = await waitForSessionPeer(requestCleanupPage, Math.max(10000, config.timeoutMs / 2));
    if (!requestCleanupPeerState || !requestCleanupPeerState.ready) {
      failure = { stage: 'request-cleanup-session-peer', state: requestCleanupPeerState };
      return;
    }
    const requestCleanupVideo = await waitForDecodedVideo(
      requestCleanupPage,
      Math.max(10000, Math.floor(config.timeoutMs / 2)),
      'request-cleanup-video'
    );
    if (!requestCleanupVideo.ok) {
      failure = requestCleanupVideo;
      return;
    }

    const beforePeerCleanupText = publisher.stdout.join('');
    const cleanupSend = await sendControlMessage(requestCleanupPage, { request: 'cleanup' });
    if (!cleanupSend.ok) {
      failure = { stage: 'send-peer-request-cleanup', state: cleanupSend };
      return;
    }
    const peerCleanup = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('reason=peer-cleanup', beforePeerCleanupText.length) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-peer-request-cleanup-log'
    );
    if (!peerCleanup.ok) {
      failure = peerCleanup;
      return;
    }
    console.log('[CONTROL] Publisher peer request cleanup log observed');
    await requestCleanupPage.close().catch(() => {});

    const beforeSignalingByeText = publisher.stdout.join('');
    const signalingByeSend = await sendSignalingMessage(page, { bye: true });
    if (!signalingByeSend.ok) {
      failure = { stage: 'send-signaling-bye', state: signalingByeSend };
      return;
    }
    const signalingBye = await waitForPublisherStdout(
      publisher,
      (text) => text.indexOf('reason=signaling-cleanup', beforeSignalingByeText.length) >= 0,
      Math.max(5000, Math.floor(config.timeoutMs / 3)),
      'publisher-signaling-bye-log'
    );
    if (!signalingBye.ok) {
      failure = signalingBye;
      return;
    }
    console.log(`[CONTROL] Publisher signaling bye cleanup log observed via ${signalingByeSend.route}`);

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

