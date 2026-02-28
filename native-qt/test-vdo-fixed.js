// Test VDO.Ninja WebSocket with fixed stream ID
const WebSocket = require('ws');

const url = 'wss://wss.vdo.ninja:443';
const streamId = 'versus_fixed_test';

console.log('Connecting to', url);
console.log('Stream ID:', streamId);
console.log('\nOpen this URL in browser to view:');
console.log(`https://vdo.ninja/?view=${streamId}&password=false`);
console.log('\n');

const ws = new WebSocket(url);

ws.on('open', function open() {
    console.log('[OPEN] Connected at', new Date().toLocaleTimeString());

    // Send seed request
    const msg = JSON.stringify({request: 'seed', streamID: streamId});
    console.log('[SEND]', msg);
    ws.send(msg);

    // Send periodic pings to keep connection alive
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            const ping = JSON.stringify({ping: Date.now()});
            console.log('[PING] Sending keepalive');
            ws.send(ping);
        }
    }, 5000);
});

ws.on('message', function message(data) {
    const str = data.toString();
    console.log('[MESSAGE] at', new Date().toLocaleTimeString());
    console.log('[MESSAGE]', str.substring(0, 300));

    try {
        const msg = JSON.parse(str);
        if (msg.request === 'offerSDP') {
            console.log('\n*** Received offerSDP from', msg.UUID, '***\n');
        }
        if (msg.pong) {
            console.log('[PONG] Received pong');
        }
    } catch (e) {}
});

ws.on('close', function close(code, reason) {
    console.log('[CLOSE] code=' + code, 'at', new Date().toLocaleTimeString());
    process.exit(0);
});

ws.on('error', function error(err) {
    console.log('[ERROR]', err.message);
});

console.log('Press Ctrl+C to stop\n');
