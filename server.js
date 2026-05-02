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
const pollingLocks = new Set(); // stationId set for locking
const stationState = new Map(); // stationId -> { lastVolume, lastChunkKey, headerChunk }
const stationCache = new Map(); // stationId -> liveRadarData object

const parser = new XMLParser();

function sendStatus(stationId, message) {
    broadcast(stationId, { type: 'status', message: `[Server] ${message}` });
}

function mergeRealTimeData(stationId, newData) {
    if (!stationCache.has(stationId)) {
        // Initialize with fixed-size structure for O(1) access
        // We use a Map keyed by rounded azimuth (1 decimal place)
        const initialState = {
            radials: new Map(), // roundedAz -> { timestamp, elevations: { e: { product: moments } } }
            stationId: stationId
        };
        stationCache.set(stationId, initialState);
    }

    const state = stationCache.get(stationId);
    
    newData.azimuths.forEach((az, i) => {
        const roundedAz = Math.round(az * 10) / 10;
        const timestamp = newData.timestamps ? newData.timestamps[i] : Date.now();
        
        if (!state.radials.has(roundedAz)) {
            state.radials.set(roundedAz, {
                azimuth: az,
                timestamp: timestamp,
                elevations: {}
            });
        }
        
        const radial = state.radials.get(roundedAz);
        radial.timestamp = timestamp; // Update to latest

        for (const [e, elevations] of Object.entries(newData.elevations)) {
            if (!radial.elevations[e]) radial.elevations[e] = {};
            for (const [product, moments] of Object.entries(elevations)) {
                radial.elevations[e][product] = moments[i];
            }
        }
    });
}

