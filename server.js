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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 80;
const NEXRAD_DATA_DIR = process.env.NEXRAD_DATA_DIR || '/data/nexrad/level2';

app.use(cors());
app.use(compression());
app.use(express.static(path.join(__dirname, '/')));

const subscriptions = new Map();
const activeWatchers = new Map();
const stationState = new Map(); // stationId -> { lastVolume, lastChunkKey, headerChunk }
const stationCache = new Map(); // stationId -> liveRadarData object

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

                // Start or trigger the watcher
                watchStation(stationId);
                
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
