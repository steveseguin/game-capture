#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAudioSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['default-output', 'output', 'system', 'system-output'].includes(normalized)) {
    return 'default-output';
  }
  if (['communications-output', 'communication-output', 'communications', 'voip'].includes(normalized)) {
    return 'communications-output';
  }
  if (['default-microphone', 'microphone', 'mic', 'input', 'default-input'].includes(normalized)) {
    return 'default-microphone';
  }
  if (['none', 'off', 'disabled'].includes(normalized)) {
    return 'none';
  }
  return 'selected-window';
}

function parseArgs(argv) {
  const stamp = Date.now();
  const args = {
    baseUrl: 'https://vdo.ninja/',
    streamId: `director_pub_${stamp}`,
    room: `director_room_${stamp}`,
    password: `director-pass-${stamp}`,
    label: 'director-room-e2e',
    server: 'wss://wss.vdo.ninja:443',
    salt: 'vdo.ninja',
    audioSource: 'selected-window',
    includeMicrophone: false,
    microphoneDeviceId: '',
    startupDelayMs: 7000,
    timeoutMs: 90000,
    disconnectTimeoutMs: 45000,
    holdMs: 3000,
    publisherDurationMs: 0,
    stopLifecycleOnly: false,
    verifyNaturalStop: false,
    previewBitrateKbps: 500,
    previewAudioBitrateKbps: 16,
    qualityHighBitrateKbps: 1200,
    audioRateLimitKbps: 32,
    targetBitrateKbps: 3500,
    requestWidth: 960,
    requestHeight: 540,
    publisherPath: '',
    screenshotDir: path.resolve(__dirname, '../../.playwright-mcp'),
    reportDir: path.resolve(__dirname, '../e2e/reports'),
    headful: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--base-url=')) {
      args.baseUrl = arg.slice('--base-url='.length);
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
    } else if (arg.startsWith('--audio-source=')) {
      args.audioSource = normalizeAudioSource(arg.slice('--audio-source='.length) || args.audioSource);
    } else if (arg === '--include-microphone' || arg === '--include-mic') {
      args.includeMicrophone = true;
    } else if (arg.startsWith('--microphone-device=')) {
      args.microphoneDeviceId = arg.slice('--microphone-device='.length);
      args.includeMicrophone = true;
    } else if (arg.startsWith('--mic-device=')) {
      args.microphoneDeviceId = arg.slice('--mic-device='.length);
      args.includeMicrophone = true;
    } else if (arg.startsWith('--startup-delay-ms=')) {
      args.startupDelayMs = Number(arg.slice('--startup-delay-ms='.length)) || args.startupDelayMs;
    } else if (arg.startsWith('--timeout-ms=')) {
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs;
    } else if (arg.startsWith('--disconnect-timeout-ms=')) {
      args.disconnectTimeoutMs = Number(arg.slice('--disconnect-timeout-ms='.length)) || args.disconnectTimeoutMs;
    } else if (arg.startsWith('--hold-ms=')) {
      args.holdMs = Number(arg.slice('--hold-ms='.length)) || args.holdMs;
    } else if (arg.startsWith('--publisher-duration-ms=')) {
      args.publisherDurationMs = Number(arg.slice('--publisher-duration-ms='.length)) || args.publisherDurationMs;
    } else if (arg.startsWith('--preview-bitrate-kbps=')) {
      args.previewBitrateKbps = Number(arg.slice('--preview-bitrate-kbps='.length)) || args.previewBitrateKbps;
    } else if (arg.startsWith('--preview-audio-bitrate-kbps=')) {
      args.previewAudioBitrateKbps = Number(arg.slice('--preview-audio-bitrate-kbps='.length)) || args.previewAudioBitrateKbps;
    } else if (arg.startsWith('--quality-high-bitrate-kbps=')) {
      args.qualityHighBitrateKbps = Number(arg.slice('--quality-high-bitrate-kbps='.length)) || args.qualityHighBitrateKbps;
    } else if (arg.startsWith('--audio-rate-limit-kbps=')) {
      args.audioRateLimitKbps = Number(arg.slice('--audio-rate-limit-kbps='.length)) || args.audioRateLimitKbps;
    } else if (arg.startsWith('--target-bitrate-kbps=')) {
      args.targetBitrateKbps = Number(arg.slice('--target-bitrate-kbps='.length)) || args.targetBitrateKbps;
    } else if (arg.startsWith('--request-resolution=')) {
      const match = /^(\d+)x(\d+)$/i.exec(arg.slice('--request-resolution='.length).trim());
      if (match) {
        args.requestWidth = Number(match[1]);
        args.requestHeight = Number(match[2]);
      }
    } else if (arg.startsWith('--publisher-path=')) {
      args.publisherPath = arg.slice('--publisher-path='.length);
    } else if (arg.startsWith('--screenshot-dir=')) {
      args.screenshotDir = path.resolve(arg.slice('--screenshot-dir='.length));
    } else if (arg.startsWith('--report-dir=')) {
      args.reportDir = path.resolve(arg.slice('--report-dir='.length));
    } else if (arg === '--headful') {
      args.headful = true;
    } else if (arg === '--stop-lifecycle-only') {
      args.stopLifecycleOnly = true;
      args.verifyNaturalStop = true;
    } else if (arg === '--verify-natural-stop') {
      args.verifyNaturalStop = true;
    }
  }

  if (!args.baseUrl.endsWith('/')) {
    args.baseUrl += '/';
  }
  args.audioSource = normalizeAudioSource(args.audioSource);
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
    path.resolve(__dirname, '../build/bin/Release/game-capture.exe')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function buildDirectorUrl(config) {
  const query = new URLSearchParams();
  query.set('director', config.room);
  query.set('password', config.password);
  query.set('cleandirector', '');
  query.set('autostart', '');
  return `${config.baseUrl}?${query.toString()}`;
}

