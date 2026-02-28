// Test different WebSocket servers with Node.js
const WebSocket = require('ws');

async function testServer(name, url, msg) {
    return new Promise((resolve) => {
        console.log(`\n=== Testing ${name} ===`);
        console.log('URL:', url);

        const ws = new WebSocket(url);
        let received = false;

        ws.on('open', () => {
            console.log('[OPEN] Connected');
            if (msg) {
                console.log('[SEND]', msg);
                ws.send(msg);
            }
        });

        ws.on('message', (data) => {
            received = true;
            console.log('[MESSAGE]', data.toString().substring(0, 100));
        });

        ws.on('close', (code) => {
            console.log('[CLOSE] code=' + code, received ? '(received messages)' : '(NO messages)');
            resolve(received);
        });

        ws.on('error', (err) => {
            console.log('[ERROR]', err.message);
            resolve(false);
        });

        setTimeout(() => {
            ws.close();
        }, 5000);
    });
}

async function main() {
    // Test multiple servers
    await testServer('VDO.Ninja wss', 'wss://wss.vdo.ninja:443', '{"request":"seed","streamID":"test123"}');
    await testServer('VDO.Ninja API', 'wss://api.vdo.ninja:443', '{"request":"test"}');
    await testServer('Echo websocket.org', 'wss://echo.websocket.org', 'Hello');

    console.log('\nDone!');
}

main();
