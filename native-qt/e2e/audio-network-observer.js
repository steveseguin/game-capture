'use strict';
// Browser-scoped P2P impairment. No host firewall or network configuration changes.
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function attach(page) {
  const cdp = await page.context().newCDPSession(page);
  async function conditions(packetLoss, latency = 1) {
    await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false,
      matchedNetworkConditions: [{ urlPattern: '', latency, downloadThroughput: -1,
        uploadThroughput: -1, packetLoss }] });
  }
  try {
    await cdp.send('Network.enable');
    // The P2P interceptor must be installed before RTCPeerConnection creation.
    await conditions(0);
  } catch (error) {
    await cdp.detach().catch(() => {});
    throw error;
  }
  async function snapshot() {
    return page.evaluate(async () => {
      const pc = window.audioReviewPc;
      const all = [...(await pc.getStats()).values()];
      return { connection: pc.connectionState,
        audio: all.find(s => s.type === 'inbound-rtp' && s.kind === 'audio'),
        video: all.find(s => s.type === 'inbound-rtp' && s.kind === 'video') };
    });
  }
  function delta(before, after) {
    assert(before.audio && after.audio && before.video && after.video, 'Missing inbound media stats');
    assert.equal(before.audio.ssrc, after.audio.ssrc, 'Audio SSRC changed inside observation');
    assert.equal(before.video.ssrc, after.video.ssrc, 'Video SSRC changed inside observation');
    const diff = (kind, name) => after[kind][name] - before[kind][name];
    const samples = diff('audio', 'totalSamplesReceived');
    return { seconds: diff('video', 'timestamp') / 1000,
      audioPackets: diff('audio', 'packetsReceived'), lostAudioPackets: diff('audio', 'packetsLost'),
      concealedSamples: diff('audio', 'concealedSamples'), totalAudioSamples: samples,
      concealedFraction: samples > 0 ? diff('audio', 'concealedSamples') / samples : null,
      videoPackets: diff('video', 'packetsReceived'), videoFrames: diff('video', 'framesDecoded'),
      lostVideoPackets: diff('video', 'packetsLost') };
  }
  return {
    async exercise({ measure, result, expectedBitrate }) {
      result.network = { scope: 'One Chrome receiver: 10% loss, 30% loss + 100 ms, four-second outage, recovery. Random loss is not a deterministic codec ranking.', phases: [], passed: false };
      for (const [name, loss, latency, seconds] of [['ten-percent-loss', 10, 1, 25], ['loss-and-delay', 30, 100, 20]]) {
        await conditions(loss, latency);
        await sleep(3000);
        const phase = { name, lossPercent: loss, latencyMs: latency, before: await snapshot() };
        result.network.phases.push(phase);
        await sleep(seconds * 1000);
        phase.after = await snapshot(); phase.delta = delta(phase.before, phase.after);
        assert(phase.delta.lostAudioPackets > 10, 'Audio packet loss was not actually applied');
        assert(phase.delta.videoFrames > 10 && phase.delta.audioPackets > 10, 'Media stopped during partial loss');
        assert(Number.isFinite(phase.delta.concealedFraction), 'Concealment observation missing');
        // Loss changes received bitrate. Keep the normal decoded tone/channel/video assertions.
        await measure(name, undefined);
        phase.decodedContentPassed = true;
        console.log(name, JSON.stringify(phase.delta));
      }
      await conditions(100);
      await sleep(2000); // Drain already queued packets before observing the final two seconds.
      const outage = { name: 'total-outage', lossPercent: 100, before: await snapshot() };
      result.network.phases.push(outage);
      await sleep(2000);
      outage.after = await snapshot(); outage.delta = delta(outage.before, outage.after);
      assert.equal(outage.delta.audioPackets, 0, 'Audio packets still arrive during total outage');
      assert.equal(outage.delta.videoPackets, 0, 'Video packets still arrive during total outage');
      assert.equal(outage.delta.videoFrames, 0, 'Video still advances during total outage');
      await conditions(0);
      // Observe the same receiver recovering; do not replace its page or connection.
      await sleep(5000);
      const recovery = { name: 'recovery', before: await snapshot() };
      result.network.phases.push(recovery);
      await sleep(20000);
      recovery.after = await snapshot(); recovery.delta = delta(recovery.before, recovery.after);
      assert.equal(recovery.after.connection, 'connected');
      assert(recovery.delta.videoFrames / recovery.delta.seconds >= 28.5, 'Recovery missed 95% of 30 fps');
      await measure('network-recovered', expectedBitrate);
      recovery.decodedContentPassed = true;
      result.network.passed = true;
      console.log('network-recovery', JSON.stringify(recovery.delta));
    },
    async close() {
      try {
        await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [] });
      } finally {
        await cdp.detach();
      }
    }
  };
}
module.exports = { attach };