function spawnPublisher(config) {
  const command = detectPublisherBinary(config.publisherPath);
  if (!command) {
    throw new Error('Could not find game-capture.exe. Build Release first or pass --publisher-path.');
  }

  const durationMs = config.publisherDurationMs > 0
    ? config.publisherDurationMs
    : Math.max(180000, config.startupDelayMs + config.timeoutMs + config.holdMs + 30000);
  const args = [
    '--headless',
    `--stream=${config.streamId}`,
    `--room=${config.room}`,
    `--password=${config.password}`,
    `--label=${config.label}`,
    `--server=${config.server}`,
    `--salt=${config.salt}`,
    `--duration-ms=${durationMs}`,
    `--audio-source=${config.audioSource}`,
    '--remote-control',
    '--remote-token=control-token'
  ];
  if (config.includeMicrophone) {
    args.push('--include-microphone');
  }
  if (config.microphoneDeviceId) {
    args.push(`--microphone-device=${config.microphoneDeviceId}`);
  }

  const env = { ...process.env };
  const qtPluginPath = detectQtPluginPath();
  if (qtPluginPath) {
    env.QT_PLUGIN_PATH = qtPluginPath;
  }
  env.QT_QPA_PLATFORM = env.QT_QPA_PLATFORM || 'offscreen';

  const child = spawn(command, args, {
    cwd: path.dirname(command),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk.toString(); });
  child.command = command;
  child.args = args;
  return child;
}

async function collectDirectorState(page, streamId) {
  return page.evaluate((expectedStreamId) => {
    const sessionObj = window.session || {};
    const rpcIds = Object.keys(sessionObj.rpcs || {});
    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      id: video.id,
      sid: video.dataset.sid || '',
      uuid: video.dataset.UUID || '',
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      paused: video.paused,
      ended: video.ended
    }));
    const decodedVideo = videos.find((video) =>
      video.sid === expectedStreamId &&
      video.readyState >= 2 &&
      video.width > 0 &&
      video.height > 0 &&
      video.currentTime > 0 &&
      !video.ended
    ) || null;
    const rpcs = {};
    for (const uuid of rpcIds) {
      const rpc = sessionObj.rpcs[uuid];
      rpcs[uuid] = {
        streamID: rpc && rpc.streamID,
        statsInfo: rpc && rpc.stats && rpc.stats.info ? rpc.stats.info : null,
        allowGraphs: rpc ? rpc.allowGraphs : null,
        videoElement: !!(rpc && rpc.videoElement)
      };
    }
    return {
      href: location.href,
      director: sessionObj.director,
      roomid: sessionObj.roomid,
      rpcIds,
      videos,
      decodedVideo,
      rpcs,
      bodyText: document.body ? document.body.innerText.slice(0, 800) : ''
    };
  }, streamId);
}

async function waitForDirectorPeer(page, config) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < config.timeoutMs) {
    last = await collectDirectorState(page, config.streamId);
    const uuid = last.rpcIds.find((id) => last.rpcs[id] && last.rpcs[id].streamID === config.streamId);
    if (last.director === true && uuid) {
      return { ok: true, uuid, state: last };
    }
    await wait(500);
  }
  return { ok: false, stage: 'director-peer', state: last };
}

