'use strict';
// Browser/media observations around an owned publisher-only signaling fault.
const assert = require('node:assert/strict');
const {waitFor, observeDecoded, observeAudio, requireMoving} = require('./macos-media-receiver');

async function identity(participant, remember = false) {
  return participant.page.evaluate(async ({uuid, remember}) => {
    const pc = window.session?.rpcs?.[uuid];
    if (!pc || pc.connectionState !== 'connected') throw Error('Room peer is not connected');
    if (remember) window.__roomRecoveryPeer = pc;
    if (window.__roomRecoveryPeer !== pc) throw Error('Room peer connection was replaced');
    const rows = [...(await pc.getStats()).values()];
    const audio = rows.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
    const video = rows.find(s => s.type === 'inbound-rtp' && s.kind === 'video');
    if (!audio || !video) throw Error('Room peer is missing received media');
    return {connection:pc.connectionState, audioSsrc:audio.ssrc, videoSsrc:video.ssrc};
  }, {uuid:participant.uuid, remember});
}

async function sample(participant, milliseconds) {
  const [video, audio] = await Promise.all([
    observeDecoded(participant.page, milliseconds, participant.uuid),
    observeAudio(participant.page, participant.uuid)
  ]);
  const distinctFrames = requireMoving(video, participant.name + ' during room recovery');
  const decodedFps = distinctFrames / ((video.ended - video.started) / 1000);
  assert.equal(video.width, participant.width); assert.equal(video.height, participant.height);
  assert(decodedFps >= 28.5, participant.name + ' fell below 95% of 30 fps');
  const stereoSamples = audio.spectra.filter(s => s.rms > .001 &&
    s.channels[0].tone440 > s.channels[0].tone880 + 20 &&
    s.channels[1].tone880 > s.channels[1].tone440 + 20).length;
  assert(stereoSamples >= 25, participant.name + ' stereo sample failed');
  return {video, audio, distinctFrames, decodedFps, stereoSamples};
}

async function begin({proxy, diagnostics, participants, evidence}) {
  evidence.beforeProxy = proxy.snapshot();
  evidence.before = {};
  for (const participant of participants) evidence.before[participant.name] = await identity(participant, true);
  proxy.fault('reject'); evidence.outageStarted = Date.now();
  await waitFor(async () => (await diagnostics()).app.reconnecting, 8000, 'Room publisher did not enter signaling recovery');
  evidence.during = Object.fromEntries(await Promise.all(participants.map(async participant =>
    [participant.name, await sample(participant, 15000)])));
  evidence.outageDiagnostics = await diagnostics(); evidence.duringProxy = proxy.snapshot();
  assert(evidence.outageDiagnostics.app.live && evidence.outageDiagnostics.app.reconnecting);
  assert(evidence.duringProxy.rejectedConnections > 0, 'No room reconnect was refused');
  for (const participant of participants) assert.deepEqual(await identity(participant), evidence.before[participant.name]);
  // The caller performs a real guest Hang up while signaling is still refused.
  // Preserve the two remaining pages/PCs through registration and late joining.
  return async function restore(survivors) {
    evidence.beforeRestoreDiagnostics = await diagnostics();
    assert(evidence.beforeRestoreDiagnostics.app.reconnecting);
    assert.equal(evidence.beforeRestoreDiagnostics.peer_counts.room_guests, 0);
    assert.equal(evidence.beforeRestoreDiagnostics.peer_counts.total, 2);
    const restored = Date.now(); evidence.refusedSignalingMs = restored - evidence.outageStarted;
    proxy.restore();
    await waitFor(async () => proxy.snapshot().forwardedConnections > evidence.beforeProxy.forwardedConnections &&
      !(await diagnostics()).app.reconnecting, 45000, 'Room publisher did not reconnect');
    evidence.reconnectMs = Date.now() - restored;
    evidence.after = Object.fromEntries(await Promise.all(survivors.map(async participant => {
      const peer = await identity(participant);
      assert.deepEqual(peer, evidence.before[participant.name]);
      return [participant.name, {peer, ...await sample(participant, 6000)}];
    })));
    evidence.afterRestoreDiagnostics = await diagnostics(); evidence.afterProxy = proxy.snapshot();
    assert(evidence.afterRestoreDiagnostics.app.live && !evidence.afterRestoreDiagnostics.app.reconnecting);
  };
}

async function leave({guest, diagnostics, survivors, abrupt = false}) {
  const evidence = guest.evidence.leave = {
    action:abrupt ? 'Close guest tab without running beforeunload' : 'Hosted guest Hang up button',
    observations:[], playback:[]
  };
  const started = Date.now();
  if (abrupt) await guest.page.close({runBeforeUnload:false});
  else await guest.page.getByRole('button', {name:'Hang up', exact:true}).click();
  let finished = false;
  const cleanup = (async () => {
    try {
      // The shared application retains disconnected transports for 90 seconds.
      // Include time for ICE to notice the closed browser, and measure the
      // existing receivers throughout that interval rather than shortening it.
      await waitFor(async () => {
        const d = await diagnostics();
        const peers = d.peers.filter(p => p.room.role === 'guest');
        evidence.observations.push({elapsedMs:Date.now()-started, peers:peers.map(p => ({
          state:p.last_connection_state, disconnectedSinceSteadyMs:p.transport.disconnected_since_steady_ms,
          retired:p.transport.transport_retired
        }))});
        if (peers.length) return false;
        evidence.elapsedMs = Date.now()-started; evidence.diagnostics = d;
        assert.equal(d.peer_counts.total, 2);
        assert.equal(d.peer_counts.active_audio, 2); assert.equal(d.peer_counts.active_video, 2);
        return true;
      }, 125000, 'Guest peer survived the disconnected-transport cleanup window');
    } finally { finished = true; }
  })();
  const playback = (async () => {
    do {
      evidence.playback.push(Object.fromEntries(await Promise.all(survivors.map(async p => [p.name, await sample(p, 10000)]))));
    } while (!finished);
  })();
  await Promise.all([cleanup, playback]);
  if (!guest.page.isClosed()) await guest.page.close();
}

module.exports = {begin, leave};
