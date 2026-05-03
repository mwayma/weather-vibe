// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const compression = require('compression');
const cors = require('cors');
const { Level2Radar } = require('nexrad-level-2-data');
const { XMLParser } = require('fast-xml-parser');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 80;
const NEXRAD_DATA_DIR = process.env.NEXRAD_DATA_DIR || '/data/nexrad/level2';
const BUCKET_URL = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';

app.use(cors());
app.use(compression());
app.use(express.static(path.join(__dirname, '/')));

const subscriptions = new Map();
const activeWatchers = new Map();
const activePollers = new Map();
const pollingLocks = new Set();
const stationState = new Map(); // stationId -> { lastVolume, lastChunkKey, headerChunk, processedChunks }
const stationCache = new Map(); // stationId -> liveRadarData object

const parser = new XMLParser();
const VOLUME_DISCOVERY_INTERVAL_MS = 30000;
const RADIAL_BATCH_SIZE = 20;
const RADIAL_BATCH_SPACING_MS = 35;
const MAX_CLIENT_BUFFERED_BYTES = 10 * 1024 * 1024;
const MAX_CLIENT_BUFFERED_BYTES_BEFORE_CLOSE = 50 * 1024 * 1024;

function normalizeStationId(stationId) {
    if (!stationId) return stationId;
    stationId = stationId.toUpperCase();
    return stationId.length === 3 ? `K${stationId}` : stationId;
}

function getKeyTimestamp(key) {
    const match = key && key.match(/(\d{8})[-_](\d{6})/);
    if (!match) return 0;
    return Date.UTC(
        Number(match[1].slice(0, 4)),
        Number(match[1].slice(4, 6)) - 1,
        Number(match[1].slice(6, 8)),
        Number(match[2].slice(0, 2)),
        Number(match[2].slice(2, 4)),
        Number(match[2].slice(4, 6))
    );
}

function getChunkOrder(key) {
    const fileName = key.split('/').pop();
    if (/_S(?:\.\w+)?$/.test(fileName) || /-S(?:\.\w+)?$/.test(fileName)) return 0;
    const intermediate = fileName.match(/[_-]I(\d+)(?:\.\w+)?$/);
    if (intermediate) return Number(intermediate[1]);
    if (/[_-]E(?:\.\w+)?$/.test(fileName)) return Number.MAX_SAFE_INTEGER;
    const trailingNumber = fileName.match(/(\d+)(?:\.\w+)?$/);
    return trailingNumber ? Number(trailingNumber[1]) : Number.MAX_SAFE_INTEGER - 1;
}

function isStartChunk(key) {
    const fileName = key.split('/').pop();
    return /[_-]S(?:\.\w+)?$/.test(fileName);
}

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

