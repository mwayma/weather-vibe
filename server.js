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
const stationState = new Map(); // stationId -> { lastVolume, lastChunkKey }

const parser = new XMLParser();

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

        // Prefixes are like "KLZK/394/", sort them to find the latest
        commonPrefixes.sort((a, b) => a.Prefix.localeCompare(b.Prefix));
        const latestVolPrefix = commonPrefixes[commonPrefixes.length - 1].Prefix;
        
        // 2. List chunks in that volume
        const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${latestVolPrefix}`;
        const chunkRes = await fetch(listChunksUrl);
        const chunkText = await chunkRes.text();
        const chunkJson = parser.parse(chunkText);
        
        let contents = chunkJson.ListBucketResult.Contents;
        if (!contents) return;
        if (!Array.isArray(contents)) contents = [contents];

        // Sort by key to find the latest chunk
        contents.sort((a, b) => a.Key.localeCompare(b.Key));
        const latestChunk = contents[contents.length - 1];
        
        let state = stationState.get(stationId) || { lastVolume: null, lastChunkKey: null };

        if (latestChunk.Key !== state.lastChunkKey) {
            console.log(`New chunk detected for ${stationId}: ${latestChunk.Key}`);
            state.lastChunkKey = latestChunk.Key;
            state.lastVolume = latestVolPrefix;
            stationState.set(stationId, state);

            // Fetch and parse the chunk
            const dataRes = await fetch(`${BUCKET_URL}/${latestChunk.Key}`);
            const buffer = await dataRes.arrayBuffer();
            
            try {
                // NOTE: nexrad-level-2-data might struggle with partial chunks if they lack headers.
                // However, many of these chunks are parseable as they contain the raw record structure.
                const parsed = new Level2Radar(Buffer.from(buffer));
                const extracted = extractRadialData(parsed);
                if (extracted) {
                    broadcast(stationId, { type: 'radial_update', data: extracted, chunk: latestChunk.Key });
                }
            } catch (e) {
                // Silently skip chunks that don't have enough data to form a full radar object yet
                // (e.g. metadata-only chunks or small intermediate slices)
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
                const moments = parsed[method]();
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
                    const poller = setInterval(() => pollChunks(stationId), 3000); // Poll every 3s for sub-minute updates
                    activePollers.set(stationId, poller);
                    pollChunks(stationId);
                }
            } else if (parsed.action === 'unsubscribe') {
                if (currentStation) {
                    subscriptions.get(currentStation)?.delete(ws);
                    if (subscriptions.get(currentStation)?.size === 0) {
                        clearInterval(activePollers.get(currentStation));
                        activePollers.delete(currentStation);
                        stationState.delete(currentStation);
                    }
                    currentStation = null;
                }
            }
        } catch (e) {
            console.error('Error handling message:', e);
        }
    });

    ws.onclose = () => {
        if (currentStation) {
            subscriptions.get(currentStation)?.delete(ws);
            if (subscriptions.get(currentStation)?.size === 0) {
                clearInterval(activePollers.get(currentStation));
                activePollers.delete(currentStation);
                stationState.delete(currentStation);
            }
        }
    };
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
