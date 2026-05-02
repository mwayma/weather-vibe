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
const lastProcessedChunk = new Map(); // stationId -> last chunk key

const parser = new XMLParser();

async function pollChunks(stationId) {
    try {
        const url = `${BUCKET_URL}/?list-type=2&prefix=${stationId}/1/`;
        const res = await fetch(url);
        const text = await res.text();
        const jsonObj = parser.parse(text);
        
        let contents = jsonObj.ListBucketResult.Contents;
        if (!contents) return;
        if (!Array.isArray(contents)) contents = [contents];

        // Sort by key (which contains datetime and chunk number)
        contents.sort((a, b) => a.Key.localeCompare(b.Key));
        
        const latest = contents[contents.length - 1];
        const lastSeen = lastProcessedChunk.get(stationId);

        if (latest.Key !== lastSeen) {
            console.log(`New chunk detected for ${stationId}: ${latest.Key}`);
            lastProcessedChunk.set(stationId, latest.Key);
            
            const chunkRes = await fetch(`${BUCKET_URL}/${latest.Key}`);
            const buffer = await chunkRes.arrayBuffer();
            
            try {
                const parsed = new Level2Radar(Buffer.from(buffer));
                const extracted = extractRadialData(parsed);
                if (extracted) {
                    broadcast(stationId, { type: 'radial_update', data: extracted, chunk: latest.Key });
                }
            } catch (e) {
                console.error(`Error parsing chunk ${latest.Key}:`, e.message);
            }
        }
    } catch (e) {
        console.error(`Error polling chunks for ${stationId}:`, e.message);
    }
}

function extractRadialData(parsed) {
    const elevations = [1, 2, 3, 4, 5];
    const extracted = {
        azimuths: parsed.getAzimuth(),
        elevations: {}
    };

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
                        lastProcessedChunk.delete(currentStation);
                    }
                }

                currentStation = stationId;
                if (!subscriptions.has(stationId)) subscriptions.set(stationId, new Set());
                subscriptions.get(stationId).add(ws);

                if (!activePollers.has(stationId)) {
                    const poller = setInterval(() => pollChunks(stationId), 5000); // Check every 5s
                    activePollers.set(stationId, poller);
                    pollChunks(stationId);
                }
            } else if (parsed.action === 'unsubscribe') {
                console.log('Client unsubscribing');
                if (currentStation) {
                    subscriptions.get(currentStation)?.delete(ws);
                    if (subscriptions.get(currentStation)?.size === 0) {
                        clearInterval(activePollers.get(currentStation));
                        activePollers.delete(currentStation);
                        lastProcessedChunk.delete(currentStation);
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
                lastProcessedChunk.delete(currentStation);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
