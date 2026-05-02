// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const compression = require('compression');
const cors = require('cors');
const { Level2Radar } = require('nexrad-level-2-data');
const { XMLParser } = require('fast-xml-parser');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 80;
const BUCKET_URL = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';

app.use(cors());
app.use(compression());
app.use(express.static(path.join(__dirname, '/')));

const subscriptions = new Map();
const activePollers = new Map();
const stationState = new Map(); // stationId -> { lastVolume, lastChunkKey, headerChunk }

const parser = new XMLParser();

function sendStatus(stationId, message) {
    broadcast(stationId, { type: 'status', message: `[Server] ${message}` });
}

async function pollChunks(stationId) {
    try {
        // 1. Find the latest volume directory
        const listVolUrl = `${BUCKET_URL}/?list-type=2&prefix=${stationId}/&delimiter=/`;
        const volRes = await fetch(listVolUrl);
        const volText = await volRes.text();
        const volJson = parser.parse(volText);
        
        let commonPrefixes = volJson.ListBucketResult.CommonPrefixes;
        if (!commonPrefixes) return;
        if (!Array.isArray(commonPrefixes)) commonPrefixes = [commonPrefixes];

        // Numerical sort for volumes (e.g. KLZK/984/)
        commonPrefixes.sort((a, b) => {
            const volA = parseInt(a.Prefix.split('/')[1]);
            const volB = parseInt(b.Prefix.split('/')[1]);
            return volA - volB;
        });
        
        const latestVolPrefix = commonPrefixes[commonPrefixes.length - 1].Prefix;
        let state = stationState.get(stationId) || { lastVolume: null, lastChunkKey: null, headerChunk: null };

        // 2. List chunks in that volume
        const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${latestVolPrefix}`;
        const chunkRes = await fetch(listChunksUrl);
        const chunkText = await chunkRes.text();
        const chunkJson = parser.parse(chunkText);
        
        let contents = chunkJson.ListBucketResult.Contents;
        if (!contents) return;
        if (!Array.isArray(contents)) contents = [contents];

        // Sort by key (contains timestamp and chunk index)
        contents.sort((a, b) => a.Key.localeCompare(b.Key));
        
        const latestChunk = contents[contents.length - 1];

        // Handle new volume or new chunk
        if (latestChunk.Key !== state.lastChunkKey) {
            console.log(`New chunk detected for ${stationId}: ${latestChunk.Key}`);
            
            // If new volume, we MUST get the header chunk (001-S)
            if (latestVolPrefix !== state.lastVolume) {
                console.log(`New volume detected: ${latestVolPrefix}`);
                sendStatus(stationId, `New volume detected: ${latestVolPrefix.split('/')[1]}`);
                const headerKey = contents.find(c => c.Key.endsWith('-001-S'))?.Key;
                if (headerKey) {
                    const hRes = await fetch(`${BUCKET_URL}/${headerKey}`);
                    state.headerChunk = await hRes.arrayBuffer();
                }
                state.lastVolume = latestVolPrefix;
            }

            state.lastChunkKey = latestChunk.Key;
            stationState.set(stationId, state);

            // Fetch and parse the latest chunk
            const dataRes = await fetch(`${BUCKET_URL}/${latestChunk.Key}`);
            const chunkBuffer = await dataRes.arrayBuffer();
            
            try {
                // Combine header + chunk to ensure library can parse correctly
                let combinedBuffer;
                if (state.headerChunk && !latestChunk.Key.endsWith('-001-S')) {
                    combinedBuffer = Buffer.concat([
                        Buffer.from(state.headerChunk),
                        Buffer.from(chunkBuffer)
                    ]);
                } else {
                    combinedBuffer = Buffer.from(chunkBuffer);
                }

                const parsed = new Level2Radar(combinedBuffer);
                const extracted = extractRadialData(parsed);
                if (extracted && extracted.azimuths.length > 0) {
                    console.log(`Broadcasting ${extracted.azimuths.length} radials for ${stationId}`);
                    broadcast(stationId, { 
                        type: 'radial_update', 
                        data: extracted, 
                        chunk: latestChunk.Key.split('/').pop() 
                    });
                }
            } catch (e) {
                // Some chunks might still be unparseable if they are too small or meta-only
                console.warn(`Chunk parse skip (${latestChunk.Key.split('/').pop()}): ${e.message}`);
            }
        }
    } catch (e) {
        console.error(`Error polling chunks for ${stationId}:`, e.message);
    }
}

function extractRadialData(parsed) {
    const elevations = [1, 2, 3, 4, 5];
    const extracted = {
        azimuths: [],
        elevations: {}
    };

    try {
        extracted.azimuths = parsed.getAzimuth();
    } catch (e) { return null; }

    const methods = {
        reflectivity: 'getHighresReflectivity',
        velocity: 'getHighresVelocity',
        debris: 'getHighresCorrelationCoefficient'
    };

    let hasAnyData = false;
    for (const e of elevations) {
        extracted.elevations[e] = {};
        try {
            parsed.setElevation(e);
            for (const [key, method] of Object.entries(methods)) {
                const moments = parsed[key === 'reflectivity' ? 'getHighresReflectivity' : 
                                       (key === 'velocity' ? 'getHighresVelocity' : 'getHighresCorrelationCoefficient')]();
                if (moments && moments.some(m => m && m.moment_data)) {
                    hasAnyData = true;
                    extracted.elevations[e][key] = moments.map(m => m ? {
                        moment_data: m.moment_data,
                        first_gate: m.first_gate,
                        gate_size: m.gate_size
                    } : null);
                }
            }
        } catch (err) {}
    }

    return hasAnyData ? extracted : null;
}

function broadcast(stationId, data) {
    const clients = subscriptions.get(stationId);
    if (clients) {
        const message = JSON.stringify(data);
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}

wss.on('connection', (ws) => {
    console.log('New client connected');
    let currentStation = null;

    ws.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.action === 'subscribe') {
                const stationId = parsed.station;
                console.log(`Client subscribing to ${stationId}`);
                
                if (currentStation) {
                    subscriptions.get(currentStation)?.delete(ws);
                    if (subscriptions.get(currentStation)?.size === 0) {
                        clearInterval(activePollers.get(currentStation));
                        activePollers.delete(currentStation);
                        stationState.delete(currentStation);
                    }
                }

                currentStation = stationId;
                if (!subscriptions.has(stationId)) subscriptions.set(stationId, new Set());
                subscriptions.get(stationId).add(ws);

                if (!activePollers.has(stationId)) {
                    const poller = setInterval(() => pollChunks(stationId), 3000); 
                    activePollers.set(stationId, poller);
                    pollChunks(stationId);
                }
                
                ws.send(JSON.stringify({ type: 'status', message: `Subscribed to real-time chunks for ${stationId}` }));
            }
        } catch (e) {
            console.error('Error handling message:', e);
        }
    });

    ws.on('close', () => {
        if (currentStation) {
            subscriptions.get(currentStation)?.delete(ws);
            if (subscriptions.get(currentStation)?.size === 0) {
                clearInterval(activePollers.get(currentStation));
                activePollers.delete(currentStation);
                stationState.delete(currentStation);
            }
        }
    });
});

// Heartbeat to keep connections alive and provide feedback
setInterval(() => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'heartbeat', time: Date.now() }));
        }
    });
}, 15000);

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
