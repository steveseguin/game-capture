#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const args = {
    stream: '',
    room: '',
    password: 'false',
    output: '',
    timeoutMs: 50000,
    deltaMs: 3000,
    headful: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--stream=')) args.stream = arg.slice('--stream='.length);
    else if (arg.startsWith('--room=')) args.room = arg.slice('--room='.length);
    else if (arg.startsWith('--password=')) args.password = arg.slice('--password='.length);
    else if (arg.startsWith('--output=')) args.output = path.resolve(arg.slice('--output='.length));
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Math.max(10000, Number(arg.slice('--timeout-ms='.length)) || args.timeoutMs);
    else if (arg.startsWith('--delta-ms=')) args.deltaMs = Math.max(1000, Number(arg.slice('--delta-ms='.length)) || args.deltaMs);
    else if (arg === '--headful') args.headful = true;
  }
  return args;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildViewerUrl(config) {
  const query = new URLSearchParams();
  query.set('view', config.stream);
  if (config.room) {
    query.set('room', config.room);
    query.set('solo', '');
  }
  query.set('autostart', '');
  query.set('muted', '');
  query.set('password', config.password);
  return `https://vdo.ninja/?${query.toString()}`;
}

async function waitForRpc(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const sessionObj = window.session || null;
      if (!sessionObj) return { ok: false, reason: 'no_session' };
      const ids = Object.keys(sessionObj.rpcs || {});
      if (!ids.length) return { ok: false, reason: 'no_rpcs' };
      const uuid = ids[0];
      const rpc = sessionObj.rpcs[uuid];
      const pc = rpc && typeof rpc.getStats === 'function'
        ? rpc
        : (rpc && rpc.whep && typeof rpc.whep.getStats === 'function' ? rpc.whep : null);
      return {
        ok: !!pc,
        reason: pc ? '' : 'rpc_has_no_getStats',
        uuid,
        connectionState: pc ? String(pc.connectionState || '') : '',
        iceConnectionState: pc ? String(pc.iceConnectionState || '') : '',
      };
    });
    if (last && last.ok) return last;
    await wait(250);
  }
  return last || { ok: false, reason: 'rpc_timeout' };
}

async function installInfoProbe(page, uuid) {
  return page.evaluate((peerUuid) => {
    const sessionObj = window.session || null;
    const rpc = sessionObj && sessionObj.rpcs ? sessionObj.rpcs[peerUuid] : null;
    if (!rpc) return { ok: false, reason: 'no_rpc' };
    const probe = window.__roomAlphaInfoProbe || { records: [] };
    window.__roomAlphaInfoProbe = probe;
    const parse = (event, channel) => {
      if (!event || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data);
        if (message && (message.info || message.miniInfo || message.remoteStats)) {
          probe.records.push({ ts: Date.now(), channel, message });
          if (probe.records.length > 500) probe.records.shift();
        }
      } catch {
        // The real session also carries non-JSON application data.
      }
    };
    const attach = (channel, name) => {
      if (!channel) return false;
      if (channel.__roomAlphaProbeAttached) return true;
      channel.__roomAlphaProbeAttached = true;
      if (typeof channel.addEventListener === 'function') {
        channel.addEventListener('message', (event) => parse(event, name));
      } else {
        const previous = channel.onmessage;
        channel.onmessage = (event) => {
          parse(event, name);
          if (typeof previous === 'function') return previous.call(channel, event);
          return undefined;
        };
      }
      return true;
    };
    return { ok: attach(rpc.receiveChannel, 'receiveChannel') || attach(rpc.sendChannel, 'sendChannel') };
  }, uuid);
}