function broadcastRadialBatches(stationId, radials) {
    for (let i = 0; i < radials.length; i += RADIAL_BATCH_SIZE) {
        const batch = radials.slice(i, i + RADIAL_BATCH_SIZE);
        broadcast(stationId, {
            type: 'radial_batch',
            stationId: stationId,
            radials: batch,
            latestAzimuth: batch[batch.length - 1].azimuth
        });
    }
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
            const chunkList = Array.isArray(contents) ? contents : [contents];
            return Math.max(...chunkList.map(chunk => getKeyTimestamp(chunk.Key)));
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

async function getVolumeTimestamp(prefix) {
    try {
        const listUrl = `${BUCKET_URL}/?list-type=2&prefix=${prefix}&max-keys=3`;
        const res = await fetchWithTimeout(listUrl);
        const json = parser.parse(await res.text());
        const contents = json.ListBucketResult.Contents;
        if (!contents) return 0;
        const chunkList = Array.isArray(contents) ? contents : [contents];
        return Math.max(...chunkList.map(chunk => getKeyTimestamp(chunk.Key)));
    } catch (e) {
        return 0;
    }
}

async function discoverLatestVolumeByKeys(stationId) {
    let continuationToken = null;
    let best = null;
    let pages = 0;

    do {
        const token = continuationToken ? `&continuation-token=${encodeURIComponent(continuationToken)}` : '';
        const listUrl = `${BUCKET_URL}/?list-type=2&prefix=${stationId}/${token}`;
        const res = await fetchWithTimeout(listUrl);
        const json = parser.parse(await res.text());
        const result = json.ListBucketResult;
        let contents = result.Contents;

        if (contents) {
            if (!Array.isArray(contents)) contents = [contents];
            for (const item of contents) {
                const timestamp = getKeyTimestamp(item.Key);
                if (!timestamp) continue;
                const match = item.Key.match(/^([A-Z0-9]{4}\/\d+\/)/);
                if (!match) continue;
                if (!best || timestamp > best.timestamp) {
                    best = { prefix: match[1], timestamp };
                }
            }
        }

        continuationToken = result.IsTruncated ? result.NextContinuationToken : null;
        pages++;
    } while (continuationToken && pages < 50);

    return best;
}

async function chooseLatestVolume(stationId, commonPrefixes, state, now) {
    const prefixesByNumber = [...commonPrefixes].sort((a, b) => {
        const numA = parseInt(a.Prefix.split('/')[1]);
        const numB = parseInt(b.Prefix.split('/')[1]);
        return numA - numB;
    });

    if (!state.latestVolPrefix || !state.lastVolumeDiscovery || (now - state.lastVolumeDiscovery) > VOLUME_DISCOVERY_INTERVAL_MS) {
        const discovered = await discoverLatestVolumeByKeys(stationId);
        if (discovered) {
            state.latestVolPrefix = discovered.prefix;
            state.latestVolTimestamp = discovered.timestamp;
            state.lastVolumeDiscovery = now;
        }
    }

    if (!state.latestVolPrefix) {
        state.latestVolPrefix = await findTrulyLatestVolume(stationId, commonPrefixes);
        state.latestVolTimestamp = state.latestVolPrefix ? await getVolumeTimestamp(state.latestVolPrefix) : 0;
        state.lastVolumeDiscovery = now;
    }

    const candidates = new Set();
    if (state.latestVolPrefix) candidates.add(state.latestVolPrefix);

    const latestIdx = prefixesByNumber.findIndex(p => p.Prefix === state.latestVolPrefix);
    if (latestIdx >= 0) {
        candidates.add(prefixesByNumber[(latestIdx + 1) % prefixesByNumber.length].Prefix);
        candidates.add(prefixesByNumber[(latestIdx - 1 + prefixesByNumber.length) % prefixesByNumber.length].Prefix);
    }

    for (const prefix of candidates) {
        const timestamp = await getVolumeTimestamp(prefix);
        if (timestamp && (!state.latestVolTimestamp || timestamp > state.latestVolTimestamp)) {
            state.latestVolPrefix = prefix;
            state.latestVolTimestamp = timestamp;
        }
    }

    return state.latestVolPrefix;
}

async function pollChunks(stationId) {
    stationId = normalizeStationId(stationId);
    
    const now = Date.now();
    const lockKey = `lock_${stationId}`;
    const lastPoll = stationState.get(lockKey) || 0;
    if (pollingLocks.has(stationId) && (now - lastPoll) < 30000) return;
    
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

        let state = stationState.get(stationId) || { 
            lastVolume: null, 
            lastChunkKey: null, 
            headerChunk: null,
            processedChunks: new Set(),
            latestVolPrefix: null,
            latestVolTimestamp: 0,
            lastVolumeDiscovery: 0
        };

        if (!state.processedChunks) state.processedChunks = new Set();

        const latestVolPrefix = await chooseLatestVolume(stationId, commonPrefixes, state, now);
        if (!latestVolPrefix) return;
        stationState.set(stationId, state);

        const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${latestVolPrefix}`;
        const chunkRes = await fetchWithTimeout(listChunksUrl);
        const chunkJson = parser.parse(await chunkRes.text());
        
        let contents = chunkJson.ListBucketResult.Contents;
        if (!contents) return;
        if (!Array.isArray(contents)) contents = [contents];
        contents.sort((a, b) => {
            const timeDiff = getKeyTimestamp(a.Key) - getKeyTimestamp(b.Key);
            if (timeDiff !== 0) return timeDiff;
            return getChunkOrder(a.Key) - getChunkOrder(b.Key);
        });
        
        const firstChunkKey = contents[0].Key;
        const volumeId = `${latestVolPrefix}${getKeyTimestamp(firstChunkKey) || firstChunkKey}`;

        if (volumeId !== state.lastVolume) {
            console.log(`[${stationId}] Transitioning to new volume (S3): ${volumeId}`);
            state.lastVolume = volumeId;
            state.headerChunk = null;
            broadcast(stationId, { type: 'clear_data', stationId, volumeId });
            stationState.set(stationId, state);
        }

        const unseen = contents.filter(c => !state.processedChunks.has(c.Key));

        if (unseen.length > 0) {
            if (!state.headerChunk) {
                const headerKey = contents.find(c => isStartChunk(c.Key))?.Key;
                if (headerKey) {
                    const hRes = await fetchWithTimeout(`${BUCKET_URL}/${headerKey}`);
                    state.headerChunk = await hRes.arrayBuffer();
                }
            }

            for (const chunk of unseen) {
                try {
                    const chunkId = chunk.Key.split('/').pop();
                    const dataRes = await fetchWithTimeout(`${BUCKET_URL}/${chunk.Key}`);
                    const chunkBuffer = await dataRes.arrayBuffer();
                    
                    let combinedBuffer;
                    if (state.headerChunk && !isStartChunk(chunk.Key)) {
                        combinedBuffer = Buffer.concat([Buffer.from(state.headerChunk), Buffer.from(chunkBuffer)]);
                    } else {
                        combinedBuffer = Buffer.from(chunkBuffer);
                    }

                    const parsed = new Level2Radar(combinedBuffer);
                    const extracted = extractRadialData(parsed, stationId, chunkId);
                    const radials = extractedToRadials(extracted);
                    
                    state.processedChunks.add(chunk.Key);
                    if (state.processedChunks.size > 1000) {
                        const first = state.processedChunks.values().next().value;
                        state.processedChunks.delete(first);
                    }

                    if (radials.length > 0) {
                        radials.sort((a, b) => a.timestamp - b.timestamp);
                        mergeRadialsIntoCache(stationId, radials);
                        broadcastRadialBatches(stationId, radials);
                    }
                } catch (e) {
                    state.processedChunks.add(chunk.Key);
                }
            }
            stationState.set(stationId, state);
        }
    } catch (e) {
        console.error(`[${stationId}] S3 Poll error:`, e.message);
    } finally {
        pollingLocks.delete(stationId);
    }
}

async function processLocalFile(stationId, filePath) {
    stationId = normalizeStationId(stationId);
    const fileName = path.basename(filePath);
    
    let state = stationState.get(stationId) || { 
        lastVolume: null, 
        lastChunkKey: null, 
        headerChunk: null,
        processedChunks: new Set()
    };

    if (state.processedChunks.has(fileName)) return;

    try {
        const chunkBuffer = fs.readFileSync(filePath);
        
        // Volume detection based on filename pattern: KDAX_20260503_120000_V06_S
        const volumeMatch = fileName.match(/([A-Z0-9]{4}_\d{8}_\d{6})/);
        const volumeId = volumeMatch ? volumeMatch[1] : 'unknown';

        if (volumeId !== state.lastVolume) {
            console.log(`[${stationId}] New volume detected: ${volumeId}`);
            state.lastVolume = volumeId;
            state.headerChunk = null;
            broadcast(stationId, { type: 'clear_data', stationId, volumeId });
        }

        if (isStartChunk(fileName)) {
            state.headerChunk = chunkBuffer;
        }

        let combinedBuffer;
        if (state.headerChunk && !isStartChunk(fileName)) {
            combinedBuffer = Buffer.concat([Buffer.from(state.headerChunk), Buffer.from(chunkBuffer)]);
        } else {
            combinedBuffer = Buffer.from(chunkBuffer);
        }

        const parsed = new Level2Radar(combinedBuffer);
        const extracted = extractRadialData(parsed, stationId, fileName);
        const radials = extractedToRadials(extracted);
        
        state.processedChunks.add(fileName);
        if (state.processedChunks.size > 1000) {
            const first = state.processedChunks.values().next().value;
            state.processedChunks.delete(first);
        }

        if (radials.length > 0) {
            radials.sort((a, b) => a.timestamp - b.timestamp);
            mergeRadialsIntoCache(stationId, radials);
            broadcastRadialBatches(stationId, radials);
        }
        
        stationState.set(stationId, state);
    } catch (e) {
        // Silently fail for partial writes
    }
}

function watchStation(stationId) {
    stationId = normalizeStationId(stationId);
    if (activeWatchers.has(stationId)) return;

    const stationDir = path.join(NEXRAD_DATA_DIR, stationId);
    if (!fs.existsSync(stationDir)) {
        fs.mkdirSync(stationDir, { recursive: true });
    }
    
    console.log(`Starting watcher for ${stationId} at ${stationDir}`);

    const watcher = chokidar.watch(stationDir, {
        persistent: true,
        ignoreInitial: false,
        depth: 2
    });

    watcher.on('add', (filePath) => {
        processLocalFile(stationId, filePath);
    });

    activeWatchers.set(stationId, watcher);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractedToRadials(extracted) {
    if (!extracted || !extracted.azimuths || extracted.azimuths.length === 0) return [];

    return extracted.azimuths.map((az, i) => {
        const radialData = {
            azimuth: az,
            timestamp: extracted.timestamps[i],
            elevations: {}
        };

        for (const [e, products] of Object.entries(extracted.elevations)) {
            radialData.elevations[e] = {};
            for (const [product, moments] of Object.entries(products)) {
                radialData.elevations[e][product] = moments[i];
            }
        }

        return radialData;
    });
}

function mergeRadialsIntoCache(stationId, radials) {
    if (!radials || radials.length === 0) return;

    if (!stationCache.has(stationId)) {
        stationCache.set(stationId, { radials: new Map(), stationId });
    }

    const cache = stationCache.get(stationId);

    radials.forEach(radial => {
        const roundedAz = Math.round(radial.azimuth * 10) / 10;
        
        if (!cache.radials.has(roundedAz)) {
            cache.radials.set(roundedAz, {
                azimuth: radial.azimuth,
                timestamp: radial.timestamp,
                elevations: {}
            });
        }
        
        const cachedRadial = cache.radials.get(roundedAz);
        cachedRadial.timestamp = radial.timestamp;

        for (const [e, products] of Object.entries(radial.elevations)) {
            if (!cachedRadial.elevations[e]) cachedRadial.elevations[e] = {};
            for (const [product, moment] of Object.entries(products)) {
                cachedRadial.elevations[e][product] = moment;
            }
        }
    });
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
                if (data.type === 'radial_batch') {
                    if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES_BEFORE_CLOSE) {
                        console.warn(`[${stationId}] Closing slow client with ${client.bufferedAmount} buffered bytes`);
                        client.terminate();
                        return;
                    }
                    if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
                        return;
                    }
                }
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
                        const watcher = activeWatchers.get(currentStation);
                        if (watcher) {
                            watcher.close();
                            activeWatchers.delete(currentStation);
                        }
                    }
                }

                currentStation = stationId;
                if (!subscriptions.has(stationId)) subscriptions.set(stationId, new Set());
                subscriptions.get(stationId).add(ws);

                // Initial state
                if (parsed.initial !== false && stationCache.has(stationId)) {
                    ws.send(JSON.stringify({ 
                        type: 'initial_state', 
                        stationId: stationId,
                        data: getConsolidatedData(stationId) 
                    }));
                }

                // Start or trigger the watcher and poller
                watchStation(stationId);
                if (!activePollers.has(stationId)) {
                    const poller = setInterval(() => pollChunks(stationId), 5000);
                    activePollers.set(stationId, poller);
                    pollChunks(stationId);
                }
                
                ws.send(JSON.stringify({ type: 'status', message: `Subscribed to real-time chunks for ${stationId}` }));
            } else if (parsed.action === 'unsubscribe') {
                if (currentStation) {
                    subscriptions.get(currentStation)?.delete(ws);
                    if (subscriptions.get(currentStation)?.size === 0) {
                        const watcher = activeWatchers.get(currentStation);
                        if (watcher) {
                            watcher.close();
                            activeWatchers.delete(currentStation);
                        }
                        const poller = activePollers.get(currentStation);
                        if (poller) {
                            clearInterval(poller);
                            activePollers.delete(currentStation);
                        }
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
                const watcher = activeWatchers.get(currentStation);
                if (watcher) {
                    watcher.close();
                    activeWatchers.delete(currentStation);
                }
                const poller = activePollers.get(currentStation);
                if (poller) {
                    clearInterval(poller);
                    activePollers.delete(currentStation);
                }
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