async function waitForDecodedDirectorVideo(page, config) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < config.timeoutMs) {
    last = await collectDirectorState(page, config.streamId);
    if (last.decodedVideo) {
      return { ok: true, state: last };
    }
    await wait(1000);
  }
  return { ok: false, stage: 'director-decoded-video', state: last };
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      ok: child.exitCode === 0,
      exitCode: child.exitCode,
      signalCode: child.signalCode
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        reason: 'timeout',
        exitCode: child.exitCode,
        signalCode: child.signalCode
      });
    }, timeoutMs);

    const onExit = (code, signal) => {
      cleanup();
      resolve({
        ok: code === 0,
        exitCode: code,
        signalCode: signal
      });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };

    child.on('exit', onExit);
  });
}

async function collectDirectorDisconnectState(page, uuid, streamId) {
  return page.evaluate(({ peerUuid, expectedStreamId }) => {
    const sessionObj = window.session || {};
    const rpc = sessionObj.rpcs && sessionObj.rpcs[peerUuid] ? sessionObj.rpcs[peerUuid] : null;
    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      id: video.id,
      sid: video.dataset.sid || '',
      uuid: video.dataset.UUID || '',
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      paused: video.paused,
      ended: video.ended
    }));
    const streamVideo = videos.find((video) =>
      video.sid === expectedStreamId || video.uuid === peerUuid || video.id === `videosource_${peerUuid}`
    ) || null;
    const decoded = streamVideo &&
      streamVideo.readyState >= 2 &&
      streamVideo.width > 0 &&
      streamVideo.height > 0 &&
      !streamVideo.ended;
    const container = document.getElementById(`container_${peerUuid}`);
    return {
      rpcExists: !!rpc,
      connectionState: rpc ? rpc.connectionState || '' : '',
      iceConnectionState: rpc ? rpc.iceConnectionState || '' : '',
      signalingState: rpc ? rpc.signalingState || '' : '',
      containerExists: !!container,
      streamVideo,
      decoded,
      videos
    };
  }, { peerUuid: uuid, expectedStreamId: streamId });
}

async function waitForDirectorPublisherStopped(page, uuid, config) {
  const start = Date.now();
  let last = null;
  let stillSince = 0;
  let previousVideoTime = null;

  while (Date.now() - start < config.disconnectTimeoutMs) {
    last = await collectDirectorDisconnectState(page, uuid, config.streamId);
    const state = String(last.connectionState || '').toLowerCase();
    const iceState = String(last.iceConnectionState || '').toLowerCase();
    const videoTime = last.streamVideo ? Number(last.streamVideo.currentTime || 0) : null;
    const videoAdvancing = previousVideoTime !== null &&
      videoTime !== null &&
      videoTime > previousVideoTime + 0.05;
    previousVideoTime = videoTime;

    if (!last.rpcExists && !last.streamVideo && !last.containerExists) {
      return { ok: true, state: last };
    }

    const peerNotConnected =
      !last.rpcExists ||
      ['closed', 'failed', 'disconnected'].includes(state) ||
      ['closed', 'failed', 'disconnected'].includes(iceState);

    if (peerNotConnected && !videoAdvancing) {
      if (stillSince === 0) {
        stillSince = Date.now();
      }
      if (Date.now() - stillSince >= 2500) {
        return { ok: true, state: last };
      }
    } else {
      stillSince = 0;
    }

    await wait(500);
  }
  return { ok: false, stage: 'director-publisher-stopped', state: last };
}

async function installMessageProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc', uuid: peerUuid };
    }

    const rpc = sessionObj.rpcs[peerUuid];
    const probe = window.__directorRoomE2EProbe || { messages: [] };
    if (!Array.isArray(probe.messages)) {
      probe.messages = [];
    }
    window.__directorRoomE2EProbe = probe;

    const parseMessage = (event, channelName) => {
      if (!event || typeof event.data !== 'string') {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        probe.messages.push({ ts: Date.now(), channel: channelName, message: parsed });
        if (probe.messages.length > 200) {
          probe.messages.shift();
        }
      } catch {
        // Ignore non-JSON VDO messages.
      }
    };

    const attach = (channel, channelName) => {
      if (!channel) {
        return false;
      }
      if (channel.__directorRoomE2EProbeAttached) {
        return true;
      }
      channel.__directorRoomE2EProbeAttached = true;
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

async function waitForProbeMessage(page, predicateSource, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((source) => {
      const predicate = new Function('entry', `return (${source})(entry);`);
      const probe = window.__directorRoomE2EProbe || { messages: [] };
      const messages = Array.isArray(probe.messages) ? probe.messages : [];
      const match = messages.find((entry) => {
        try {
          return predicate(entry);
        } catch {
          return false;
        }
      }) || null;
      return {
        count: messages.length,
        latest: messages.length ? messages[messages.length - 1] : null,
        match
      };
    }, predicateSource);
    if (last && last.match) {
      return { ok: true, state: last };
    }
    await wait(250);
  }
  return { ok: false, stage: 'probe-message', state: last };
}