// Helper to convert the Map-based cache to the flat format the client expects
function getConsolidatedData(stationId) {
    const state = stationCache.get(stationId);
    if (!state) return null;

    const sortedAzimuths = Array.from(state.radials.keys()).sort((a, b) => a - b);
    
    const result = {
        azimuths: [],
        timestamps: [],
        elevations: {}
    };

    sortedAzimuths.forEach(az => {
        const radial = state.radials.get(az);
        result.azimuths.push(radial.azimuth);
        result.timestamps.push(radial.timestamp);
        
        for (const [e, products] of Object.entries(radial.elevations)) {
            if (!result.elevations[e]) result.elevations[e] = {};
            for (const [product, moment] of Object.entries(products)) {
                if (!result.elevations[e][product]) result.elevations[e][product] = [];
                result.elevations[e][product].push(moment);
            }
        }
    });

    return result;
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function findTrulyLatestVolume(stationId, commonPrefixes) {
    if (commonPrefixes.length === 0) return null;

    // Sort numerically: 1, 2, 3... 999
    const sorted = [...commonPrefixes].sort((a, b) => {
        const numA = parseInt(a.Prefix.split('/')[1]);
        const numB = parseInt(b.Prefix.split('/')[1]);
        return numA - numB;
    });

    const highestNumPrefix = sorted[sorted.length - 1].Prefix;
    const lowestNumPrefix = sorted[0].Prefix;

    // Peek at the first chunk of both to compare timestamps
    async function getVolTimestamp(prefix) {
        try {
            const listUrl = `${BUCKET_URL}/?list-type=2&prefix=${prefix}&max-keys=5`;
            const res = await fetchWithTimeout(listUrl);
            const json = parser.parse(await res.text());
            const contents = json.ListBucketResult.Contents;
            if (!contents) return 0;
            const firstChunk = Array.isArray(contents) ? contents[0] : contents;
            const match = firstChunk.Key.match(/(\d{8}-\d{6})/);
            if (!match) return 0;
            // Parse YYYYMMDD-HHMMSS to a comparable number or date
            return parseInt(match[1].replace('-', ''));
        } catch (e) {
            return 0;
        }
    }

    const highTs = await getVolTimestamp(highestNumPrefix);
    const lowTs = await getVolTimestamp(lowestNumPrefix);

    // If the lowest numerical folder is newer than the highest, we've wrapped around
    if (lowTs > highTs) {
        // Find the HIGHEST volume in the NEW sequence (usually only a few folders)
        let latest = lowestNumPrefix;
        let latestTs = lowTs;
        for (let i = 1; i < Math.min(sorted.length, 50); i++) {
            const currentTs = await getVolTimestamp(sorted[i].Prefix);
            if (currentTs >= latestTs) {
                latest = sorted[i].Prefix;
                latestTs = currentTs;
            } else {
                break;
            }
        }
        return latest;
    }

    return highestNumPrefix;
}

async function pollChunks(stationId) {
    if (stationId.length === 3) stationId = 'K' + stationId;
    
    const now = Date.now();
    const lockKey = `lock_${stationId}`;
    const lastPoll = stationState.get(lockKey) || 0;
    if (pollingLocks.has(stationId) && (now - lastPoll) < 60000) return;
    
    pollingLocks.add(stationId);
    stationState.set(lockKey, now);
    
    try {
        const listVolUrl = `${BUCKET_URL}/?list-type=2&prefix=${stationId}/&delimiter=/`;
        const volRes = await fetchWithTimeout(listVolUrl);
        const volJson = parser.parse(await volRes.text());
        
        let commonPrefixes = volJson.ListBucketResult.CommonPrefixes;
        if (!commonPrefixes) return;
        if (!Array.isArray(commonPrefixes)) commonPrefixes = [commonPrefixes];

        commonPrefixes = commonPrefixes.filter(p => /^[A-Z0-9]{4}\/\d+\/$/.test(p.Prefix));
        if (commonPrefixes.length === 0) return;

        // Use helper to find the truly latest volume (handles wrap-around)
        const latestVolPrefix = await findTrulyLatestVolume(stationId, commonPrefixes);
        if (!latestVolPrefix) return;

        // For transition logic, we still want to know the previous folder to catch late chunks
        const sortedNumerically = [...commonPrefixes].sort((a, b) => {
            const numA = parseInt(a.Prefix.split('/')[1]);
            const numB = parseInt(b.Prefix.split('/')[1]);
            return numA - numB;
        });
        
        const latestIdx = sortedNumerically.findIndex(p => p.Prefix === latestVolPrefix);
        const previousVolPrefix = latestIdx > 0 ? sortedNumerically[latestIdx - 1].Prefix : null;
        
        const volumesToPoll = previousVolPrefix ? [previousVolPrefix, latestVolPrefix] : [latestVolPrefix];
        let state = stationState.get(stationId) || { 
            lastVolume: null, 
            lastChunkKey: null, 
            headerChunk: null,
            processedChunks: new Set() 
        };

        if (!state.processedChunks) state.processedChunks = new Set();

        for (const volPrefix of volumesToPoll) {
            const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${volPrefix}`;
            const chunkRes = await fetchWithTimeout(listChunksUrl);
            const chunkJson = parser.parse(await chunkRes.text());
            
            let contents = chunkJson.ListBucketResult.Contents;
            if (!contents) continue;
            if (!Array.isArray(contents)) contents = [contents];
            contents.sort((a, b) => a.Key.localeCompare(b.Key));
            
            const firstChunkKey = contents[0].Key;
            const timestampMatch = firstChunkKey.match(/(\d{8}-\d{6})/);
            const volumeId = volPrefix + (timestampMatch ? timestampMatch[1] : '');

            // Detect Volume Transition (on the newest folder)
            if (volPrefix === latestVolPrefix && volumeId !== state.lastVolume) {
                console.log(`[${stationId}] Transitioning to new volume: ${volumeId}`);
                stationCache.delete(stationId);
                broadcast(stationId, { type: 'clear_data' });
                state.lastVolume = volumeId;
                state.lastChunkKey = null; 
                state.headerChunk = null;
                // DO NOT clear processedChunks here, we want to maintain the "seen" list 
                // to avoid re-processing the tail of the previous volume.
                stationState.set(stationId, state);
            }

            // Filter for truly new chunks using the Set to prevent redundant broadcasts
            const unseen = contents.filter(c => !state.processedChunks.has(c.Key));

            if (unseen.length > 0) {
                const latestKey = unseen[unseen.length - 1].Key;
                const firstId = unseen[0].Key.split('/').pop();
                const lastId = latestKey.split('/').pop();
                console.log(`[${stationId}] Vol ${volPrefix}: Processing ${unseen.length} new chunks (${firstId} to ${lastId})`);
                
                if (latestKey.includes('-E')) {
                    console.log(`[${stationId}] Vol ${volPrefix} completed.`);
                }

                if (!state.headerChunk) {
                    const headerKey = contents.find(c => c.Key.includes('-001-S'))?.Key;
                    if (headerKey) {
                        const hRes = await fetchWithTimeout(`${BUCKET_URL}/${headerKey}`);
                        state.headerChunk = await hRes.arrayBuffer();
                    }
                }

                const CONCURRENCY = 5;
                for (let i = 0; i < unseen.length; i += CONCURRENCY) {
                    const batch = unseen.slice(i, i + CONCURRENCY);
                    await Promise.all(batch.map(async (chunk) => {
                        try {
                            const chunkId = chunk.Key.split('/').pop();
                            const dataRes = await fetchWithTimeout(`${BUCKET_URL}/${chunk.Key}`);
                            const chunkBuffer = await dataRes.arrayBuffer();
                            
                            let combinedBuffer;
                            if (state.headerChunk && !chunk.Key.includes('-001-S')) {
                                combinedBuffer = Buffer.concat([Buffer.from(state.headerChunk), Buffer.from(chunkBuffer)]);
                            } else {
                                combinedBuffer = Buffer.from(chunkBuffer);
                            }

                            const parsed = new Level2Radar(combinedBuffer);
                            const extracted = extractRadialData(parsed, stationId, chunkId);
                            if (extracted && extracted.azimuths.length > 0) {
                                mergeRealTimeData(stationId, extracted);
                                broadcast(stationId, { 
                                    type: 'radial_update', 
                                    data: extracted, 
                                    chunk: chunkId 
                                });
                            }
                            // Mark as processed
                            state.processedChunks.add(chunk.Key);
                            
                            // Prevent memory leak by capping Set size
                            if (state.processedChunks.size > 1000) {
                                const firstKey = state.processedChunks.values().next().value;
                                state.processedChunks.delete(firstKey);
                            }
                        } catch (e) {
                            console.warn(`[${stationId}] Chunk ${chunk.Key} error: ${e.message}`);
                            state.processedChunks.add(chunk.Key);
                        }
                    }));
                }
                
                if (volPrefix === latestVolPrefix) {
                    state.lastChunkKey = latestKey;
                    stationState.set(stationId, state);
                }
            }
        }
    } catch (e) {
        console.error(`[${stationId}] Poll error:`, e.message);
    } finally {
        pollingLocks.delete(stationId);
    }
}

function extractRadialData(parsed, stationId, chunkId) {
    const elevations = [1, 2, 3, 4, 5];
    let azimuths = null;
    let timestamps = null;
    const extractedElevations = {};

    const methodGroups = {
        reflectivity: ['getHighresReflectivity', 'getReflectivity'],
        velocity: ['getHighresVelocity', 'getVelocity'],
        debris: ['getHighresCorrelationCoefficient', 'getCorrelationCoefficient']
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
            
            for (const [productKey, methodList] of Object.entries(methodGroups)) {
                let moments = null;
                // Try each method in the group until we find data
                for (const methodName of methodList) {
                    if (typeof parsed[methodName] === 'function') {
                        moments = parsed[methodName]();
                        if (moments && moments.some(m => m && m.moment_data)) {
                            break; // Found data with this method
                        }
                    }
                }

                if (moments && moments.some(m => m && m.moment_data)) {
                    hasAnyData = true;
                    elevationHasData = true;
                    elevationProducts[productKey] = moments.map(m => m ? {
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
            // Only log if it's not a simple 'no data for elevation' error
            if (!err.message.includes('No data for elevation')) {
                // console.warn(`[${stationId}] ${chunkId} Elev ${e} error: ${err.message}`);
            }
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
                    }
                }

                currentStation = stationId;
                if (!subscriptions.has(stationId)) subscriptions.set(stationId, new Set());
                subscriptions.get(stationId).add(ws);

                // 1. ALWAYS send initial state if we have it in the cache
                if (stationCache.has(stationId)) {
                    ws.send(JSON.stringify({ type: 'initial_state', data: getConsolidatedData(stationId) }));
                }

                // 2. Start or trigger the poller
                if (!activePollers.has(stationId)) {
                    const poller = setInterval(() => pollChunks(stationId), 1000); 
                    activePollers.set(stationId, poller);
                    pollChunks(stationId);
                }
                
                ws.send(JSON.stringify({ type: 'status', message: `Subscribed to real-time chunks for ${stationId}` }));
            } else if (parsed.action === 'unsubscribe') {
                if (currentStation) {
                    subscriptions.get(currentStation)?.delete(ws);
                    if (subscriptions.get(currentStation)?.size === 0) {
                        clearInterval(activePollers.get(currentStation));
                        activePollers.delete(currentStation);
                    }
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
