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
const stationCache = new Map(); // stationId -> liveRadarData object

const parser = new XMLParser();

function sendStatus(stationId, message) {
    broadcast(stationId, { type: 'status', message: `[Server] ${message}` });
}

function mergeRealTimeData(stationId, newData) {
    if (!stationCache.has(stationId)) {
        // Deep copy the initial state to prevent mutating the original reference if needed
        stationCache.set(stationId, JSON.parse(JSON.stringify(newData)));
        return;
    }

    const liveRadarData = stationCache.get(stationId);
    
    newData.azimuths.forEach((az, i) => {
        const roundedAz = Math.round(az * 10) / 10;
        const existingIdx = liveRadarData.azimuths.findIndex(a => Math.round(a * 10) / 10 === roundedAz);
        
        if (existingIdx !== -1) {
            // Update timestamp
            if (newData.timestamps && newData.timestamps[i]) {
                liveRadarData.timestamps[existingIdx] = newData.timestamps[i];
            }
            for (const [e, elevations] of Object.entries(newData.elevations)) {
                for (const [product, moments] of Object.entries(elevations)) {
                    if (liveRadarData.elevations[e] && liveRadarData.elevations[e][product]) {
                        liveRadarData.elevations[e][product][existingIdx] = moments[i];
                    }
                }
            }
        } else {
            // Add new azimuth and keep arrays synchronized
            liveRadarData.azimuths.push(az);
            if (newData.timestamps && newData.timestamps[i]) {
                if (!liveRadarData.timestamps) liveRadarData.timestamps = [];
                liveRadarData.timestamps.push(newData.timestamps[i]);
            } else if (liveRadarData.timestamps) {
                liveRadarData.timestamps.push(Date.now());
            }
            
            for (const [e, elevations] of Object.entries(newData.elevations)) {
                for (const [product, moments] of Object.entries(elevations)) {
                    if (liveRadarData.elevations[e] && liveRadarData.elevations[e][product]) {
                        liveRadarData.elevations[e][product].push(moments[i]);
                    }
                }
            }
        }
    });

    // OPTIMIZATION: Keep azimuths sorted to allow for faster range searches in the client
    const indices = liveRadarData.azimuths.map((_, i) => i);
    indices.sort((a, b) => liveRadarData.azimuths[a] - liveRadarData.azimuths[b]);
    
    const sortedAz = indices.map(i => liveRadarData.azimuths[i]);
    const sortedTs = liveRadarData.timestamps ? indices.map(i => liveRadarData.timestamps[i]) : null;
    
    const sortedElevations = {};
    for (const [e, products] of Object.entries(liveRadarData.elevations)) {
        sortedElevations[e] = {};
        for (const [product, moments] of Object.entries(products)) {
            sortedElevations[e][product] = indices.map(i => moments[i]);
        }
    }
    
    liveRadarData.azimuths = sortedAz;
    if (sortedTs) liveRadarData.timestamps = sortedTs;
    liveRadarData.elevations = sortedElevations;
}