async function waitForStatsInfo(page, uuid, predicateSource, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(({ peerUuid, source }) => {
      const predicate = new Function('info', `return (${source})(info);`);
      const rpc = window.session && window.session.rpcs ? window.session.rpcs[peerUuid] : null;
      const info = rpc && rpc.stats && rpc.stats.info ? rpc.stats.info : null;
      let ok = false;
      if (info) {
        try {
          ok = !!predicate(info);
        } catch {
          ok = false;
        }
      }
      return { ok, info };
    }, { peerUuid: uuid, source: predicateSource });
    if (last && last.ok) {
      return { ok: true, state: last };
    }
    await wait(500);
  }
  return { ok: false, stage: 'stats-info', state: last };
}

async function sendDirectorRequest(page, uuid, payload) {
  return page.evaluate(({ peerUuid, message }) => {
    if (!window.session || typeof window.session.sendRequest !== 'function') {
      return { ok: false, reason: 'no_sendRequest' };
    }
    const sent = window.session.sendRequest(message, peerUuid);
    return { ok: sent !== false, sent, payload: message };
  }, {
    peerUuid: uuid,
    message: payload
  });
}

async function clickDirectorQualityButton(page, uuid, actionType) {
  return page.evaluate(({ peerUuid, action }) => {
    const container = document.getElementById(`container_${peerUuid}`);
    if (!container) {
      return { ok: false, reason: 'no_container' };
    }
    const button = container.querySelector(`[data-action-type="${action}"]`);
    if (!button) {
      return { ok: false, reason: 'no_quality_button', action };
    }
    button.click();
    return {
      ok: true,
      action,
      pressed: button.classList.contains('pressed'),
      ariaPressed: button.ariaPressed || ''
    };
  }, { peerUuid: uuid, action: actionType });
}

async function applyVdoPreviewRate(page, uuid, config) {
  return page.evaluate(({ peerUuid, bitrate }) => {
    if (!window.session || typeof window.session.requestRateLimit !== 'function') {
      return { ok: false, reason: 'no_requestRateLimit' };
    }
    window.session.requestRateLimit(bitrate, peerUuid, true, false);
    return { ok: true };
  }, {
    peerUuid: uuid,
    bitrate: config.previewBitrateKbps
  });
}

async function requestVdoAudioRate(page, uuid, bitrateKbps) {
  return page.evaluate(({ peerUuid, bitrate }) => {
    if (!window.session || typeof window.session.requestAudioRateLimit !== 'function') {
      return { ok: false, reason: 'no_requestAudioRateLimit' };
    }
    const sent = window.session.requestAudioRateLimit(bitrate, peerUuid, false);
    return { ok: sent !== false, sent };
  }, {
    peerUuid: uuid,
    bitrate: bitrateKbps
  });
}

async function requestVdoResolution(page, uuid, config) {
  return page.evaluate(({ peerUuid, width, height }) => {
    if (!window.session || typeof window.session.requestResolution !== 'function') {
      return { ok: false, reason: 'no_requestResolution' };
    }
    window.session.requestResolution(peerUuid, width, height);
    return { ok: true };
  }, {
    peerUuid: uuid,
    width: config.requestWidth,
    height: config.requestHeight
  });
}

async function requestVdoKeyframe(page, uuid) {
  return page.evaluate((peerUuid) => {
    if (window.session && typeof window.session.requestKeyframe === 'function') {
      window.session.requestKeyframe(peerUuid);
      return { ok: true, method: 'requestKeyframe' };
    }
    if (window.session && typeof window.session.sendRequest === 'function') {
      const sent = window.session.sendRequest({ keyframe: true }, peerUuid);
      return { ok: sent !== false, method: 'sendRequest', sent };
    }
    return { ok: false, reason: 'no_keyframe_request' };
  }, uuid);
}