async function sendAlphaViewerRequest(page, uuid, roomMode) {
  const request = {
    init: {
      role: roomMode ? 'guest' : 'viewer',
      room: roomMode,
      video: true,
      audio: false,
      label: 'room-alpha-playwright-receiver',
      system: {
        app: 'game-capture-room-alpha-e2e',
        version: '1',
        platform: 'playwright',
        browser: 'chromium',
      },
    },
    downloads: false,
    allowmidi: false,
    allowdrawing: false,
    iframe: false,
    widget: false,
    audio: false,
    video: true,
    broadcast: false,
    requestResolution: { w: 640, h: 360 },
    info: {
      label: 'Room Alpha E2E Receiver',
      version: '1',
      platform: 'Playwright',
      Browser: 'Chromium alpha stats probe',
      alpha_receive: 'vp9-dualtrack-v1',
    },
  };
  if (roomMode) request.guest = true;

  return page.evaluate(({ peerUuid, payload }) => {
    const sessionObj = window.session || null;
    if (!sessionObj || !sessionObj.rpcs || !sessionObj.rpcs[peerUuid]) {
      return { ok: false, reason: 'no_rpc' };
    }
    let sent = false;
    if (typeof sessionObj.sendRequest === 'function') {
      sent = sessionObj.sendRequest(payload, peerUuid) !== false;
    } else {
      const rpc = sessionObj.rpcs[peerUuid];
      const channel = rpc.receiveChannel || rpc.sendChannel;
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify(payload));
        sent = true;
      }
    }
    return { ok: sent, uuid: peerUuid, payload };
  }, { peerUuid: uuid, payload: request });
}

async function sendWithRetry(page, uuid, roomMode, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await installInfoProbe(page, uuid);
    last = await sendAlphaViewerRequest(page, uuid, roomMode);
    if (last && last.ok) return last;
    await wait(250);
  }
  return last || { ok: false, reason: 'send_timeout' };
}

async function readSnapshot(page, uuid) {
  return page.evaluate(async (peerUuid) => {
    const sessionObj = window.session || null;
    const rpc = sessionObj && sessionObj.rpcs ? sessionObj.rpcs[peerUuid] : null;
    const pc = rpc && typeof rpc.getStats === 'function'
      ? rpc
      : (rpc && rpc.whep && typeof rpc.whep.getStats === 'function' ? rpc.whep : null);
    if (!pc) return { ok: false, reason: 'no_getStats' };

    window.__roomAlphaSinks = window.__roomAlphaSinks || {};
    const transceivers = typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : [];
    const transceiverState = [];
    for (let index = 0; index < transceivers.length; index += 1) {
      const transceiver = transceivers[index];
      const track = transceiver && transceiver.receiver ? transceiver.receiver.track : null;
      const state = {
        index,
        mid: transceiver ? String(transceiver.mid || '') : '',
        direction: transceiver ? String(transceiver.direction || '') : '',
        currentDirection: transceiver ? String(transceiver.currentDirection || '') : '',
        trackId: track ? String(track.id || '') : '',
        trackKind: track ? String(track.kind || '') : '',
        trackReadyState: track ? String(track.readyState || '') : '',
      };
      transceiverState.push(state);
      if (track && track.kind === 'video' && track.readyState === 'live' && !window.__roomAlphaSinks[track.id]) {
        const sink = document.createElement('video');
        sink.muted = true;
        sink.autoplay = true;
        sink.playsInline = true;
        sink.style.cssText = 'position:fixed;width:2px;height:2px;left:-10px;top:-10px;opacity:0.01';
        sink.dataset.roomAlphaTrack = track.id;
        sink.srcObject = new MediaStream([track]);
        document.body.appendChild(sink);
        sink.play().catch(() => {});
        window.__roomAlphaSinks[track.id] = sink;
      }
    }

    const stats = await pc.getStats();
    const byId = {};
    stats.forEach((entry) => { byId[entry.id] = entry; });
    const inboundVideo = [];
    stats.forEach((entry) => {
      if (entry.type !== 'inbound-rtp' || entry.isRemote) return;
      if (entry.kind !== 'video' && entry.mediaType !== 'video') return;
      const codec = entry.codecId ? byId[entry.codecId] : null;
      const receiver = entry.receiverId ? byId[entry.receiverId] : null;
      const trackIdentifier = String(entry.trackIdentifier || (receiver && receiver.trackIdentifier) || '');
      const transceiver = transceiverState.find((item) => item.trackId && item.trackId === trackIdentifier) || null;
      inboundVideo.push({
        id: String(entry.id || ''),
        mid: String(entry.mid || (transceiver && transceiver.mid) || ''),
        ssrc: Number(entry.ssrc || 0),
        trackIdentifier,
        codecId: String(entry.codecId || ''),
        codecMimeType: codec ? String(codec.mimeType || '') : '',
        packetsReceived: Number(entry.packetsReceived || 0),
        bytesReceived: Number(entry.bytesReceived || 0),
        framesReceived: Number(entry.framesReceived || 0),
        framesDecoded: Number(entry.framesDecoded || 0),
        keyFramesDecoded: Number(entry.keyFramesDecoded || 0),
        frameWidth: Number(entry.frameWidth || 0),
        frameHeight: Number(entry.frameHeight || 0),
      });
    });

    const records = window.__roomAlphaInfoProbe && Array.isArray(window.__roomAlphaInfoProbe.records)
      ? window.__roomAlphaInfoProbe.records.slice(-100)
      : [];
    const infos = records.filter((entry) => entry && entry.message && entry.message.info)
      .map((entry) => ({ ts: entry.ts, info: entry.message.info }));
    const sinks = Object.values(window.__roomAlphaSinks).map((sink) => ({
      trackId: sink.dataset.roomAlphaTrack || '',
      readyState: Number(sink.readyState || 0),
      currentTime: Number(sink.currentTime || 0),
      width: Number(sink.videoWidth || 0),
      height: Number(sink.videoHeight || 0),
      paused: !!sink.paused,
      ended: !!sink.ended,
    }));

    return {
      ok: true,
      capturedAt: Date.now(),
      connectionState: String(pc.connectionState || ''),
      iceConnectionState: String(pc.iceConnectionState || ''),
      signalingState: String(pc.signalingState || ''),
      inboundVideo,
      transceivers: transceiverState,
      infos,
      sinks,
    };
  }, uuid);
}