async function pollChunks(stationId) {
    try {
        const listVolUrl = `${BUCKET_URL}/?list-type=2&prefix=${stationId}/&delimiter=/`;
        const volRes = await fetch(listVolUrl);
        const volText = await volRes.text();
        const volJson = parser.parse(volText);
        
        let commonPrefixes = volJson.ListBucketResult.CommonPrefixes;
        if (!commonPrefixes) return;
        if (!Array.isArray(commonPrefixes)) commonPrefixes = [commonPrefixes];

        // Correct lexicographical sort for prefix timestamps (YYYYMMDD-HHMMSS)
        commonPrefixes.sort((a, b) => a.Prefix.localeCompare(b.Prefix));
        
        const latestVolPrefix = commonPrefixes[commonPrefixes.length - 1].Prefix;
        let state = stationState.get(stationId) || { lastVolume: null, lastChunkKey: null, headerChunk: null };

        // Handle volume transition
        if (latestVolPrefix !== state.lastVolume) {
            console.log(`[${stationId}] New volume detected: ${latestVolPrefix}`);
            sendStatus(stationId, `New volume: ${latestVolPrefix.split('/')[1]}`);
            stationCache.delete(stationId);
            broadcast(stationId, { type: 'clear_data' });
            state.lastVolume = latestVolPrefix;
            state.lastChunkKey = null; // Start fresh in new volume
            state.headerChunk = null;
        }

        const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${latestVolPrefix}`;
        const chunkRes = await fetch(listChunksUrl);
        const chunkText = await chunkRes.text();
        const chunkJson = parser.parse(chunkText);
        
        let contents = chunkJson.ListBucketResult.Contents;
        if (!contents) {
            // console.log(`No chunks found in volume ${latestVolPrefix}`);
            return;
        }
        if (!Array.isArray(contents)) contents = [contents];

        contents.sort((a, b) => a.Key.localeCompare(b.Key));
        
        // Find all chunks we haven't seen yet in this volume
        const unseen = contents.filter(c => !state.lastChunkKey || c.Key.localeCompare(state.lastChunkKey) > 0);

        if (unseen.length > 0) {
            console.log(`[${stationId}] Processing ${unseen.length} new chunks`);
            
            // If new volume, we MUST get the header chunk (001-S)
            if (!state.headerChunk) {
                const headerKey = contents.find(c => c.Key.endsWith('-001-S'))?.Key;
                if (headerKey) {
                    console.log(`[${stationId}] Fetching header chunk: ${headerKey}`);
                    const hRes = await fetch(`${BUCKET_URL}/${headerKey}`);
                    state.headerChunk = await hRes.arrayBuffer();
                }
            }

            for (const chunk of unseen) {
                const chunkId = chunk.Key.split('/').pop();
                // console.log(`[${stationId}] Fetching chunk: ${chunkId}`);
                const dataRes = await fetch(`${BUCKET_URL}/${chunk.Key}`);
                const chunkBuffer = await dataRes.arrayBuffer();
                
                try {
                    let combinedBuffer;
                    if (state.headerChunk && !chunk.Key.endsWith('-001-S')) {
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
                        console.log(`[${stationId}] Parsed chunk ${chunkId}: ${extracted.azimuths.length} radials`);
                        mergeRealTimeData(stationId, extracted);
                        broadcast(stationId, { 
                            type: 'radial_update', 
                            data: extracted, 
                            chunk: chunkId 
                        });
                    } else {
                        // console.log(`[${stationId}] Chunk ${chunkId} contained no relevant data`);
                    }
                } catch (e) {
                    console.warn(`[${stationId}] Chunk parse error (${chunkId}): ${e.message}`);
                }
            }
            state.lastChunkKey = unseen[unseen.length - 1].Key;
            stationState.set(stationId, state);
        }
    } catch (e) {
        console.error(`Error polling chunks for ${stationId}:`, e.message);
    }
}

function extractRadialData(parsed) {
    const elevations = [1, 2, 3, 4, 5];
    let azimuths = null;
    let timestamps = null;
    const extractedElevations = {};

    const methods = {
        reflectivity: 'getHighresReflectivity',
        velocity: 'getHighresVelocity',
        debris: 'getHighresCorrelationCoefficient'
    };

    let hasAnyData = false;
    for (const e of elevations) {
        try {
            parsed.setElevation(e);
            
            // Capture azimuths and timestamps from the first valid elevation
            if (!azimuths) {
                azimuths = parsed.getAzimuth();
                const headers = parsed.getHeader();
                if (Array.isArray(headers)) {
                    timestamps = headers.map(h => (h.julian_date - 1) * 86400000 + h.mseconds);
                }
            }

            const elevationProducts = {};
            let elevationHasData = false;
            for (const [key, method] of Object.entries(methods)) {
                const moments = parsed[method]();
                if (moments && moments.some(m => m && m.moment_data)) {
                    hasAnyData = true;
                    elevationHasData = true;
                    elevationProducts[key] = moments.map(m => m ? {
                        moment_data: m.moment_data,
                        first_gate: m.first_gate,
                        gate_size: m.gate_size
                    } : null);
                }
            }
            if (elevationHasData) {
                extractedElevations[e] = elevationProducts;
            }
        } catch (err) {
            // console.error(`Error extracting elevation ${e}:`, err.message);
        }
    }

    if (!hasAnyData) return null;

    return {
        azimuths: azimuths || [],
        timestamps: timestamps || [],
        elevations: extractedElevations
    };
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
                    const poller = setInterval(() => pollChunks(stationId), 2000); // More aggressive polling (2s)
                    activePollers.set(stationId, poller);
                    pollChunks(stationId);
                } else if (stationCache.has(stationId)) {
                    ws.send(JSON.stringify({ type: 'initial_state', data: stationCache.get(stationId) }));
                }
                
                ws.send(JSON.stringify({ type: 'status', message: `Subscribed to real-time chunks for ${stationId}` }));
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
