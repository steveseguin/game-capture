// Test VDO.Ninja WebSocket with longer wait and viewer prompt
const WebSocket = require('ws');

const url = 'wss://wss.vdo.ninja:443';
const streamId = 'game_capture_test_' + Date.now();

console.log('Connecting to', url);
console.log('Stream ID:', streamId);
console.log('\nOpen this URL in browser to view:', `https://vdo.ninja/?view=${streamId}&password=false`);
console.log('\n');

const ws = new WebSocket(url);

ws.on('open', function open() {
    console.log('[OPEN] Connected at', new Date().toISOString());

    // Send seed request
    const msg = JSON.stringify({request: 'seed', streamID: streamId});
    console.log('[SEND] Seed request:', msg);
    ws.send(msg);

    console.log('\nWaiting for viewer to connect...');
    console.log('(Open the URL above in a browser to trigger offerSDP)\n');
});

ws.on('message', function message(data) {
    const str = data.toString();
    console.log('[MESSAGE] Received at', new Date().toISOString());
    console.log('[MESSAGE] Content:', str.substring(0, 500));

    // Parse and check for specific requests
    try {
        const msg = JSON.parse(str);
        if (msg.request === 'offerSDP') {
            console.log('\n*** SUCCESS: Received offerSDP request! ***\n');
        }
        if (msg.id) {
            console.log('*** Server assigned ID:', msg.id, '***');
        }
        if (msg.ping) {
            console.log('*** Received ping, sending pong ***');
            ws.send(JSON.stringify({pong: msg.ping}));
        }
    } catch (e) {}
});

ws.on('close', function close(code, reason) {
    console.log('[CLOSE] code=' + code + ', reason=' + reason + ' at', new Date().toISOString());
});

ws.on('error', function error(err) {
    console.log('[ERROR]', err.message);
});

// Keep alive for 60 seconds
setTimeout(() => {
    console.log('\nTest complete after 60 seconds, closing...');
    ws.close();
}, 60000);