function classifyTracks(snapshot) {
  const videos = snapshot && Array.isArray(snapshot.inboundVideo) ? snapshot.inboundVideo : [];
  const alpha = videos.find((entry) => /alpha/i.test(entry.mid)) || null;
  const primary = videos.find((entry) => !/alpha/i.test(entry.mid)) || null;
  return { primary, alpha, videos };
}

function trackDelta(before, after, kind) {
  const first = classifyTracks(before)[kind];
  const second = classifyTracks(after)[kind];
  if (!first || !second) return null;
  return {
    before: first,
    after: second,
    framesDecoded: second.framesDecoded - first.framesDecoded,
    framesReceived: second.framesReceived - first.framesReceived,
    bytesReceived: second.bytesReceived - first.bytesReceived,
    packetsReceived: second.packetsReceived - first.packetsReceived,
  };
}

function latestInfo(snapshot) {
  const infos = snapshot && Array.isArray(snapshot.infos) ? snapshot.infos : [];
  return infos.length ? infos[infos.length - 1].info : null;
}

function writeResult(config, result) {
  if (!config.output) return;
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, `${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const config = parseArgs(process.argv);
  const result = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    config: {
      stream: config.stream,
      room: config.room,
      passwordPresent: config.password !== '',
      timeoutMs: config.timeoutMs,
      deltaMs: config.deltaMs,
    },
    harness: { ok: false, errors: [], pageErrors: [], requestFailures: [] },
    signaling: {},
    snapshots: {},
    deltas: {},
    assertions: {},
    product: { ok: false },
  };
  let browser = null;

  try {
    if (!config.stream || !config.output) {
      throw new Error('Required arguments: --stream and --output; --room is optional for the direct positive control');
    }
    result.viewerUrl = buildViewerUrl(config);
    browser = await chromium.launch({ headless: !config.headful });
    result.harness.browserVersion = browser.version();
    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });
    const page = await context.newPage();
    result.harness.userAgent = await page.evaluate(() => navigator.userAgent);
    page.on('pageerror', (error) => result.harness.pageErrors.push(String(error && error.message || error)));
    page.on('requestfailed', (request) => result.harness.requestFailures.push({
      url: request.url(),
      error: request.failure() ? request.failure().errorText : 'unknown',
    }));

    const response = await page.goto(result.viewerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    result.harness.navigation = {
      ok: !!response,
      status: response ? response.status() : null,
      finalUrl: page.url(),
    };
    const rpc = await waitForRpc(page, Math.min(config.timeoutMs, 40000));
    result.signaling.rpc = rpc;
    if (!rpc.ok) throw new Error(`VDO.Ninja room session RPC unavailable: ${rpc.reason || 'unknown'}`);

    result.signaling.infoProbe = await installInfoProbe(page, rpc.uuid);
    const sent = await sendWithRetry(page, rpc.uuid, !!config.room, 10000);
    result.signaling.alphaViewerRequest = sent;
    if (!sent.ok) throw new Error(`Could not send alpha-capable room viewer request: ${sent.reason || 'unknown'}`);

    const deadline = Date.now() + config.timeoutMs;
    let candidate = null;
    let nextCapabilityRetryAt = Date.now() + 10000;
    let capabilityRetryCount = 0;
    result.signaling.capabilityRetries = [];
    while (Date.now() < deadline) {
      candidate = await readSnapshot(page, rpc.uuid);
      if (!candidate.ok) throw new Error(`WebRTC stats unavailable: ${candidate.reason || 'unknown'}`);
      const tracks = classifyTracks(candidate);
      if (tracks.primary && tracks.alpha && tracks.primary.framesDecoded > 0 && tracks.alpha.framesDecoded > 0) break;
      if (Date.now() >= nextCapabilityRetryAt && capabilityRetryCount < 2) {
        const retry = await sendAlphaViewerRequest(page, rpc.uuid, !!config.room);
        result.signaling.capabilityRetries.push({ ts: Date.now(), ...retry });
        capabilityRetryCount += 1;
        nextCapabilityRetryAt = Date.now() + 15000;
      }
      await wait(500);
    }
    result.snapshots.baseline = candidate;
    await wait(config.deltaMs);
    result.snapshots.after = await readSnapshot(page, rpc.uuid);
    if (!result.snapshots.after.ok) throw new Error('Final WebRTC stats snapshot was unavailable');

    result.deltas.primary = trackDelta(result.snapshots.baseline, result.snapshots.after, 'primary');
    result.deltas.alpha = trackDelta(result.snapshots.baseline, result.snapshots.after, 'alpha');
    const finalTracks = classifyTracks(result.snapshots.after);
    const info = latestInfo(result.snapshots.after) || latestInfo(result.snapshots.baseline);
    const vp9Tracks = finalTracks.videos.filter((entry) => /\/VP9$/i.test(entry.codecMimeType));
    const connected = ['connected', 'completed'].includes(String(result.snapshots.after.connectionState || '').toLowerCase()) ||
      ['connected', 'completed'].includes(String(result.snapshots.after.iceConnectionState || '').toLowerCase());

    result.assertions = {
      roomSessionConnected: connected,
      roomInitAcknowledged: config.room
        ? !!(info && info.room_init === true && info.room_init_received === true)
        : !!(info && info.room_init === false),
      effectiveTierHq: !!(info && String(info.assigned_tier || '').toLowerCase() === 'hq'),
      roomQualityRequested: !!(info && info.room_quality_requested === true),
      roomQualityDiagnosticsMatchContext: !!(
        info &&
        info.room_quality_effective === false &&
        info.room_quality_reason === (config.room ? 'codec-not-h264' : 'not-in-room')
      ),
      alphaCapabilityAcknowledged: !!(info && info.alpha_active === true && info.alpha_send === 'vp9-dualtrack-v1'),
      selectedCodecAuthorityVp9: !!(info && String(info.codec_url || '').toLowerCase() === 'vp9') &&
        finalTracks.videos.length >= 2 && vp9Tracks.length === finalTracks.videos.length,
      primaryAndAlphaMidsNegotiated: !!(finalTracks.primary && finalTracks.alpha && finalTracks.primary.mid !== finalTracks.alpha.mid),
      primaryDecoded: !!(finalTracks.primary && finalTracks.primary.framesDecoded > 0),
      alphaDecoded: !!(finalTracks.alpha && finalTracks.alpha.framesDecoded > 0),
      primaryFramesAdvance: !!(result.deltas.primary && result.deltas.primary.framesDecoded > 0 && result.deltas.primary.bytesReceived > 0),
      alphaFramesAdvance: !!(result.deltas.alpha && result.deltas.alpha.framesDecoded > 0 && result.deltas.alpha.bytesReceived > 0),
    };
    result.harness.ok = true;
    result.product.ok = Object.values(result.assertions).every(Boolean);
    result.failureClass = result.product.ok ? 'none' : 'product';
  } catch (error) {
    result.harness.errors.push(String(error && error.stack || error));
    result.harness.ok = false;
    result.product.ok = false;
    result.failureClass = 'harness';
  } finally {
    result.finishedAt = new Date().toISOString();
    if (browser) await browser.close().catch(() => {});
    writeResult(config, result);
  }

  console.log(JSON.stringify({
    output: config.output,
    harnessOk: result.harness.ok,
    productOk: result.product.ok,
    failureClass: result.failureClass,
    assertions: result.assertions,
  }, null, 2));
  process.exitCode = result.harness.ok ? (result.product.ok ? 0 : 2) : 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
