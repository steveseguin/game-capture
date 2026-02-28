// Test VDO.Ninja WebSocket with Node.js
const WebSocket = require('ws');

const url = 'wss://wss.vdo.ninja:443';
console.log('Connecting to', url);

const ws = new WebSocket(url);

ws.on('open', function open() {
    console.log('[OPEN] Connected!');

    // Send seed request
    const msg = JSON.stringify({request: 'seed', streamID: 'node_test_12345'});
    console.log('Sending:', msg);
    ws.send(msg);
});

ws.on('message', function message(data) {
    console.log('[MESSAGE] Received:', data.toString().substring(0, 200));
});

ws.on('close', function close(code, reason) {
    console.log('[CLOSE] code=' + code + ', reason=' + reason);
});

ws.on('error', function error(err) {
    console.log('[ERROR]', err.message);
});

// Keep alive for 15 seconds
setTimeout(() => {
    console.log('Test complete, closing...');
    ws.close();
}, 15000);
