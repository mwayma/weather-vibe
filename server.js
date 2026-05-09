// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const compression = require('compression');
const cors = require('cors');
const { Level2Radar } = require('nexrad-level-2-data');
const { XMLParser } = require('fast-xml-parser');
const NEXRAD_STATIONS = require('./data/nexrad_stations.json');
const COUNTIES = require('./data/counties.json');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 80;
const BUCKET_URL = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(compression());
app.use(express.static(path.join(__dirname, '/')));

const subscriptions = new Map();
const activePollers = new Map();
const pollingLocks = new Set(); // stationId set for locking
const stationState = new Map(); // stationId -> { lastVolume, lastChunkKey, headerChunk }
const stationCache = new Map(); // stationId -> liveRadarData object
const stationHealth = new Map(); // stationId -> last feed_health payload
const gridTemperatureCache = new Map(); // rounded lat/lon -> latest NDFD point sample
const gridTemperatureInflight = new Map(); // rounded lat/lon -> Promise

const parser = new XMLParser();
const VOLUME_DISCOVERY_INTERVAL_MS = 15000;
const LIVE_RADAR_CACHE_MAX_AGE_MS = Number(process.env.LIVE_RADAR_CACHE_MAX_AGE_MS) || 10 * 60 * 1000;
const FEED_HEALTH_VOLUME_DEGRADED_MS = Number(process.env.FEED_HEALTH_VOLUME_DEGRADED_MS) || 12 * 60 * 1000;
const FEED_HEALTH_VOLUME_OUTAGE_MS = Number(process.env.FEED_HEALTH_VOLUME_OUTAGE_MS) || 25 * 60 * 1000;
const FEED_HEALTH_NO_CHUNKS_DEGRADED_MS = Number(process.env.FEED_HEALTH_NO_CHUNKS_DEGRADED_MS) || 3 * 60 * 1000;
const FEED_HEALTH_NO_CHUNKS_OUTAGE_MS = Number(process.env.FEED_HEALTH_NO_CHUNKS_OUTAGE_MS) || 10 * 60 * 1000;
const FEED_HEALTH_REBROADCAST_MS = 60 * 1000;
const RADIAL_BATCH_SIZE = 10;
const RADIAL_BATCH_SPACING_MS = 0;
const MAX_CLIENT_BUFFERED_BYTES = 10 * 1024 * 1024;
const MAX_CLIENT_BUFFERED_BYTES_BEFORE_CLOSE = 50 * 1024 * 1024;
const DERIVED_FEATURE_INTERVAL_MS = 8000;
const DERIVED_FEATURE_MAX_RANGE_KM = 180;
const DERIVED_FEATURE_MIN_RANGE_KM = 12;
const ROTATION_MAX_RANGE_KM = 120;
const ROTATION_LOW_CONFIDENCE_RANGE_KM = 90;
const DERIVED_FEATURE_GRID_DEG = 0.12;
const REFLECTIVITY_CORE_DBZ = 50;
const HAIL_SIGNAL_DBZ = 60;
const ROTATION_VELOCITY_DELTA = 60;
const ROTATION_MIN_SIDE_VELOCITY = 25;
const ROTATION_SUPPORT_GATES = 2;
const GRID_TEMPERATURE_TTL_MS = Number(process.env.GRID_TEMPERATURE_TTL_MS) || 20 * 60 * 1000;
const MAX_WEATHER_BATCH_SIZE = 50;
const GRID_TEMPERATURE_CONCURRENCY = Number(process.env.GRID_TEMPERATURE_CONCURRENCY) || 4;
const GRID_TEMPERATURE_CELL_DEG = Number(process.env.GRID_TEMPERATURE_CELL_DEG) || 0.05;
const NDFD_TEMP_IDENTIFY_URL = 'https://mapservices.weather.noaa.gov/raster/rest/services/NDFD/NDFD_temp/MapServer/identify';
const NDFD_TEMP_IMAGE_LAYER_IDS = [8, 12, 16, 20, 24, 28, 32, 36, 40];

// Auto-prime KLZK when tornado/severe thunderstorm watches or warnings affect its radar area.
const AUTO_PRIME_STATION = 'KLZK';
const AUTO_PRIME_RADIUS_KM = Number(process.env.AUTO_PRIME_RADIUS_KM) || 230;
const AUTO_PRIME_STATE_FIPS = new Set((process.env.AUTO_PRIME_STATE_FIPS || '05').split(',').map(value => value.trim()).filter(Boolean));
const AUTO_PRIME_POLL_INTERVAL_MS = Number(process.env.AUTO_PRIME_POLL_INTERVAL_MS) || 5000;
const ALERT_POLL_INTERVAL_MS = 60 * 1000;
const serverSubscriptions = new Set(); // Internal "virtual" subscriptions for auto-priming
const STATE_POSTAL_FIPS = {
    AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', FL: '12', GA: '13',
    HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
    MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34',
    NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45',
    SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56'
};

function normalizeStationId(stationId) {
    if (!stationId) return stationId;
    stationId = stationId.toUpperCase();
    return stationId.length === 3 ? `K${stationId}` : stationId;
}