async function clickSceneStatsButton(page, uuid) {
  return page.evaluate((peerUuid) => {
    const container = document.getElementById(`container_${peerUuid}`);
    if (!container) {
      return { ok: false, reason: 'no_container' };
    }
    const button = container.querySelector('[data-action-type="stats-remote"]');
    if (!button) {
      return { ok: false, reason: 'no_stats_button' };
    }
    button.click();
    return { ok: true };
  }, uuid);
}

async function waitForSceneStatsUi(page, uuid, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate((peerUuid) => {
      const container = document.getElementById(`container_${peerUuid}`);
      if (!container) {
        return { ok: false, reason: 'no_container' };
      }
      const requesting = Array.from(container.querySelectorAll('[data-no-scenes][data-message]'))
        .some((element) => /Requesting data/i.test(element.textContent || '') && !element.classList.contains('hidden'));
      const detailContainers = Array.from(container.querySelectorAll('[data-action-type="stats-graphs-details-container"][data-uid]'));
      const details = detailContainers.map((detail) => ({
        uid: detail.dataset.uid || '',
        hidden: detail.classList.contains('hidden'),
        bitrate: detail.querySelector('[data-bitrate]') ? detail.querySelector('[data-bitrate]').textContent.trim() : '',
        resolution: detail.querySelector('[data-resolution]') ? detail.querySelector('[data-resolution]').textContent.trim() : '',
        encoder: detail.querySelector('[data-video-codec]') ? detail.querySelector('[data-video-codec]').textContent.trim() : ''
      }));
      const populated = details.find((detail) =>
        !detail.hidden &&
        /video bitrate:\s*\d+/i.test(detail.bitrate) &&
        /\d+\s*x\s*\d+/i.test(detail.resolution) &&
        /video codec:/i.test(detail.encoder)
      ) || null;
      return { ok: !!populated && !requesting, requesting, details, populated };
    }, uuid);
    if (last && last.ok) {
      return { ok: true, state: last };
    }
    await wait(500);
  }
  return { ok: false, stage: 'scene-stats-ui', state: last };
}

async function clickStatsBitrateControl(page, uuid, targetBitrateKbps) {
  return page.evaluate(({ peerUuid, bitrate }) => {
    const container = document.getElementById(`container_${peerUuid}`);
    if (!container) {
      return { ok: false, reason: 'no_container' };
    }
    const bitrateSpan = container.querySelector('[data-action-type="stats-graphs-details-container"][data-uid]:not(.hidden) [data-bitrate]');
    if (!bitrateSpan) {
      return { ok: false, reason: 'no_bitrate_span' };
    }
    window.promptAlt = async () => String(bitrate);
    bitrateSpan.click();
    return { ok: true };
  }, { peerUuid: uuid, bitrate: targetBitrateKbps });
}

async function readInboundVideoStats(page, uuid) {
  return page.evaluate(async (peerUuid) => {
    const pc = window.session && window.session.rpcs ? window.session.rpcs[peerUuid] : null;
    if (!pc || typeof pc.getStats !== 'function') {
      return { ok: false, reason: 'no_peer_getStats' };
    }
    const report = await pc.getStats();
    const totals = {
      ok: true,
      framesDecoded: 0,
      keyFramesDecoded: 0,
      bytesReceived: 0,
      packetsReceived: 0,
      stats: []
    };
    report.forEach((stat) => {
      if (stat.type !== 'inbound-rtp') {
        return;
      }
      if (stat.kind !== 'video' && stat.mediaType !== 'video') {
        return;
      }
      const item = {
        id: stat.id,
        framesDecoded: Number(stat.framesDecoded || 0),
        keyFramesDecoded: Number(stat.keyFramesDecoded || 0),
        bytesReceived: Number(stat.bytesReceived || 0),
        packetsReceived: Number(stat.packetsReceived || 0)
      };
      totals.framesDecoded += item.framesDecoded;
      totals.keyFramesDecoded += item.keyFramesDecoded;
      totals.bytesReceived += item.bytesReceived;
      totals.packetsReceived += item.packetsReceived;
      totals.stats.push(item);
    });
    return totals;
  }, uuid);
}

async function waitForInboundVideoStats(page, uuid, predicateSource, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const stats = await readInboundVideoStats(page, uuid);
    last = stats;
    if (stats && stats.ok) {
      const ok = await page.evaluate(({ source, value }) => {
        const predicate = new Function('stats', `return (${source})(stats);`);
        try {
          return !!predicate(value);
        } catch {
          return false;
        }
      }, { source: predicateSource, value: stats });
      if (ok) {
        return { ok: true, state: stats };
      }
    }
    await wait(500);
  }
  return { ok: false, stage: 'inbound-video-stats', state: last };
}

