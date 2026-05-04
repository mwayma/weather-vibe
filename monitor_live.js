const WebSocket = require('ws');

const ws = new WebSocket('wss://weather.waymack.org');
const stationId = 'KIND';

console.log(`Connecting to wss://weather.waymack.org...`);

let messageCount = 0;
let lastMessageAt = Date.now();
const start = Date.now();

ws.on('open', () => {
    console.log('Connected to live backend');
    ws.send(JSON.stringify({ action: 'subscribe', station: stationId, initial: false }));
    console.log(`Subscribed to ${stationId}`);
});

ws.on('message', (data) => {
    const now = Date.now();
    messageCount++;
    const message = JSON.parse(data);
    
    if (message.type === 'heartbeat') {
        // console.log(`[${new Date().toLocaleTimeString()}] Heartbeat received`);
    } else if (message.type === 'radial_batch') {
        console.log(`[${new Date().toLocaleTimeString()}] Received batch: ${message.radials.length} radials. Latest Az: ${message.latestAzimuth}`);
    } else if (message.type === 'status') {
        console.log(`[${new Date().toLocaleTimeString()}] Status: ${message.message}`);
    } else {
        console.log(`[${new Date().toLocaleTimeString()}] Other message: ${message.type}`);
    }
    
    lastMessageAt = now;
});

ws.on('error', (err) => {
    console.error('WS Error:', err.message);
});

ws.on('close', () => {
    console.log('Connection closed');
    process.exit(0);
});

// Monitor activity
setInterval(() => {
    const now = Date.now();
    const idleTime = (now - lastMessageAt) / 1000;
    const totalTime = (now - start) / 1000;
    console.log(`--- Stats: ${messageCount} msgs received. Total time: ${totalTime.toFixed(1)}s. Idle for: ${idleTime.toFixed(1)}s ---`);
    
    if (idleTime > 60) {
        console.warn('CRITICAL: No messages received for 60 seconds!');
    }
}, 10000);

// Run for 5 minutes
setTimeout(() => {
    console.log('Monitoring complete.');
    ws.close();
}, 300000);