function statePostalToFips(postal) {
    return STATE_POSTAL_FIPS[String(postal || '').toUpperCase()] || null;
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

function classifyFetchError(error) {
    if (error?.name === 'AbortError') return 'timeout';
    const status = Number(error?.status);
    if (status === 429) return 'rate_limited';
    if (status === 403) return 'access_denied';
    if (status >= 500) return 'upstream_error';
    if (status >= 400) return 'request_error';
    return 'network_error';
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
}

function setFeedHealth(stationId, status, reason, details = {}) {
    const now = Date.now();
    const prior = stationHealth.get(stationId);
    const payload = {
        type: 'feed_health',
        stationId,
        status,
        reason,
        checkedAt: now,
        ...details
    };

    const changed = !prior || prior.status !== status || prior.reason !== reason;
    const rebroadcast = !prior || (now - (prior.checkedAt || 0)) > FEED_HEALTH_REBROADCAST_MS;
    stationHealth.set(stationId, payload);
    if (changed || rebroadcast) broadcast(stationId, payload);
}

function assessFeedFreshness(stationId, state, now = Date.now()) {
    if (!state) return;

    if (state.latestVolTimestamp) {
        const ageMs = now - state.latestVolTimestamp;
        if (ageMs > FEED_HEALTH_VOLUME_OUTAGE_MS) {
            setFeedHealth(stationId, 'outage', `Latest S3 volume is ${formatDuration(ageMs)} old`, { ageMs });
            return;
        }
        if (ageMs > FEED_HEALTH_VOLUME_DEGRADED_MS) {
            setFeedHealth(stationId, 'degraded', `Latest S3 volume is ${formatDuration(ageMs)} old`, { ageMs });
            return;
        }
    }

    if (state.lastChunkSeenAt) {
        const noChunkMs = now - state.lastChunkSeenAt;
        if (noChunkMs > FEED_HEALTH_NO_CHUNKS_OUTAGE_MS) {
            setFeedHealth(stationId, 'outage', `No new chunks for ${formatDuration(noChunkMs)}`, { noChunkMs });
            return;
        }
        if (noChunkMs > FEED_HEALTH_NO_CHUNKS_DEGRADED_MS) {
            setFeedHealth(stationId, 'degraded', `No new chunks for ${formatDuration(noChunkMs)}`, { noChunkMs });
            return;
        }
    }

    if (state.consecutivePollErrors > 0) {
        setFeedHealth(stationId, 'degraded', `Polling recovered after ${state.consecutivePollErrors} error(s)`);
        return;
    }

    setFeedHealth(stationId, 'ok', 'Live chunks are current');
}

function getRadialTimestamp(radial) {
    const timestamp = Number(radial?.timestamp);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function findServerStation(stationId) {
    const normalized = normalizeStationId(stationId);
    return NEXRAD_STATIONS.find(station => station.id === normalized);
}

function getCountyCoordinateSamples(geometry) {
    const samples = [];
    const collect = ring => {
        if (!Array.isArray(ring)) return;
        const step = Math.max(1, Math.floor(ring.length / 8));
        for (let i = 0; i < ring.length; i += step) {
            const coord = ring[i];
            if (Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1])) {
                samples.push({ lon: coord[0], lat: coord[1] });
            }
        }
    };

    if (geometry?.type === 'Polygon') {
        geometry.coordinates?.forEach(collect);
    } else if (geometry?.type === 'MultiPolygon') {
        geometry.coordinates?.forEach(poly => poly.forEach(collect));
    }

    return samples;
}

function buildRadarAreaCountyFips(stationId, radiusKm) {
    const station = findServerStation(stationId);
    if (!station || !COUNTIES?.features) return new Set();

    const center = { lat: station.lat, lon: station.lon };
    const fips = new Set();
    COUNTIES.features.forEach(feature => {
        const state = feature.properties?.STATE;
        const county = feature.properties?.COUNTY;
        if (!state || !county) return;
        if (AUTO_PRIME_STATE_FIPS.size && !AUTO_PRIME_STATE_FIPS.has(state)) return;

        const samples = getCountyCoordinateSamples(feature.geometry);
        const inRange = samples.some(sample => distanceKm(center, sample) <= radiusKm);
        if (inRange) fips.add(`${state}${county}`);
    });

    return fips;
}

const autoPrimeCountyFips = buildRadarAreaCountyFips(AUTO_PRIME_STATION, AUTO_PRIME_RADIUS_KM);

function normalizeGateDistanceKm(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return numeric > 10 ? numeric / 1000 : numeric;
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
    const earthRadiusKm = 6371.0088;
    const angularDistance = distanceKm / earthRadiusKm;
    const bearing = bearingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));

    return {
        lat: lat2 * 180 / Math.PI,
        lon: lon2 * 180 / Math.PI
    };
}

function distanceKm(a, b) {
    const earthRadiusKm = 6371.0088;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function roundCoordinate(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric / GRID_TEMPERATURE_CELL_DEG) * GRID_TEMPERATURE_CELL_DEG : null;
}

function normalizeWeatherRequestItem(item, index) {
    const lat = Number(item?.lat ?? item?.latitude);
    const lon = Number(item?.lon ?? item?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
        key: String(item?.key || `${lat.toFixed(4)},${lon.toFixed(4)},${index}`),
        city: item?.city || null,
        state: item?.state || null,
        lat,
        lon
    };
}

function getGridTemperatureCacheKey(lat, lon) {
    const roundedLat = roundCoordinate(lat);
    const roundedLon = roundCoordinate(lon);
    if (roundedLat === null || roundedLon === null) return null;
    return `${roundedLat},${roundedLon}`;
}

function pickBestNdfdTemperatureResult(results) {
    return (results || [])
        .map(result => {
            const attrs = result.attributes || {};
            const value = Number(attrs['Service Pixel Value'] ?? attrs['Classify.Pixel Value']);
            const forecastHour = Number(attrs.idp_fcst_hour);
            return {
                value,
                layerId: result.layerId,
                forecastHour: Number.isFinite(forecastHour) ? forecastHour : Number.MAX_SAFE_INTEGER,
                validTime: attrs.idp_validtime || null,
                validEndTime: attrs.idp_validendtime || null,
                issuedAt: attrs.idp_issueddate || null
            };
        })
        .filter(result => Number.isFinite(result.value))
        .sort((a, b) => a.forecastHour - b.forecastHour || a.layerId - b.layerId)[0] || null;
}

async function fetchGridTemperature(item) {
    const cacheKey = getGridTemperatureCacheKey(item.lat, item.lon);
    if (!cacheKey) return { ...item, error: 'invalid_location' };

    const now = Date.now();
    const cached = gridTemperatureCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < GRID_TEMPERATURE_TTL_MS) return { ...item, ...cached };
    if (gridTemperatureInflight.has(cacheKey)) return { ...item, ...(await gridTemperatureInflight.get(cacheKey)) };

    const request = (async () => {
        const params = new URLSearchParams({
            f: 'json',
            geometry: `${item.lon},${item.lat}`,
            geometryType: 'esriGeometryPoint',
            sr: '4326',
            layers: `all:${NDFD_TEMP_IMAGE_LAYER_IDS.join(',')}`,
            tolerance: '10',
            mapExtent: '-130,20,-60,53',
            imageDisplay: '1200,800,96',
            returnGeometry: 'false'
        });

        try {
            const response = await fetchWithTimeout(`${NDFD_TEMP_IDENTIFY_URL}?${params}`, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'weathertest NDFD temperature labels'
                }
            }, 10000);
            const data = await response.json();
            const best = pickBestNdfdTemperatureResult(data.results);
            if (!best) throw new Error('No NDFD temperature value returned');

            const sampled = {
                source: 'NDFD',
                temperatureF: Math.round(best.value),
                rawTemperatureF: best.value,
                layerId: best.layerId,
                forecastHour: best.forecastHour,
                validTime: best.validTime,
                validEndTime: best.validEndTime,
                issuedAt: best.issuedAt,
                fetchedAt: Date.now()
            };
            gridTemperatureCache.set(cacheKey, sampled);
            return sampled;
        } finally {
            gridTemperatureInflight.delete(cacheKey);
        }
    })();

    gridTemperatureInflight.set(cacheKey, request);

    try {
        return { ...item, ...(await request) };
    } catch (error) {
        if (cached) return { ...item, ...cached, stale: true };
        return { ...item, error: classifyFetchError(error) };
    }
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(limit, items.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await worker(items[index], index);
        }
    }));

    return results;
}