async function run() {
  const config = parseArgs(process.argv);
  const directorUrl = buildDirectorUrl(config);
  const publisher = spawnPublisher(config);
  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    streamId: config.streamId,
    room: config.room,
    audioSource: config.audioSource,
    includeMicrophone: config.includeMicrophone,
    microphoneDeviceId: config.microphoneDeviceId ? '(selected)' : '',
    stopLifecycleOnly: config.stopLifecycleOnly,
    checks: []
  };

  let browser;
  let page;
  let failure = null;

  const check = async (name, fn) => {
    const started = Date.now();
    const result = await fn();
    report.checks.push({
      name,
      ok: !!result.ok,
      durationMs: Date.now() - started,
      state: result.state || result
    });
    if (!result.ok) {
      const error = new Error(`${name} failed`);
      error.result = result;
      throw error;
    }
    console.log(`[DIRECTOR-E2E] ${name} PASS`);
    return result;
  };

  try {
    console.log(`[DIRECTOR-E2E] Base URL: ${config.baseUrl}`);
    console.log(`[DIRECTOR-E2E] Director URL: ${directorUrl}`);
    console.log(`[DIRECTOR-E2E] Publisher: ${publisher.command} ${publisher.args.join(' ')}`);
    await wait(config.startupDelayMs);

    browser = await chromium.launch({
      headless: !config.headful,
      args: ['--autoplay-policy=no-user-gesture-required']
    });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();
    await page.goto(directorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const peer = await check('director-loads-room-publisher', () => waitForDirectorPeer(page, config));
    const uuid = peer.uuid;
    await check('director-decodes-publisher-video', () => waitForDecodedDirectorVideo(page, config));

    const probe = await installMessageProbe(page, uuid);
    if (!probe.ok) {
      throw Object.assign(new Error('install-message-probe failed'), { result: probe });
    }

    await check('director-peer-init-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => info.room_init_received === true && String(info.assigned_role || '').toLowerCase() === 'director'`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    await check('director-audio-source-info', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => String(info.audio_source || '') === '${config.audioSource}'`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    if (config.includeMicrophone) {
      await check('director-additional-microphone-info', () => waitForStatsInfo(
        page,
        uuid,
        `(info) => info.include_microphone === true && String(info.additional_audio_source || '') !== 'none'`,
        Math.max(10000, Math.floor(config.timeoutMs / 3))
      ));
    }

    if (config.stopLifecycleOnly) {
      const publisherExit = await waitForProcessExit(
        publisher,
        Math.max(config.disconnectTimeoutMs, config.publisherDurationMs + 20000)
      );
      report.publisherExit = publisherExit;
      if (!publisherExit.ok) {
        throw Object.assign(new Error('publisher did not exit cleanly'), { result: publisherExit });
      }
      console.log('[DIRECTOR-E2E] publisher-natural-exit PASS');
      await check('director-observes-publisher-stop', () => waitForDirectorPublisherStopped(page, uuid, config));

      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shot = path.join(config.screenshotDir, `director-room-stop-pass-${config.streamId}-${nowStamp()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      report.screenshot = shot;
      report.ok = true;
      console.log(`[DIRECTOR-E2E] PASS screenshot: ${shot}`);
      return;
    }

    const pingToken = `director-ping-${Date.now()}`;
    const pingRequest = await sendDirectorRequest(page, uuid, { ping: pingToken });
    if (!pingRequest.ok) {
      throw Object.assign(new Error('director ping sendRequest failed'), { result: pingRequest });
    }
    await check('director-ping-pong', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.pong === '${pingToken}';
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const oneShotStatsId = `stats-${Date.now()}`;
    const oneShotStatsRequest = await sendDirectorRequest(page, uuid, {
      requestStats: true,
      requestID: oneShotStatsId
    });
    if (!oneShotStatsRequest.ok) {
      throw Object.assign(new Error('one-shot stats sendRequest failed'), { result: oneShotStatsRequest });
    }
    await check('director-one-shot-stats-response', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.requestID === '${oneShotStatsId}' && msg.ok === true &&
          msg.stats &&
          Number(msg.stats.peers) >= 1 &&
          String(msg.stats.codec || '').length > 0;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const continuousStatsRequest = await sendDirectorRequest(page, uuid, { requestStatsContinuous: true });
    if (!continuousStatsRequest.ok) {
      throw Object.assign(new Error('continuous stats sendRequest failed'), { result: continuousStatsRequest });
    }
    await check('director-continuous-remote-stats', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        const stats = msg && msg.remoteStats && msg.remoteStats['${config.streamId}'];
        return stats &&
          /\\d+\\s*x\\s*\\d+/i.test(String(stats.resolution || '')) &&
          String(stats.video_codec || '').length > 0;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await sendDirectorRequest(page, uuid, { requestStatsContinuous: false });

    const qualityOffClick = await clickDirectorQualityButton(page, uuid, 'change-quality1');
    if (!qualityOffClick.ok) {
      throw Object.assign(new Error('quality off button click failed'), { result: qualityOffClick });
    }
    await check('director-quality-off-button-applies', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_video_bitrate_kbps) === 0`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const qualityHighClick = await clickDirectorQualityButton(page, uuid, 'change-quality3');
    if (!qualityHighClick.ok) {
      throw Object.assign(new Error('quality high button click failed'), { result: qualityHighClick });
    }
    await check('director-quality-high-button-restores-video', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_video_bitrate_kbps) === ${config.qualityHighBitrateKbps}`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-quality-button-video-decodes', () => waitForDecodedDirectorVideo(page, config));

    const previewRateRequest = await applyVdoPreviewRate(page, uuid, config);
    if (!previewRateRequest.ok) {
      throw Object.assign(new Error('applyVdoPreviewRate failed'), { result: previewRateRequest });
    }
    await check('vdo-preview-rate-message-applies', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_video_bitrate_kbps) === ${config.previewBitrateKbps} && Number(info.requested_audio_bitrate_kbps) === ${config.previewAudioBitrateKbps}`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const audioRateRequest = await requestVdoAudioRate(page, uuid, config.audioRateLimitKbps);
    if (!audioRateRequest.ok) {
      throw Object.assign(new Error('requestVdoAudioRate failed'), { result: audioRateRequest });
    }
    await check('vdo-audio-rate-message-applies', () => waitForStatsInfo(
      page,
      uuid,
      `(info) => Number(info.requested_audio_bitrate_kbps) === ${config.audioRateLimitKbps}`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await requestVdoAudioRate(page, uuid, config.previewAudioBitrateKbps);

    const resolutionRequest = await requestVdoResolution(page, uuid, config);
    if (!resolutionRequest.ok) {
      throw Object.assign(new Error('requestVdoResolution failed'), { result: resolutionRequest });
    }
    await check('vdo-request-resolution-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.ack === 'control' && msg.ok === true &&
          msg.requestResolution &&
          Number(msg.requestResolution.w) === ${config.requestWidth} &&
          Number(msg.requestResolution.h) === ${config.requestHeight};
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const statsClick = await clickSceneStatsButton(page, uuid);
    if (!statsClick.ok) {
      throw Object.assign(new Error('clickSceneStatsButton failed'), { result: statsClick });
    }
    await check('director-scene-stats-ui-populates', () => waitForSceneStatsUi(
      page,
      uuid,
      Math.max(15000, Math.floor(config.timeoutMs / 2))
    ));

    const statsBitrateClick = await clickStatsBitrateControl(page, uuid, config.targetBitrateKbps);
    if (!statsBitrateClick.ok) {
      throw Object.assign(new Error('clickStatsBitrateControl failed'), { result: statsBitrateClick });
    }
    await check('director-stats-bitrate-control-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.ack === 'control' && msg.ok === true &&
          Number(msg.targetBitrate) === ${config.targetBitrateKbps};
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const directorAudioMuteClick = await clickDirectorQualityButton(page, uuid, 'mute-guest');
    if (!directorAudioMuteClick.ok) {
      throw Object.assign(new Error('director audio mute button click failed'), { result: directorAudioMuteClick });
    }
    await check('director-audio-mute-button-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.muteState === true;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const directorAudioUnmuteClick = await clickDirectorQualityButton(page, uuid, 'mute-guest');
    if (!directorAudioUnmuteClick.ok) {
      throw Object.assign(new Error('director audio unmute button click failed'), { result: directorAudioUnmuteClick });
    }
    await check('director-audio-unmute-button-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.muteState === false;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const directorVideoMuteClick = await clickDirectorQualityButton(page, uuid, 'mute-video-guest');
    if (!directorVideoMuteClick.ok) {
      throw Object.assign(new Error('director video mute button click failed'), { result: directorVideoMuteClick });
    }
    await check('director-video-mute-button-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.videoMuted === true;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const directorVideoUnmuteClick = await clickDirectorQualityButton(page, uuid, 'mute-video-guest');
    if (!directorVideoUnmuteClick.ok) {
      throw Object.assign(new Error('director video unmute button click failed'), { result: directorVideoUnmuteClick });
    }
    await check('director-video-unmute-button-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.videoMuted === false;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-director-video-mute-button-video-decodes', () => waitForDecodedDirectorVideo(page, config));

    const audioOffRequest = await sendDirectorRequest(page, uuid, { audio: false });
    if (!audioOffRequest.ok) {
      throw Object.assign(new Error('audio off sendRequest failed'), { result: audioOffRequest });
    }
    await check('director-audio-off-media-update-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.ack === 'init' && msg.ok === true && msg.audio === false;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const audioOnRequest = await sendDirectorRequest(page, uuid, { audio: true });
    if (!audioOnRequest.ok) {
      throw Object.assign(new Error('audio on sendRequest failed'), { result: audioOnRequest });
    }
    await check('director-audio-on-media-update-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.ack === 'init' && msg.ok === true && msg.audio === true;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));

    const videoOffRequest = await sendDirectorRequest(page, uuid, { video: false });
    if (!videoOffRequest.ok) {
      throw Object.assign(new Error('video off sendRequest failed'), { result: videoOffRequest });
    }
    await check('director-video-off-media-update-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.ack === 'init' && msg.ok === true && msg.video === false;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    const videoOnRequest = await sendDirectorRequest(page, uuid, { video: true });
    if (!videoOnRequest.ok) {
      throw Object.assign(new Error('video on sendRequest failed'), { result: videoOnRequest });
    }
    await check('director-video-on-media-update-acks', () => waitForProbeMessage(
      page,
      `(entry) => {
        const msg = entry && entry.message;
        return msg && msg.ack === 'init' && msg.ok === true && msg.video === true;
      }`,
      Math.max(10000, Math.floor(config.timeoutMs / 3))
    ));
    await check('post-video-toggle-director-video-decodes', () => waitForDecodedDirectorVideo(page, config));

    const beforeKeyframeStats = await readInboundVideoStats(page, uuid);
    const keyframeRequest = await requestVdoKeyframe(page, uuid);
    if (!keyframeRequest.ok) {
      throw Object.assign(new Error('requestVdoKeyframe failed'), { result: keyframeRequest });
    }
    const baselineKeyframes = Number(beforeKeyframeStats.keyFramesDecoded || 0);
    await check('director-keyframe-request-increases-decoded-keyframes', () => waitForInboundVideoStats(
      page,
      uuid,
      `(stats) => Number(stats.keyFramesDecoded || 0) > ${baselineKeyframes}`,
      Math.max(20000, Math.floor(config.timeoutMs / 3))
    ));

    await wait(config.holdMs);
    await check('post-control-director-video-still-decodes', () => waitForDecodedDirectorVideo(page, config));

    fs.mkdirSync(config.screenshotDir, { recursive: true });
    const shot = path.join(config.screenshotDir, `director-room-pass-${config.streamId}-${nowStamp()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    report.screenshot = shot;
    report.ok = true;
    console.log(`[DIRECTOR-E2E] PASS screenshot: ${shot}`);
  } catch (error) {
    failure = error;
    report.ok = false;
    report.failure = {
      message: error && error.message ? error.message : String(error),
      result: error && error.result ? error.result : undefined
    };
    if (page) {
      fs.mkdirSync(config.screenshotDir, { recursive: true });
      const shot = path.join(config.screenshotDir, `director-room-fail-${config.streamId}-${nowStamp()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      report.screenshot = shot;
      console.error(`[DIRECTOR-E2E] FAIL screenshot: ${shot}`);
    }
    console.error(`[DIRECTOR-E2E] FAIL: ${report.failure.message}`);
    if (report.failure.result) {
      console.error(JSON.stringify(report.failure.result, null, 2));
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (publisher && publisher.exitCode === null && publisher.signalCode === null && !publisher.killed) {
      publisher.kill('SIGTERM');
      await wait(1000);
      if (publisher.exitCode === null) {
        publisher.kill('SIGKILL');
      }
    }
    report.publisherOutputTail = `${publisher.stdoutText}\n${publisher.stderrText}`
      .trim()
      .split(/\r?\n/)
      .slice(-80);
    fs.mkdirSync(config.reportDir, { recursive: true });
    const reportPath = path.join(config.reportDir, `director-room-e2e-${config.streamId}-${nowStamp()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[DIRECTOR-E2E] Report: ${reportPath}`);
  }

  if (failure) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
