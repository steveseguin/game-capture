// Negotiation probe only; decoded playback is covered by the packaged workflow.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://vdo.ninja/');
    const results = await page.evaluate(async () => {
      const results = { userAgent: navigator.userAgent, cases: [] };
      for (const codec of ['opus/48000/2', 'L16/48000/1', 'L16/48000/2', 'L16/32000/2', 'L16/48000/6', 'multiopus/48000/6']) {
        for (const red of [false, true]) {
          const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
          try {
            sender.addTransceiver('audio', { direction: 'sendonly' });
            let sdp = (await sender.createOffer()).sdp;
            const pt = codec.startsWith('opus') ? 111 : 109;
            const payloads = (red ? '63 ' : '') + (pt === 111 ? '111' : '109 111');
            sdp = sdp.replace(/^m=audio .+$/m, 'm=audio 9 UDP/TLS/RTP/SAVPF ' + payloads);
            sdp = sdp.split('\r\n').filter(l => !/^a=(rtpmap|fmtp|rtcp-fb):/.test(l)).join('\r\n');
            let mappings = 'a=rtpmap:' + pt + ' ' + codec + '\r\n';
            if (codec.startsWith('multiopus')) mappings += 'a=fmtp:109 channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2\r\n';
            if (pt !== 111) mappings += 'a=rtpmap:111 opus/48000/2\r\n';
            if (red) mappings += 'a=rtpmap:63 red/' + codec.split('/').slice(1).join('/') + '\r\na=fmtp:63 ' + pt + '/' + pt + '\r\n';
            sdp += mappings;
            await receiver.setRemoteDescription({ type: 'offer', sdp });
            const answer = await receiver.createAnswer();
            const automaticAnswer = answer.sdp;
            answer.sdp = answer.sdp.replace(/^m=audio .+$/m, 'm=audio 9 UDP/TLS/RTP/SAVPF ' + payloads);
            answer.sdp = answer.sdp.split('\r\n').filter(l => !/^a=(rtpmap|fmtp|rtcp-fb):/.test(l)).join('\r\n') + mappings;
            await receiver.setLocalDescription(answer);
            results.cases.push({ codec, red, automaticAnswer, answer: receiver.localDescription.sdp });
          } catch (error) { results.cases.push({ codec, red, error: String(error) }); }
          finally { sender.close(); receiver.close(); }
        }
      }
      return results;
    });
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