function bearingDeg(a, b) {
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function lerpBearing(a, b, alpha) {
    let diff = (b - a + 180) % 360 - 180;
    return (a + diff * alpha + 360) % 360;
}

function getCompositeReflectivityMoment(radial) {
    let best = null;
    let data = null;

    for (let e = 1; e <= 22; e++) {
        const moment = radial.elevations?.[e]?.reflectivity;
        if (!moment?.moment_data) continue;
        if (!data) {
            data = new Float32Array(moment.moment_data.length).fill(-Infinity);
            best = moment;
        }
        for (let i = 0; i < moment.moment_data.length; i++) {
            const value = Number(moment.moment_data[i]);
            if (Number.isFinite(value) && value > data[i]) data[i] = value;
        }
    }

    return best ? { ...best, moment_data: data } : null;
}

function getBaseMoment(radial, product) {
    for (let e = 1; e <= 4; e++) {
        const moment = radial.elevations?.[e]?.[product];
        if (moment?.moment_data) return moment;
    }
    return null;
}

function getMomentValueAtRange(moment, rangeKm) {
    if (!moment?.moment_data) return null;
    const firstGateKm = normalizeGateDistanceKm(moment.first_gate);
    const gateSizeKm = normalizeGateDistanceKm(moment.gate_size);
    if (!(gateSizeKm > 0)) return null;
    const index = Math.round((rangeKm - firstGateKm) / gateSizeKm);
    if (index < 0 || index >= moment.moment_data.length) return null;
    const value = Number(moment.moment_data[index]);
    return Number.isFinite(value) ? value : null;
}

function getMomentIndexAtRange(moment, rangeKm) {
    if (!moment?.moment_data) return -1;
    const firstGateKm = normalizeGateDistanceKm(moment.first_gate);
    const gateSizeKm = normalizeGateDistanceKm(moment.gate_size);
    if (!(gateSizeKm > 0)) return -1;
    return Math.round((rangeKm - firstGateKm) / gateSizeKm);
}

function hasVelocitySideSupport(moment, centerIndex, sign, minMagnitude = ROTATION_MIN_SIDE_VELOCITY) {
    if (!moment?.moment_data || centerIndex < 0) return false;
    let support = 0;
    for (let offset = -ROTATION_SUPPORT_GATES; offset <= ROTATION_SUPPORT_GATES; offset++) {
        const value = Number(moment.moment_data[centerIndex + offset]);
        if (!Number.isFinite(value)) continue;
        if (Math.sign(value) === sign && Math.abs(value) >= minMagnitude) support++;
    }
    return support >= 2;
}

function hasCoupletContext(leftMoment, rightMoment, rangeKm, leftVelocity, rightVelocity) {
    const leftSign = Math.sign(leftVelocity);
    const rightSign = Math.sign(rightVelocity);
    if (!leftSign || !rightSign || leftSign === rightSign) return false;
    if (Math.abs(leftVelocity) < ROTATION_MIN_SIDE_VELOCITY || Math.abs(rightVelocity) < ROTATION_MIN_SIDE_VELOCITY) return false;

    const leftIndex = getMomentIndexAtRange(leftMoment, rangeKm);
    const rightIndex = getMomentIndexAtRange(rightMoment, rangeKm);
    return hasVelocitySideSupport(leftMoment, leftIndex, leftSign) &&
        hasVelocitySideSupport(rightMoment, rightIndex, rightSign);
}

function createFeatureBucket(kind, point, evidence, now) {
    return {
        kind,
        latSum: point.lat,
        lonSum: point.lon,
        count: 1,
        maxDbz: evidence.maxDbz || null,
        maxVelocityDelta: evidence.velocityDelta || null,
        minCc: evidence.cc ?? null,
        maxZdr: evidence.zdr ?? null,
        evidence,
        lastUpdated: now
    };
}

function addToBucket(bucket, point, evidence) {
    bucket.latSum += point.lat;
    bucket.lonSum += point.lon;
    bucket.count++;
    if (Number.isFinite(evidence.maxDbz)) bucket.maxDbz = Math.max(bucket.maxDbz || -Infinity, evidence.maxDbz);
    if (Number.isFinite(evidence.velocityDelta)) bucket.maxVelocityDelta = Math.max(bucket.maxVelocityDelta || -Infinity, evidence.velocityDelta);
    if (Number.isFinite(evidence.cc)) bucket.minCc = bucket.minCc === null ? evidence.cc : Math.min(bucket.minCc, evidence.cc);
    if (Number.isFinite(evidence.zdr)) bucket.maxZdr = bucket.maxZdr === null ? evidence.zdr : Math.max(bucket.maxZdr, evidence.zdr);
}

function bucketToFeature(key, bucket) {
    const lat = bucket.latSum / bucket.count;
    const lon = bucket.lonSum / bucket.count;
    const confidence = Math.min(0.95, 0.35 + bucket.count * 0.08);
    const base = {
        id: `${bucket.kind}:${key}`,
        kind: bucket.kind,
        lat,
        lon,
        confidence,
        sampleCount: bucket.count,
        evidence: {
            maxDbz: bucket.maxDbz,
            velocityDelta: bucket.maxVelocityDelta,
            minCc: bucket.minCc,
            maxZdr: bucket.maxZdr,
            rangeKm: bucket.evidence?.rangeKm,
            reliability: bucket.evidence?.reliability
        }
    };

    if (bucket.kind === 'hail') {
        base.label = 'Hail signal';
        base.confidence = Math.min(0.98, confidence + 0.12);
    } else if (bucket.kind === 'rotation') {
        base.label = 'Rotation signal';
        base.confidence = Math.min(0.98, confidence + 0.18);
    } else {
        base.label = 'Strong storm core';
    }

    return base;
}

function attachFeatureMotion(stationId, features, now) {
    const state = stationState.get(stationId) || {};
    const previous = state.derivedFeatures || [];
    const previousByKind = new Map();

    previous.forEach(feature => {
        if (!previousByKind.has(feature.kind)) previousByKind.set(feature.kind, []);
        previousByKind.get(feature.kind).push(feature);
    });

    const usedCandidates = new Set();

    features.forEach(feature => {
        const candidates = previousByKind.get(feature.kind) || [];
        let best = null;
        let bestDistance = Infinity;
        
        candidates.forEach(candidate => {
            if (usedCandidates.has(candidate)) return;
            const km = distanceKm(feature, candidate);
            if (km < bestDistance) {
                best = candidate;
                bestDistance = km;
            }
        });

        if (best && bestDistance < 45) {
            usedCandidates.add(best);
            
            // Persist track metadata
            feature.trackId = best.trackId || `tr-${Math.random().toString(36).substr(2, 9)}`;
            feature.history = (best.history || []).slice();
            
            // Add previous position to history if not redundant
            if (best.detectedAt && (!feature.history.length || feature.history[feature.history.length - 1].detectedAt !== best.detectedAt)) {
                feature.history.push({ lat: best.lat, lon: best.lon, detectedAt: best.detectedAt });
            }
            
            // Prune history (keep 30 mins, max 15 points)
            const thirtyMinsAgo = now - 30 * 60 * 1000;
            feature.history = feature.history.filter(h => h.detectedAt > thirtyMinsAgo);
            if (feature.history.length > 15) feature.history.shift();

            if (feature.history.length > 0) {
                // Use the oldest point as baseline for long-term vector stability
                const baseline = feature.history[0];
                const hours = (now - baseline.detectedAt) / 3600000;
                
                if (hours > 0.01) { // At least 36 seconds
                    const distKm = distanceKm(baseline, feature);
                    const rawMotionDeg = bearingDeg(baseline, feature);
                    const rawSpeedMph = (distKm / hours) * 0.621371;

                    if (best.motionDeg !== undefined && best.speedMph !== undefined) {
                        // Blend with previous smoothed estimates
                        // Alpha increases with baseline length to allow adaptation but keep stability
                        const alpha = Math.min(0.6, Math.max(0.15, hours * 2)); 
                        feature.speedMph = Math.round(best.speedMph * (1 - alpha) + rawSpeedMph * alpha);
                        feature.motionDeg = Math.round(lerpBearing(best.motionDeg, rawMotionDeg, alpha));
                    } else {
                        feature.motionDeg = Math.round(rawMotionDeg);
                        feature.speedMph = Math.round(rawSpeedMph);
                    }
                } else {
                    // Too soon to calculate new vector, carry over
                    feature.motionDeg = best.motionDeg;
                    feature.speedMph = best.speedMph;
                }
            }
        }
    });

    // Save state with history for next iteration
    state.derivedFeatures = features.map(f => ({ ...f, detectedAt: now }));
    stationState.set(stationId, state);

    // Clean features for broadcast (strip history to save bandwidth)
    features.forEach(f => {
        delete f.history;
    });
}

function mergeProximalFeatures(features) {
    if (features.length < 2) return features;
    
    const merged = [];
    const used = new Set();
    
    // Sort by confidence/intensity so we merge weaker/redundant signals into the strongest ones
    const sorted = [...features].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    
    for (let i = 0; i < sorted.length; i++) {
        if (used.has(i)) continue;
        const base = sorted[i];
        used.add(i);
        
        // Find all other features of the same kind within 15km
        for (let j = i + 1; j < sorted.length; j++) {
            if (used.has(j)) continue;
            const other = sorted[j];
            if (other.kind !== base.kind) continue;
            
            const dist = distanceKm(base, other);
            if (dist < 15) { // 15km threshold for merging clusters
                used.add(j);
                // Aggregate properties into the base feature
                base.sampleCount += other.sampleCount;
                if (other.evidence?.maxDbz > (base.evidence?.maxDbz || 0)) {
                    base.evidence.maxDbz = other.evidence.maxDbz;
                    // Slightly shift centroid towards the higher intensity part
                    base.lat = base.lat * 0.7 + other.lat * 0.3;
                    base.lon = base.lon * 0.7 + other.lon * 0.3;
                }
                if (other.evidence?.velocityDelta > (base.evidence?.velocityDelta || 0)) {
                    base.evidence.velocityDelta = other.evidence.velocityDelta;
                }
                base.confidence = Math.min(0.98, base.confidence + 0.05);
            }
        }
        merged.push(base);
    }
    
    return merged;
}

function deriveStormFeatures(stationId, now = Date.now()) {
    const station = findServerStation(stationId);
    const cache = stationCache.get(stationId);
    if (!station || !cache?.radials?.size) return [];

    const radials = Array.from(cache.radials.values())
        .filter(radial => Math.abs(now - getRadialTimestamp(radial)) < 12 * 60 * 1000)
        .sort((a, b) => a.azimuth - b.azimuth);
    const buckets = new Map();

    function addFeature(kind, point, evidence) {
        const latKey = Math.round(point.lat / DERIVED_FEATURE_GRID_DEG);
        const lonKey = Math.round(point.lon / DERIVED_FEATURE_GRID_DEG);
        const key = `${kind}:${latKey}:${lonKey}`;
        if (!buckets.has(key)) {
            buckets.set(key, createFeatureBucket(kind, point, evidence, now));
        } else {
            addToBucket(buckets.get(key), point, evidence);
        }
    }

    radials.forEach(radial => {
        const ref = getCompositeReflectivityMoment(radial);
        if (!ref?.moment_data) return;
        const firstGateKm = normalizeGateDistanceKm(ref.first_gate);
        const gateSizeKm = normalizeGateDistanceKm(ref.gate_size);
        if (!(gateSizeKm > 0)) return;
        const cc = getBaseMoment(radial, 'debris');
        const zdr = getBaseMoment(radial, 'zdr');

        for (let i = 0; i < ref.moment_data.length; i += 4) {
            const rangeKm = firstGateKm + i * gateSizeKm;
            if (rangeKm < DERIVED_FEATURE_MIN_RANGE_KM || rangeKm > DERIVED_FEATURE_MAX_RANGE_KM) continue;
            const dbz = Number(ref.moment_data[i]);
            if (!Number.isFinite(dbz) || dbz < REFLECTIVITY_CORE_DBZ) continue;
            const point = destinationPoint(station.lat, station.lon, radial.azimuth, rangeKm);
            const ccVal = getMomentValueAtRange(cc, rangeKm);
            const zdrVal = getMomentValueAtRange(zdr, rangeKm);
            const evidence = { maxDbz: dbz, cc: ccVal, zdr: zdrVal, rangeKm: Math.round(rangeKm) };
            addFeature('core', point, evidence);
            if (dbz >= HAIL_SIGNAL_DBZ || (dbz >= 55 && Number.isFinite(zdrVal) && zdrVal < 1.2)) {
                addFeature('hail', point, evidence);
            }
        }
    });

    for (let r = 0; r < radials.length; r++) {
        const radial = radials[r];
        const velocity = getBaseMoment(radial, 'velocity');
        if (!velocity?.moment_data) continue;
        const next = radials[(r + 1) % radials.length];
        if (!next) continue;
        const azDiff = Math.abs(((next.azimuth - radial.azimuth + 540) % 360) - 180);
        if (azDiff > 2) continue;
        const nextVelocity = getBaseMoment(next, 'velocity');
        if (!nextVelocity?.moment_data) continue;
        const firstGateKm = normalizeGateDistanceKm(velocity.first_gate);
        const gateSizeKm = normalizeGateDistanceKm(velocity.gate_size);
        if (!(gateSizeKm > 0)) continue;

        for (let i = 0; i < velocity.moment_data.length; i += 3) {
            const rangeKm = firstGateKm + i * gateSizeKm;
            if (rangeKm < DERIVED_FEATURE_MIN_RANGE_KM || rangeKm > ROTATION_MAX_RANGE_KM) continue;
            const v1 = Number(velocity.moment_data[i]);
            const v2 = getMomentValueAtRange(nextVelocity, rangeKm);
            if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue;
            if (Math.sign(v1) === Math.sign(v2)) continue;
            if (!hasCoupletContext(velocity, nextVelocity, rangeKm, v1, v2)) continue;
            const delta = Math.abs(v1 - v2);
            if (delta < ROTATION_VELOCITY_DELTA) continue;
            if (rangeKm > ROTATION_LOW_CONFIDENCE_RANGE_KM && delta < ROTATION_VELOCITY_DELTA + 20) continue;
            const point = destinationPoint(station.lat, station.lon, (radial.azimuth + next.azimuth) / 2, rangeKm);
            const reliability = rangeKm > ROTATION_LOW_CONFIDENCE_RANGE_KM ? 'reduced range reliability' : 'normal';
            addFeature('rotation', point, { velocityDelta: Math.round(delta), rangeKm: Math.round(rangeKm), reliability });
        }
    }

    const rawFeatures = Array.from(buckets.entries())
        .map(([key, bucket]) => bucketToFeature(key, bucket))
        .filter(feature => feature.sampleCount >= (feature.kind === 'rotation' ? 2 : 2));

    const features = mergeProximalFeatures(rawFeatures)
        .sort((a, b) => {
            const priority = { rotation: 3, hail: 2, core: 1 };
            return (priority[b.kind] - priority[a.kind]) || (b.confidence - a.confidence);
        })
        .slice(0, 15);

    attachFeatureMotion(stationId, features, now);
    return features;
}

function maybeBroadcastDerivedFeatures(stationId) {
    const state = stationState.get(stationId) || {};
    const now = Date.now();
    if (state.lastDerivedFeatureAt && now - state.lastDerivedFeatureAt < DERIVED_FEATURE_INTERVAL_MS) return;
    state.lastDerivedFeatureAt = now;
    stationState.set(stationId, state);
    const features = deriveStormFeatures(stationId);
    broadcast(stationId, { type: 'storm_features', stationId, features, generatedAt: now });
}

function pruneStationCache(stationId, now = Date.now()) {
    const state = stationCache.get(stationId);
    if (!state?.radials) return;

    const minTimestamp = now - LIVE_RADAR_CACHE_MAX_AGE_MS;
    for (const [azimuth, radial] of state.radials.entries()) {
        const timestamp = getRadialTimestamp(radial);
        if (!timestamp || timestamp < minTimestamp) {
            state.radials.delete(azimuth);
        }
    }

    if (state.radials.size === 0 && !subscriptions.get(stationId)?.size) {
        stationCache.delete(stationId);
    }
}

function cleanupStationIfUnused(stationId) {
    const hasClients = subscriptions.get(stationId)?.size > 0;
    const hasServerSub = serverSubscriptions.has(stationId);
    if (hasClients || hasServerSub) return;
    
    clearInterval(activePollers.get(stationId));
    activePollers.delete(stationId);
    subscriptions.delete(stationId);
    stationCache.delete(stationId);
    stationState.delete(stationId);
    stationHealth.delete(stationId);
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

    pruneStationCache(stationId);
}

// Helper to convert the Map-based cache to the flat format the client expects
function getConsolidatedData(stationId) {
    pruneStationCache(stationId);
    const state = stationCache.get(stationId);
    if (!state) return null;

    const sortedAzimuths = Array.from(state.radials.keys()).sort((a, b) => a - b);
    
    const result = {
        azimuths: [],
        timestamps: [],
        elevations: {}
    };

    sortedAzimuths.forEach((az, i) => {
        const radial = state.radials.get(az);
        result.azimuths.push(radial.azimuth);
        result.timestamps.push(radial.timestamp);
        
        for (const [e, products] of Object.entries(radial.elevations)) {
            if (!result.elevations[e]) result.elevations[e] = {};
            for (const [product, moment] of Object.entries(products)) {
                if (!result.elevations[e][product]) result.elevations[e][product] = new Array(sortedAzimuths.length).fill(null);
                result.elevations[e][product][i] = moment || null;
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
        if (!response.ok) {
            const error = new Error(`HTTP ${response.status} from ${url}`);
            error.status = response.status;
            error.statusText = response.statusText;
            error.url = url;
            throw error;
        }
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function startAlertPoller() {
    console.log(`Initializing server-side NWS alert poller for ${AUTO_PRIME_STATION} area (${autoPrimeCountyFips.size} counties)...`);
    
    const poll = async () => {
        try {
            const res = await fetchWithTimeout('https://api.weather.gov/alerts/active?status=actual&message_type=alert');
            const data = await res.json();
            
            if (!data.features) return;

            const activeStations = new Set();
            data.features.forEach(f => {
                const props = f.properties;
                const event = (props.event || '').toLowerCase();
                const isTargetEvent =
                    event === 'tornado warning' ||
                    event === 'tornado watch' ||
                    event === 'severe thunderstorm warning' ||
                    event === 'severe thunderstorm watch';
                if (!isTargetEvent) return;

                const sameCodes = props.geocode?.SAME || [];
                const ugcCodes = props.geocode?.UGC || [];
                const matched = sameCodes.some(code => {
                    const countyFips = String(code).slice(-5);
                    return autoPrimeCountyFips.has(countyFips);
                }) || ugcCodes.some(code => {
                    const ugc = String(code);
                    if (!/^[A-Z]{2}C\d{3}$/.test(ugc)) return false;
                    const stateFips = statePostalToFips(ugc.slice(0, 2));
                    return stateFips && autoPrimeCountyFips.has(`${stateFips}${ugc.slice(3)}`);
                });

                if (matched) activeStations.add(AUTO_PRIME_STATION);
            });

            [AUTO_PRIME_STATION].forEach(stationId => {
                if (activeStations.has(stationId)) {
                    if (!serverSubscriptions.has(stationId)) {
                        console.log(`[Auto-Prime] Activating background poller for ${stationId} due to tornado/severe thunderstorm watch/warning in radar area.`);
                        serverSubscriptions.add(stationId);
                        if (!activePollers.has(stationId)) {
                            const poller = setInterval(() => pollChunks(stationId), AUTO_PRIME_POLL_INTERVAL_MS);
                            activePollers.set(stationId, poller);
                            pollChunks(stationId);
                        }
                    }
                } else {
                    if (serverSubscriptions.has(stationId)) {
                        console.log(`[Auto-Prime] Deactivating background poller for ${stationId} as target alerts have cleared.`);
                        serverSubscriptions.delete(stationId);
                        cleanupStationIfUnused(stationId);
                    }
                }
            });

        } catch (e) {
            console.error('[Alert Poller] Error fetching NWS alerts:', e.message);
        }
    };

    setInterval(poll, ALERT_POLL_INTERVAL_MS);
    poll();
}

app.post('/api/temperature-grid/batch', async (req, res) => {
    const items = Array.isArray(req.body?.locations) ? req.body.locations : [];
    const locations = items
        .slice(0, MAX_WEATHER_BATCH_SIZE)
        .map(normalizeWeatherRequestItem)
        .filter(Boolean);

    if (!locations.length) {
        res.status(400).json({ error: 'Request body must include a locations array with lat/lon values.' });
        return;
    }

    const results = await mapWithConcurrency(locations, GRID_TEMPERATURE_CONCURRENCY, fetchGridTemperature);
    res.json({
        generatedAt: Date.now(),
        ttlMs: GRID_TEMPERATURE_TTL_MS,
        results
    });
});

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

async function waitForClientBuffer(ws, maxBytes = MAX_CLIENT_BUFFERED_BYTES) {
    while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > maxBytes) {
        await sleep(25);
    }
}

async function sendRadialBatchesToClient(ws, stationId, radials, snapshot = false) {
    ws.snapshotSending = snapshot;
    for (let i = 0; i < radials.length; i += RADIAL_BATCH_SIZE) {
        if (ws.readyState !== WebSocket.OPEN) break;
        await waitForClientBuffer(ws);
        const batch = radials.slice(i, i + RADIAL_BATCH_SIZE);
        ws.send(JSON.stringify({
            type: 'radial_batch',
            stationId,
            radials: batch,
            latestAzimuth: batch[batch.length - 1].azimuth,
            snapshot
        }));
        await sleep(0);
    }
    if (snapshot) ws.snapshotSending = false;
}

function getCachedRadials(stationId) {
    pruneStationCache(stationId);
    const state = stationCache.get(stationId);
    if (!state) return [];
    return Array.from(state.radials.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createRadialMicrobatcher(stationId) {
    let pending = [];

    async function sendBatch(batch) {
        broadcastRadialBatches(stationId, batch);
    }

    async function sendReadyBatches() {
        while (pending.length >= RADIAL_BATCH_SIZE) {
            const batch = pending.splice(0, RADIAL_BATCH_SIZE);
            await sendBatch(batch);
            if (pending.length > 0) await sleep(RADIAL_BATCH_SPACING_MS);
        }
    }

    async function enqueue(radials) {
        if (!radials || radials.length === 0) return;
        pending.push(...radials);
        await sendReadyBatches();
    }

    async function flush() {
        await sendReadyBatches();
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        await sendBatch(batch);
    }

    return { enqueue, flush };
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

function mergeRadialsIntoCache(stationId, radials, now = Date.now()) {
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

    pruneStationCache(stationId, now);
}
function trimProcessedChunks(state) {
    while (state.processedChunks.size > 1000) {
        const firstKey = state.processedChunks.values().next().value;
        state.processedChunks.delete(firstKey);
    }
}

function trimHeaderChunks(state) {
    const keys = Object.keys(state.headerChunks || {});
    while (keys.length > 4) {
        const key = keys.shift();
        delete state.headerChunks[key];
    }
}

async function primeStationHistory(stationId, state, commonPrefixes) {
    if (state.isPrimed) return;
    state.isPrimed = true; // Mark as primed immediately to prevent concurrent prime tasks
    
    // Move to background to avoid blocking the main live poller
    (async () => {
        const sortedPrefixes = [...commonPrefixes].sort((a, b) => {
            const numA = parseInt(a.Prefix.split('/')[1]);
            const numB = parseInt(b.Prefix.split('/')[1]);
            return numA - numB;
        });

        const latestVolPrefix = state.latestVolPrefix;
        const latestIdx = sortedPrefixes.findIndex(p => p.Prefix === latestVolPrefix);
        if (latestIdx < 0) return;

        const volumesToPrime = [];
        for (let i = 3; i >= 1; i--) {
            const idx = latestIdx - i;
            if (idx >= 0) volumesToPrime.push(sortedPrefixes[idx].Prefix);
        }

        if (volumesToPrime.length === 0) return;

        console.log(`[${stationId}] Priming history from ${volumesToPrime.length} previous volumes...`);
        sendStatus(stationId, `Priming motion tracking history from ${volumesToPrime.length} previous scans...`);
        
        for (let v = 0; v < volumesToPrime.length; v++) {
            if (!subscriptions.get(stationId)?.size) break;
            const volPrefix = volumesToPrime[v];
            try {
                sendStatus(stationId, `Processing historical scan ${v + 1}/${volumesToPrime.length}...`);
                const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${volPrefix}`;
                const chunkRes = await fetchWithTimeout(listChunksUrl);
                const chunkJson = parser.parse(await chunkRes.text());
                let contents = chunkJson.ListBucketResult.Contents;
                if (!contents) continue;
                if (!Array.isArray(contents)) contents = [contents];
                
                contents.sort((a, b) => {
                    const timeDiff = getKeyTimestamp(a.Key) - getKeyTimestamp(b.Key);
                    if (timeDiff !== 0) return timeDiff;
                    return getChunkOrder(a.Key) - getChunkOrder(b.Key);
                });

                const volTimestamp = getKeyTimestamp(contents[0].Key);
                let headerChunk = null;
                const headerKey = contents.find(c => isStartChunk(c.Key))?.Key;
                if (headerKey) {
                    const hRes = await fetchWithTimeout(`${BUCKET_URL}/${headerKey}`);
                    headerChunk = await hRes.arrayBuffer();
                }

                for (const chunk of contents) {
                    if (!subscriptions.get(stationId)?.size) break;
                    try {
                        const dataRes = await fetchWithTimeout(`${BUCKET_URL}/${chunk.Key}`);
                        const chunkBuffer = await dataRes.arrayBuffer();
                        let combinedBuffer;
                        if (headerChunk && !isStartChunk(chunk.Key)) {
                            combinedBuffer = Buffer.concat([Buffer.from(headerChunk), Buffer.from(chunkBuffer)]);
                        } else {
                            combinedBuffer = Buffer.from(chunkBuffer);
                        }
                        const parsed = new Level2Radar(combinedBuffer);
                        // Faster: Only extract products needed for storm signals
                        const extracted = extractRadialData(parsed, stationId, chunk.Key.split('/').pop(), ['reflectivity', 'velocity', 'debris', 'zdr']);
                        const radials = extractedToRadials(extracted);
                        if (radials.length > 0) {
                            mergeRadialsIntoCache(stationId, radials, volTimestamp || Date.now());
                        }
                    } catch (e) {}
                }
                
                if (volTimestamp) {
                    deriveStormFeatures(stationId, volTimestamp);
                    // Broadcast derived features for historical volumes to client
                    const features = deriveStormFeatures(stationId, volTimestamp);
                    broadcast(stationId, { type: 'storm_features', stationId, features, generatedAt: volTimestamp });
                }
            } catch (e) {
                console.error(`[${stationId}] Prime volume error:`, e.message);
            }
        }
        
        console.log(`[${stationId}] Priming complete for ${stationId}`);
        sendStatus(stationId, 'Motion tracking history primed. Tracking is now active.');
    })();
}

async function pollChunks(stationId) {
    stationId = normalizeStationId(stationId);
    const hasClients = subscriptions.get(stationId)?.size > 0;
    const hasServerSub = serverSubscriptions.has(stationId);
    if (!hasClients && !hasServerSub) return;
    
    const now = Date.now();
    const lockKey = `lock_${stationId}`;
    const lastPoll = stationState.get(lockKey) || 0;
    
    // Reduce internal throttle to 15s to be more responsive to S3 updates
    if (pollingLocks.has(stationId) && (now - lastPoll) < 15000) return;
    
    pollingLocks.add(stationId);
    stationState.set(lockKey, now);
    
    try {
        const listVolUrl = `${BUCKET_URL}/?list-type=2&prefix=${stationId}/&delimiter=/`;
        const volRes = await fetchWithTimeout(listVolUrl);
        const volJson = parser.parse(await volRes.text());
        
        let commonPrefixes = volJson.ListBucketResult.CommonPrefixes;
        if (!commonPrefixes) {
            setFeedHealth(stationId, 'outage', 'No S3 volume folders returned for this station');
            return;
        }
        if (!Array.isArray(commonPrefixes)) commonPrefixes = [commonPrefixes];

        commonPrefixes = commonPrefixes.filter(p => /^[A-Z0-9]{4}\/\d+\/$/.test(p.Prefix));
        if (commonPrefixes.length === 0) {
            setFeedHealth(stationId, 'outage', 'No valid S3 volume folders returned for this station');
            return;
        }

        let state = stationState.get(stationId) || { 
            lastVolume: null, 
            lastChunkKey: null, 
            headerChunk: null,
            headerChunks: {},
            processedChunks: new Set(),
            previousVolPrefix: null,
            latestVolPrefix: null,
            latestVolTimestamp: 0,
            lastVolumeDiscovery: 0,
            lastChunkSeenAt: 0,
            consecutivePollErrors: 0,
            isPrimed: false
        };

        if (!state.processedChunks) state.processedChunks = new Set();
        if (!state.headerChunks) state.headerChunks = {};

        const priorLatestVolPrefix = state.latestVolPrefix;
        const latestVolPrefix = await chooseLatestVolume(stationId, commonPrefixes, state, now);
        if (!latestVolPrefix) {
            setFeedHealth(stationId, 'outage', 'Could not identify the latest S3 volume');
            return;
        }

        if (!state.isPrimed) {
            await primeStationHistory(stationId, state, commonPrefixes);
        }

        if (priorLatestVolPrefix && priorLatestVolPrefix !== latestVolPrefix) {
            state.previousVolPrefix = priorLatestVolPrefix;
        }
        stationState.set(stationId, state);
        assessFeedFreshness(stationId, state, now);

        // Poll current and previous folders to keep volume handoffs continuous.
        const sortedPrefixes = [...commonPrefixes].sort((a, b) => {
            const numA = parseInt(a.Prefix.split('/')[1]);
            const numB = parseInt(b.Prefix.split('/')[1]);
            return numA - numB;
        });
        const latestIdx = sortedPrefixes.findIndex(p => p.Prefix === latestVolPrefix);
        const volumesToPollSet = new Set();
        if (state.previousVolPrefix) volumesToPollSet.add(state.previousVolPrefix);
        if (latestIdx >= 0 && sortedPrefixes.length > 1) {
            volumesToPollSet.add(sortedPrefixes[(latestIdx - 1 + sortedPrefixes.length) % sortedPrefixes.length].Prefix);
        }
        volumesToPollSet.add(latestVolPrefix);
        const volumesToPoll = Array.from(volumesToPollSet);

        const radialBatcher = createRadialMicrobatcher(stationId);

        for (const volPrefix of volumesToPoll) {
            if (!subscriptions.get(stationId)?.size) break;
            const listChunksUrl = `${BUCKET_URL}/?list-type=2&prefix=${volPrefix}`;
            const chunkRes = await fetchWithTimeout(listChunksUrl);
            const chunkJson = parser.parse(await chunkRes.text());
            
            let contents = chunkJson.ListBucketResult.Contents;
            if (!contents) continue;
            if (!Array.isArray(contents)) contents = [contents];
            contents.sort((a, b) => {
                const timeDiff = getKeyTimestamp(a.Key) - getKeyTimestamp(b.Key);
                if (timeDiff !== 0) return timeDiff;
                return getChunkOrder(a.Key) - getChunkOrder(b.Key);
            });
            
            const firstChunkKey = contents[0].Key;
            const volumeId = `${volPrefix}${getKeyTimestamp(firstChunkKey) || firstChunkKey}`;

            // Detect Volume Transition (on the newest folder)
            if (volPrefix === latestVolPrefix && volumeId !== state.lastVolume) {
                console.log(`[${stationId}] Transitioning to new volume: ${volumeId}`);
                state.lastVolume = volumeId;
                state.lastChunkKey = null; 
                broadcast(stationId, { type: 'volume_start', stationId, volumeId });
                stationState.set(stationId, state);
            }

            // Filter for truly new chunks using the Set to prevent redundant broadcasts
            const unseen = contents.filter(c => !state.processedChunks.has(c.Key));

            if (unseen.length > 0) {
                const latestKey = unseen[unseen.length - 1].Key;
                const firstId = unseen[0].Key.split('/').pop();
                const lastId = latestKey.split('/').pop();
                console.log(`[${stationId}] Vol ${volPrefix}: Processing ${unseen.length} new chunks (${firstId} to ${lastId})`);
                state.lastChunkSeenAt = now;
                state.consecutivePollErrors = 0;
                let parsedChunkCount = 0;
                let failedChunkCount = 0;
                
                let headerChunk = state.headerChunks[volPrefix];
                if (!headerChunk) {
                    const headerKey = contents.find(c => isStartChunk(c.Key))?.Key;
                    if (headerKey) {
                        const hRes = await fetchWithTimeout(`${BUCKET_URL}/${headerKey}`);
                        headerChunk = await hRes.arrayBuffer();
                        state.headerChunks[volPrefix] = headerChunk;
                        trimHeaderChunks(state);
                    }
                }

                for (const chunk of unseen) {
                    if (!subscriptions.get(stationId)?.size) break;
                    try {
                        const chunkId = chunk.Key.split('/').pop();
                        const dataRes = await fetchWithTimeout(`${BUCKET_URL}/${chunk.Key}`);
                        const chunkBuffer = await dataRes.arrayBuffer();
                        
                        let combinedBuffer;
                        if (headerChunk && !isStartChunk(chunk.Key)) {
                            combinedBuffer = Buffer.concat([Buffer.from(headerChunk), Buffer.from(chunkBuffer)]);
                        } else {
                            combinedBuffer = Buffer.from(chunkBuffer);
                        }

                        const parsed = new Level2Radar(combinedBuffer);
                        const extracted = extractRadialData(parsed, stationId, chunkId);
                        const radials = extractedToRadials(extracted);
                        
                        state.processedChunks.add(chunk.Key);
                        trimProcessedChunks(state);

                        if (radials.length > 0) {
                            parsedChunkCount++;
                            radials.sort((a, b) => a.timestamp - b.timestamp);
                            mergeRadialsIntoCache(stationId, radials, now);
                            broadcastRadialBatches(stationId, radials);
                            maybeBroadcastDerivedFeatures(stationId);
                        }

                    // Trigger immediate volume discovery ONLY if we see an explicit end chunk
                    if (chunkId.includes('_E') || chunkId.includes('-E')) {
                        console.log(`[${stationId}] End of volume scan marker detected. Priming for new volume discovery...`);
                        state.lastVolumeDiscovery = 0; // Reset discovery timer
                        stationState.set(lockKey, 0); // Allow immediate re-poll
                    }

                        } catch (e) {
                        failedChunkCount++;
                        state.processedChunks.add(chunk.Key);
                        trimProcessedChunks(state);
                        }
                        }

                if (failedChunkCount > 0 && parsedChunkCount === 0) {
                    setFeedHealth(stationId, 'degraded', `Received ${failedChunkCount} chunk(s), but none parsed into radar data`, {
                        failedChunkCount,
                        volume: volPrefix
                    });
                } else {
                    assessFeedFreshness(stationId, state);
                }

                if (volPrefix === latestVolPrefix) {
                    state.lastChunkKey = latestKey;
                    stationState.set(stationId, state);
                }
            } else if (volPrefix === latestVolPrefix) {
                assessFeedFreshness(stationId, state);
            }
        }

        await radialBatcher.flush();
    } catch (e) {
        console.error(`[${stationId}] Poll error:`, e.message);
        const state = stationState.get(stationId) || {};
        state.consecutivePollErrors = (state.consecutivePollErrors || 0) + 1;
        stationState.set(stationId, state);
        const errorKind = classifyFetchError(e);
        const status = state.consecutivePollErrors >= 3 ? 'outage' : 'degraded';
        const reason = errorKind === 'rate_limited'
            ? 'S3 is rate limiting requests'
            : `S3 polling ${errorKind.replace(/_/g, ' ')}`;
        setFeedHealth(stationId, status, reason, {
            errorKind,
            httpStatus: e.status || null,
            consecutivePollErrors: state.consecutivePollErrors
        });
    } finally {
        pollingLocks.delete(stationId);
        cleanupStationIfUnused(stationId);
    }
}

function extractRadialData(parsed, stationId, chunkId, productsOnly = null) {
    const elevations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    let azimuths = null;
    let timestamps = null;
    const extractedElevations = {};

    const methodGroups = {
        reflectivity: ['getHighresReflectivity', 'getReflectivity'],
        velocity: ['getHighresVelocity', 'getVelocity'],
        debris: ['getHighresCorrelationCoefficient', 'getCorrelationCoefficient'],
        zdr: ['getHighresDiffReflectivity'],
        width: ['getHighresSpectrum']
    };

    let hasAnyData = false;
    let maxElevationFound = 0;
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
                if (productsOnly && !productsOnly.includes(productKey)) continue;

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
                    maxElevationFound = Math.max(maxElevationFound, e);
                    elevationProducts[productKey] = moments.map(m => m ? {
                        moment_data: Array.from(m.moment_data),
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
        elevations: extractedElevations,
        maxElevation: maxElevationFound
    };
}

function broadcast(stationId, data) {
    const clients = subscriptions.get(stationId);
    if (clients) {
        const message = JSON.stringify(data);
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                if (data.type === 'radial_batch') {
                    if (client.snapshotSending) return;
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
                const stationId = normalizeStationId(parsed.station);
                console.log(`Client subscribing to ${stationId}`);
                
                if (currentStation) {
                    subscriptions.get(currentStation)?.delete(ws);
                    cleanupStationIfUnused(currentStation);
                }

                currentStation = stationId;
                if (!subscriptions.has(stationId)) subscriptions.set(stationId, new Set());
                subscriptions.get(stationId).add(ws);
                const health = stationHealth.get(stationId);
                if (health) ws.send(JSON.stringify(health));
                const currentState = stationState.get(stationId);
                if (currentState?.derivedFeatures) {
                    ws.send(JSON.stringify({
                        type: 'storm_features',
                        stationId,
                        features: currentState.derivedFeatures,
                        generatedAt: currentState.lastDerivedFeatureAt || Date.now(),
                        snapshot: true
                    }));
                }

                // Initial cache can be very large; send it as small snapshot batches to avoid
                // closing browser WebSockets on a single oversized message.
                if (parsed.initial !== false && stationCache.has(stationId)) {
                    sendRadialBatchesToClient(ws, stationId, getCachedRadials(stationId), true)
                        .catch(e => console.error(`[${stationId}] Snapshot send error:`, e.message));
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
                    cleanupStationIfUnused(currentStation);
                }
            }
        } catch (e) {
            console.error('Error handling message:', e);
        }
    });

    ws.on('close', () => {
        if (currentStation) {
            subscriptions.get(currentStation)?.delete(ws);
            cleanupStationIfUnused(currentStation);
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
    startAlertPoller();
});
