const map = L.map('map', {
    center: [34.7465, -92.2896], // Center on Little Rock, AR
    zoom: 7,
    minZoom: 4,
    maxZoom: 12,
    zoomControl: false,
    zoomSnap: 0.1,
    zoomDelta: 0.1,
    wheelPxPerZoomLevel: 200
});

// Add Map Scale
L.control.scale({ position: 'bottomright', imperial: true, metric: false }).addTo(map);

// Create custom panes for land, water, and boundaries to ensure they stay in the correct order
map.createPane('landPane');
map.getPane('landPane').style.zIndex = 150;
map.createPane('waterPane');
map.getPane('waterPane').style.zIndex = 160;
map.createPane('boundaryPane');
map.getPane('boundaryPane').style.zIndex = 170;

// 1. Base Map Setup (Local GeoJSON) 
const landStyle = { fillColor: "#818181", fillOpacity: 1, color: "none", interactive: false };
const waterStyle = { fillColor: "#0000a8", fillOpacity: 1, color: "none", interactive: false };
const riverStyle = { color: "#0000a8", weight: 1.5, opacity: 1, interactive: false };
const stateStyle = { color: "#ffffff", weight: 2, opacity: 0.8, fillOpacity: 0, interactive: false };
const countyStyle = { color: "#444466", weight: 0.8, opacity: 0.5, fillOpacity: 0, interactive: false };

let landLayer = null;
let waterLayer = null;
let riverLayer = null;

// Load base land and water bodies
fetch('data/land.json').then(res => res.json()).then(data => {
    landLayer = L.geoJSON(data, { style: landStyle, pane: 'landPane' }).addTo(map);
});
fetch('data/lakes.json').then(res => res.json()).then(data => {
    waterLayer = L.geoJSON(data, { style: waterStyle, pane: 'waterPane' });
    if (document.getElementById('chk-water')?.checked !== false) waterLayer.addTo(map);
});
fetch('data/rivers.json').then(res => res.json()).then(data => {
    riverLayer = L.geoJSON(data, { style: riverStyle, pane: 'waterPane' });
    if (document.getElementById('chk-rivers')?.checked !== false) riverLayer.addTo(map);
});

let statesLayer = null;
let countiesData = null;
let countiesLayer = null;
const countiesLookup = {};

fetch('data/states.json').then(res => res.json()).then(data => {
    statesLayer = L.geoJSON(data, { style: stateStyle, pane: 'boundaryPane' });
    if (document.getElementById('chk-states')?.checked !== false) statesLayer.addTo(map);
});
fetch('data/counties.json').then(res => res.json()).then(data => {
    countiesData = data;
    data.features.forEach(c => { countiesLookup[c.properties.STATE + c.properties.COUNTY] = c; });
    countiesLayer = L.geoJSON(data, { style: countyStyle, pane: 'boundaryPane' });
    if (document.getElementById('chk-counties')?.checked !== false) countiesLayer.addTo(map);
    if (typeof activeAlertData !== 'undefined' && activeAlertData) renderAlerts();
});

// 2. Radar Overlay (IEM NEXRAD - Reflectivity and Velocity)
// Create separate layers for reflectivity and velocity 
let radarReflectivity = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
    layers: 'nexrad-n0q',
    format: 'image/png',
    transparent: true,
    opacity: 0.8,
    attribution: 'Radar: IEM NEXRAD'
}).addTo(map);

// Initialize radarVelocity as an empty layer group to prevent WMS errors before a station is selected
let radarVelocity = L.layerGroup();

// Initialize Temperature layer (NWS NDFD)
let radarTemperature = L.tileLayer.wms('https://mapservices.weather.noaa.gov/raster/services/NDFD/NDFD_temp/MapServer/WMSServer', {
    layers: '5', // '5' corresponds to the 'Temp_00Hr' layer in the new NOAA MapServer
    format: 'image/png',
    transparent: true,
    opacity: 0.5,
    attribution: 'Temperature: NOAA NDFD'
});

// Cache temperature lookups globally so we don't spam the NWS API when panning
const stationTempsCache = {};

// Track the currently active radar layer to allow redraws
let radarLayer = radarReflectivity;

// Track initial load for prioritization
let initialRadarLoadComplete = false;
let pendingLoopPreload = null;

radarReflectivity.once('load', () => {
    console.log('Initial radar precipitation tiles loaded.');
    initialRadarLoadComplete = true;
    if (pendingLoopPreload) {
        console.log('Starting deferred loop pre-loading.');
        preloadLoopLayers(pendingLoopPreload);
        pendingLoopPreload = null;
    }
});

// Track current mode globally so the selector knows what is allowed
let currentRadarMode = 'reflectivity';

// Define base WMS URL for velocity data as a global constant
const baseWmsUrl = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0u.cgi';

// Radar Loop State
let isLooping = false;
let loopTimestamps = [];
let loopLayers = [];
let currentLoopIndex = 0;
let loopInterval = null;
let lastScanTime = "";

// Roads Overlay (Esri World Transportation)
const roadsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Roads &copy; Esri',
    opacity: 0.75,
    zIndex: 500 // Ensure roads render above the radar layers
}).addTo(map);
let isRoadsVisible = true;

// 3. Warning Fences (NWS Alerts)
const alertsLayer = L.layerGroup().addTo(map);

function getAlertStyle(event) {
    const ev = event.toLowerCase();
    const isWatch = ev.includes('watch') || ev.includes('advisory') || ev.includes('statement');
    
    if (ev.includes('tornado')) {
        return isWatch ? { color: '#ff9900', fillColor: '#ff9900', weight: 3, fillOpacity: 0.2, dashArray: '6' }
                       : { color: '#ff0000', fillColor: '#ff0000', weight: 4, fillOpacity: 0.4 };
    }
    if (ev.includes('thunderstorm')) {
        return isWatch ? { color: '#ff66b2', fillColor: '#ff66b2', weight: 3, fillOpacity: 0.2, dashArray: '6' }
                       : { color: '#ffff00', fillColor: '#ffff00', weight: 3, fillOpacity: 0.3 };
    }
    if (ev.includes('hurricane') || ev.includes('tropical storm')) {
        return { color: '#800080', fillColor: '#800080', weight: 4, fillOpacity: 0.3 };
    }
    if (ev.includes('flood')) return { color: '#00ff00', fillColor: '#00ff00', weight: 3, fillOpacity: 0.3 };
    if (ev.includes('marine') || ev.includes('gale')) return { color: '#ff00ff', fillColor: '#ff00ff', weight: 3, fillOpacity: 0.3 };
    
    if (ev.includes('snow') || ev.includes('blizzard') || ev.includes('winter') || ev.includes('ice') || ev.includes('freez')) {
        return isWatch ? { color: '#3399ff', fillColor: '#3399ff', weight: 3, fillOpacity: 0.2, dashArray: '6' }
                       : { color: '#00ffff', fillColor: '#00ffff', weight: 3, fillOpacity: 0.3 };
    }
    
    return isWatch ? { color: '#aaaaaa', fillColor: '#aaaaaa', weight: 2, fillOpacity: 0.2, dashArray: '4' } 
                   : { color: '#999999', fillColor: '#999999', weight: 3, fillOpacity: 0.3 };
}

function getAlertSeverity(event) {
    const ev = event.toLowerCase();
    const isWatch = ev.includes('watch') || ev.includes('advisory') || ev.includes('statement');
    if (ev.includes('tornado')) return isWatch ? 90 : 100;
    if (ev.includes('hurricane') || ev.includes('tropical storm')) return isWatch ? 85 : 95;
    if (ev.includes('snow squall') || ev.includes('blizzard') || ev.includes('winter storm warning')) return 80;
    if (ev.includes('winter') || ev.includes('freeze') || ev.includes('chill') || ev.includes('ice')) return isWatch ? 50 : 70;
    if (ev.includes('thunderstorm')) return isWatch ? 55 : 60;
    if (ev.includes('marine') || ev.includes('gale')) return 60;
    if (ev.includes('flood')) return 40;
    return isWatch ? 10 : 20;
}

let activeAlertData = null;
const disabledAlertTypes = new Set();

function updateAlerts() {
    fetch('https://api.weather.gov/alerts/active?status=actual&message_type=alert', { cache: 'no-store' })
        .then(res => res.json())
        .then(data => {
            activeAlertData = data;
            renderAlerts();
        })
        .catch(err => console.error('Alert fetch error:', err));
}

function getAlertType(eventStr) {
    const ev = eventStr.toLowerCase();
    const isWatch = ev.includes('watch') || ev.includes('advisory') || ev.includes('statement');
    if (ev.includes('tornado')) return isWatch ? 'tornado-watch' : 'tornado-warning';
    if (ev.includes('thunderstorm')) return isWatch ? 'thunderstorm-watch' : 'thunderstorm-warning';
    if (ev.includes('hurricane') || ev.includes('tropical storm')) return 'hurricane';
    if (ev.includes('flood')) return 'flood';
    if (ev.includes('marine') || ev.includes('gale')) return 'marine';
    if (ev.includes('snow') || ev.includes('blizzard') || ev.includes('winter') || ev.includes('ice') || ev.includes('freez')) return isWatch ? 'winter-watch' : 'snow';
    return isWatch ? 'other-watch' : 'other-warning';
}

function renderAlerts() {
    alertsLayer.clearLayers();
    if (!activeAlertData || !activeAlertData.features) return;

    // Reset legend indicators
    const legendItems = document.querySelectorAll('.legend-item');
    legendItems.forEach(item => {
        if (item.id !== 'legend-no-alerts' && item.id !== 'legend-no-watches') {
            item.style.display = 'none';
        }
    });

    let hasVisibleAlerts = false;
    let hasVisibleWatches = false;

    // Sort features by severity so higher severity draws on top
    const sortedFeatures = [...activeAlertData.features].sort((a, b) => 
        getAlertSeverity(a.properties.event) - getAlertSeverity(b.properties.event)
    );

    sortedFeatures.forEach(feature => {
        const type = getAlertType(feature.properties.event);
        const item = document.querySelector(`.legend-item[data-type="${type}"]`);
        
        if (item) {
            item.style.display = 'flex';
            if (type.includes('warning') || type === 'hurricane' || type === 'flood' || type === 'marine' || type === 'snow') {
                hasVisibleAlerts = true;
            } else {
                hasVisibleWatches = true;
            }
        }

        if (disabledAlertTypes.has(type)) return;

        L.geoJSON(feature, {
            style: getAlertStyle(feature.properties.event)
        }).bindPopup(`
            <div class="alert-popup">
                <h3>${feature.properties.event}</h3>
                <div class="alert-desc">${feature.properties.description || 'No description provided.'}</div>
                <div class="alert-inst">${feature.properties.instruction || 'Follow local advice.'}</div>
            </div>
        `, { maxWidth: 300 }).addTo(alertsLayer);
    });

    document.getElementById('legend-no-alerts').style.display = hasVisibleAlerts ? 'none' : 'flex';
    document.getElementById('legend-no-watches').style.display = hasVisibleWatches ? 'none' : 'flex';
}

// 4. City Overlay 
const cityLayer = L.layerGroup();
let NEXRAD_STATIONS = [];
let isCitiesVisible = true;

const cityWorker = new Worker('cities-worker.js');
cityWorker.onmessage = function(e) {
    const visibleCities = e.data;
    cityLayer.clearLayers();
    visibleCities.forEach(city => {
        L.marker([city.lat, city.lng], {
            icon: L.divIcon({
                className: 'city-label',
                html: `<div>${city.city}</div>`,
                iconSize: [100, 20],
                iconAnchor: [50, 10]
            }),
            interactive: false
        }).addTo(cityLayer);
    });
};

function updateVisibleCities() {
    if (!isCitiesVisible || !map) return;
    const bounds = map.getBounds();
    cityWorker.postMessage({
        bounds: {
            _southWest: { lat: bounds.getSouthWest().lat, lng: bounds.getSouthWest().lng },
            _northEast: { lat: bounds.getNorthEast().lat, lng: bounds.getNorthEast().lng }
        },
        zoom: map.getZoom()
    });
}

// Initial update and periodic polling
updateAlerts();
setInterval(updateAlerts, 60000); // Update alerts every minute
map.on('moveend zoomend', () => {
    updateVisibleCities();
    if (currentRadarMode === 'temperature') updateTemperatureGradient();
});

// Live Radar Logic
let selectedRadarId = 'composite';
let liveScanInterval = null;
let liveDataRefreshInterval = null;
let liveRadarData = null;
let liveCanvasLayer = null;
let currentLiveMode = 'reflectivity';
let radarStationMarker = null;
let azimuthLine = null;
const liveTrackingLayer = L.layerGroup().addTo(map);

// Color Scales for Highres Data
const COLOR_SCALES = {
    reflectivity: (val) => {
        if (val < 5) return null;
        if (val < 10) return '#00ecec';
        if (val < 15) return '#01a0f6';
        if (val < 20) return '#0000f6';
        if (val < 25) return '#00ff00';
        if (val < 30) return '#00c800';
        if (val < 35) return '#009000';
        if (val < 40) return '#ffff00';
        if (val < 45) return '#e7c000';
        if (val < 50) return '#ff9000';
        if (val < 55) return '#ff0000';
        if (val < 60) return '#d60000';
        if (val < 65) return '#c00000';
        if (val < 70) return '#ff00ff';
        if (val < 75) return '#9955c9';
        return '#ffffff';
    },
    velocity: (val) => {
        if (Math.abs(val) < 2) return null;
        if (val <= -100) return '#00ff00';
        if (val <= -75) return '#00cc00';
        if (val <= -50) return '#008800';
        if (val <= -25) return '#004400';
        if (val < 25) return '#777777';
        if (val < 50) return '#440000';
        if (val < 75) return '#880000';
        if (val < 100) return '#cc0000';
        return '#ff0000';
    },
    debris: (val) => {
        if (val < 0.2) return null;
        if (val < 0.45) return '#ff00ff';
        if (val < 0.7) return '#0000ff';
        if (val < 0.8) return '#00ffff';
        if (val < 0.9) return '#00ff00';
        if (val < 0.95) return '#ffff00';
        return null; // Don't show high CC (pure rain) as debris
    }
};

let socket = null;
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);
    
    socket.onopen = () => {
        console.log('Connected to Radar Stream');
        if (currentRadarMode === 'live-tracking' && selectedRadarId !== 'composite') {
            let stationId = selectedRadarId;
            if (stationId.length === 3) stationId = 'K' + stationId;
            socket.send(JSON.stringify({ action: 'subscribe', station: stationId }));
        }
    };

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        // 4-letter normalization for verification
        let currentStationId = selectedRadarId;
        if (currentStationId && currentStationId.length === 3) currentStationId = 'K' + currentStationId;

        if (message.type === 'initial_state') {
            // Verify stationId to prevent cross-session contamination
            if (message.stationId && message.stationId !== currentStationId) {
                console.warn('Ignoring initial_state for mismatched station:', message.stationId);
                return;
            }

            console.log('Received initial state for', message.stationId);
            liveRadarData = message.data;
            if (liveRadarData) {
                // Initialize metadata arrays if missing
                if (!liveRadarData.lastUpdated) {
                    liveRadarData.lastUpdated = new Array(liveRadarData.azimuths.length).fill(Date.now());
                }
                if (!liveRadarData.revealedUpdate) {
                    // Mark as already revealed so initial state is visible immediately
                    liveRadarData.revealedUpdate = new Array(liveRadarData.azimuths.length).fill(1);
                }
                if (!liveRadarData.timestamps) {
                    liveRadarData.timestamps = [...liveRadarData.lastUpdated];
                }
                
                // Build the radialsMap for future incremental updates
                liveRadarData.radialsMap = new Map();
                liveRadarData.azimuths.forEach((az, i) => {
                    const rounded = Math.round(az * 10) / 10;
                    const radialElevations = {};
                    for (const [e, products] of Object.entries(liveRadarData.elevations)) {
                        radialElevations[e] = {};
                        for (const [product, moments] of Object.entries(products)) {
                            radialElevations[e][product] = moments[i];
                        }
                    }
                    liveRadarData.radialsMap.set(rounded, {
                        azimuth: az,
                        timestamp: liveRadarData.timestamps[i],
                        revealedUpdate: liveRadarData.revealedUpdate[i],
                        elevations: radialElevations
                    });
                });
            }
            renderLiveRadar();
        } else if (message.type === 'radial_update') {
            // Verify stationId
            if (message.stationId && message.stationId !== currentStationId) return;

            console.log('Received real-time update:', message.chunk);
            mergeRealTimeData(message.data);
        } else if (message.type === 'clear_data') {
            console.log('Server requested data clear (New Volume) - ignoring to persist display');
            // We ignore clear_data to keep the old volume visible until overwritten
        } else if (message.type === 'status') {
            console.log('WebSocket Status:', message.message);
        } else if (message.type === 'heartbeat') {
            // Heartbeat received, server is alive
        }
    };

    socket.onclose = () => {
        console.log('WebSocket Closed. Reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };
}
connectWebSocket();

function mergeRealTimeData(newData) {
    if (!liveRadarData) {
        liveRadarData = newData;
        liveRadarData.lastUpdated = new Array(liveRadarData.azimuths.length).fill(Date.now());
        liveRadarData.revealedUpdate = new Array(liveRadarData.azimuths.length).fill(0);
        return;
    }

    const now = Date.now();
    newData.azimuths.forEach((newAz, i) => {
        const rounded = Math.round(newAz * 10) / 10;
        
        // Update the master azimuth array and product data
        const masterIdx = liveRadarData.azimuths.findIndex(az => Math.round(az * 10) / 10 === rounded);
        if (masterIdx !== -1) {
            for (const [e, products] of Object.entries(newData.elevations)) {
                if (!liveRadarData.elevations[e]) liveRadarData.elevations[e] = {};
                for (const [product, moments] of Object.entries(products)) {
                    if (!liveRadarData.elevations[e][product]) liveRadarData.elevations[e][product] = [];
                    liveRadarData.elevations[e][product][masterIdx] = moments[i];
                }
            }
            if (!liveRadarData.lastUpdated) liveRadarData.lastUpdated = new Array(liveRadarData.azimuths.length).fill(0);
            liveRadarData.lastUpdated[masterIdx] = now;
        }
    });
}

function updateRadarSelector() {
    const radarSelect = document.getElementById('radar-select');
    if (!radarSelect) return;
    
    // Clear existing options
    radarSelect.innerHTML = '<option value="composite">Composite (Multi-site)</option>';
    
    // Sort and add stations
    const sorted = [...NEXRAD_STATIONS].sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach(station => {
        const option = document.createElement('option');
        option.value = station.id;
        option.text = `${station.id.toUpperCase()} - ${station.name}`;
        radarSelect.add(option);
    });

    if (selectedRadarId) radarSelect.value = selectedRadarId;
}

function getNearbyRadars() {
    const center = map.getCenter();
    return NEXRAD_STATIONS.map(s => ({
        ...s,
        dist: center.distanceTo([s.lat, s.lon])
    })).sort((a, b) => a.dist - b.dist).slice(0, 10);
}

function updateTemperatureGradient() {
    if (currentRadarMode !== 'temperature') return;
    const bounds = map.getBounds();
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    // In a real app, you might fetch temperature contours here.
    // For this prototype, the NDFD WMS layer is sufficient.
}

function toggleLoop() {
    isLooping = !isLooping;
    const btn = document.getElementById('btn-loop');
    if (!btn) return;

    if (isLooping) {
        btn.innerText = 'Stop Loop';
        btn.classList.add('active');
        startLoop();
    } else {
        btn.innerText = 'Play Loop';
        btn.classList.remove('active');
        stopLoop();
    }
}

function startLoop() {
    console.log('Starting radar loop...');
    // IEM maintains a 5-minute interval for the last hour
    const now = new Date();
    loopTimestamps = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 5 * 60000);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const min = String(Math.floor(d.getUTCMinutes() / 5) * 5).padStart(2, '0');
        loopTimestamps.push(`${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`);
    }

    if (!initialRadarLoadComplete) {
        console.log('Prioritizing initial radar view, deferring loop preload.');
        pendingLoopPreload = loopTimestamps;
        return;
    }

    preloadLoopLayers(loopTimestamps);
}

function preloadLoopLayers(timestamps) {
    loopLayers = timestamps.map(ts => {
        return L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
            layers: 'nexrad-n0q',
            format: 'image/png',
            transparent: true,
            opacity: 0.8,
            time: ts
        });
    });

    currentLoopIndex = 0;
    loopInterval = setInterval(() => {
        if (loopLayers.length === 0) return;
        
        const oldLayer = loopLayers[currentLoopIndex];
        currentLoopIndex = (currentLoopIndex + 1) % loopLayers.length;
        const newLayer = loopLayers[currentLoopIndex];
        
        if (map.hasLayer(radarReflectivity)) map.removeLayer(radarReflectivity);
        newLayer.addTo(map);
        radarReflectivity = newLayer;
        
        // Update timestamp display
        const date = new Date(timestamps[currentLoopIndex]);
        document.getElementById('timestamp').innerText = date.toLocaleString() + ' (Looping)';
    }, 800);
}

function stopLoop() {
    if (loopInterval) clearInterval(loopInterval);
    loopInterval = null;
    updateReflectivityLayer();
    map.addLayer(radarReflectivity);
    updateTimestamp();
}

function updateTimestamp() {
    const now = new Date();
    document.getElementById('timestamp').innerText = now.toLocaleString();
}

setInterval(updateTimestamp, 1000);
updateTimestamp();

function setupRadarButtons() {
    const reflectivityBtn = document.getElementById('btn-reflectivity');
    const liveTrackingBtn = document.getElementById('btn-live-tracking');
    const velocityBtn = document.getElementById('btn-velocity');
    const temperatureBtn = document.getElementById('btn-temperature');
    const btnLiveReflectivity = document.getElementById('btn-live-reflectivity');
    const btnLiveVelocity = document.getElementById('btn-live-velocity');
    const btnLiveDebris = document.getElementById('btn-live-debris');
    const loopBtn = document.getElementById('btn-loop');
    
    const reflectivityLegend = document.getElementById('reflectivity-legend');
    const velocityLegend = document.getElementById('velocity-legend');
    const liveIndicator = document.getElementById('live-indicator');
    
    const chkCities = document.getElementById('chk-cities');
    const chkRoads = document.getElementById('chk-roads');
    const chkRivers = document.getElementById('chk-rivers');
    const chkWater = document.getElementById('chk-water');
    const chkCounties = document.getElementById('chk-counties');
    const chkStates = document.getElementById('chk-states');
    const chkTempGradient = document.getElementById('chk-temp-gradient');
    const mapLayersToggle = document.getElementById('map-layers-toggle');
    const mapLayersContent = document.getElementById('map-layers-content');
    const weatherViewsToggle = document.getElementById('weather-views-toggle');
    const weatherViewsContent = document.getElementById('weather-views-content');
    const mainControlsToggle = document.getElementById('main-controls-toggle');
    const mainControlsContent = document.getElementById('main-controls-content');

    if (reflectivityBtn) {
        reflectivityBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (reflectivityBtn.classList.contains('active')) {
                currentRadarMode = 'none';
                reflectivityBtn.classList.remove('active');
            } else {
                currentRadarMode = 'reflectivity';
                reflectivityBtn.classList.add('active');
                if (liveTrackingBtn) liveTrackingBtn.classList.remove('active');
                if (velocityBtn) velocityBtn.classList.remove('active');
                if (temperatureBtn) temperatureBtn.classList.remove('active');
                if (velocityLegend) velocityLegend.style.display = 'none';
            }
            updateRadarLayersBasedOnMode();
        });
    }

    if (liveTrackingBtn) {
        liveTrackingBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            console.log('Live tracking clicked');
            if (liveTrackingBtn.classList.contains('active')) {
                currentRadarMode = 'reflectivity';
                liveTrackingBtn.classList.remove('active');
                if (reflectivityBtn) reflectivityBtn.classList.add('active');
            } else {
                currentRadarMode = 'live-tracking';
                if (selectedRadarId === 'composite') updateRadarSelector();
                liveTrackingBtn.classList.add('active');
                if (reflectivityBtn) reflectivityBtn.classList.remove('active');
                if (velocityBtn) velocityBtn.classList.remove('active');
                if (temperatureBtn) temperatureBtn.classList.remove('active');
                if (velocityLegend) velocityLegend.style.display = 'none';
            }
            updateRadarLayersBasedOnMode();
        });
    }

    if (btnLiveReflectivity) {
        btnLiveReflectivity.addEventListener('click', () => {
            currentLiveMode = 'reflectivity';
            btnLiveReflectivity.classList.add('active');
            if (btnLiveVelocity) btnLiveVelocity.classList.remove('active');
            if (btnLiveDebris) btnLiveDebris.classList.remove('active');
            updateLiveLegends();
            renderLiveRadar();
        });
    }

    if (btnLiveVelocity) {
        btnLiveVelocity.addEventListener('click', () => {
            currentLiveMode = 'velocity';
            if (btnLiveReflectivity) btnLiveReflectivity.classList.remove('active');
            btnLiveVelocity.classList.add('active');
            if (btnLiveDebris) btnLiveDebris.classList.remove('active');
            updateLiveLegends();
            renderLiveRadar();
        });
    }

    if (btnLiveDebris) {
        btnLiveDebris.addEventListener('click', () => {
            currentLiveMode = 'debris';
            if (btnLiveReflectivity) btnLiveReflectivity.classList.remove('active');
            if (btnLiveVelocity) btnLiveVelocity.classList.remove('active');
            btnLiveDebris.classList.add('active');
            updateLiveLegends();
            renderLiveRadar();
        });
    }
    
    if (velocityBtn) {
        velocityBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (velocityBtn.classList.contains('active')) {
                currentRadarMode = 'none';
                velocityBtn.classList.remove('active');
                if (velocityLegend) velocityLegend.style.display = 'none';
            } else {
                currentRadarMode = 'velocity';
                if (selectedRadarId === 'composite') updateRadarSelector();
                velocityBtn.classList.add('active');
                if (reflectivityBtn) reflectivityBtn.classList.remove('active');
                if (liveTrackingBtn) liveTrackingBtn.classList.remove('active');
                if (temperatureBtn) temperatureBtn.classList.remove('active');
                if (velocityLegend) velocityLegend.style.display = 'block';
            }
            updateRadarLayersBasedOnMode();
        });
    }
    
    if (temperatureBtn) {
        temperatureBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (temperatureBtn.classList.contains('active')) {
                currentRadarMode = 'none';
                temperatureBtn.classList.remove('active');
            } else {
                currentRadarMode = 'temperature';
                temperatureBtn.classList.add('active');
                if (reflectivityBtn) reflectivityBtn.classList.remove('active');
                if (velocityBtn) velocityBtn.classList.remove('active');
                if (liveTrackingBtn) liveTrackingBtn.classList.remove('active');
                if (velocityLegend) velocityLegend.style.display = 'none';
            }
            updateRadarLayersBasedOnMode();
        });
    }

    const cityAttribution = '<a href="https://simplemaps.com" target="_blank">City Data: simplemaps.com</a>';

    if (chkCities) {
        if (chkCities.checked && map.attributionControl) {
            map.attributionControl.addAttribution(cityAttribution);
        }

        chkCities.addEventListener('change', (e) => {
            isCitiesVisible = e.target.checked;
            if (isCitiesVisible) { 
                map.addLayer(cityLayer); 
                updateVisibleCities(); 
                if (map.attributionControl) map.attributionControl.addAttribution(cityAttribution);
            } else {
                map.removeLayer(cityLayer);
                if (map.attributionControl) map.attributionControl.removeAttribution(cityAttribution);
            }
        });
    }
    if (chkRoads) {
        chkRoads.addEventListener('change', (e) => {
            if (e.target.checked) map.addLayer(roadsLayer);
            else map.removeLayer(roadsLayer);
        });
    }
    if (chkRivers) {
        chkRivers.addEventListener('change', (e) => {
            if (riverLayer) {
                if (e.target.checked) map.addLayer(riverLayer);
                else map.removeLayer(riverLayer);
            }
        });
    }
    if (chkWater) {
        chkWater.addEventListener('change', (e) => {
            if (waterLayer) {
                if (e.target.checked) map.addLayer(waterLayer);
                else map.removeLayer(waterLayer);
            }
        });
    }
    if (chkCounties) {
        chkCounties.addEventListener('change', (e) => {
            if (countiesLayer) {
                if (e.target.checked) map.addLayer(countiesLayer);
                else map.removeLayer(countiesLayer);
            }
        });
    }
    if (chkStates) {
        chkStates.addEventListener('change', (e) => {
            if (statesLayer) {
                if (e.target.checked) map.addLayer(statesLayer);
                else map.removeLayer(statesLayer);
            }
        });
    }
    if (chkTempGradient) {
        chkTempGradient.addEventListener('change', () => updateRadarLayersBasedOnMode());
    }

    if (mapLayersToggle && mapLayersContent) {
        mapLayersToggle.addEventListener('click', () => {
            const icon = mapLayersToggle.querySelector('span');
            if (mapLayersContent.style.display === 'none') {
                mapLayersContent.style.display = 'block';
                if (icon) icon.innerText = '▼';
            } else {
                mapLayersContent.style.display = 'none';
                if (icon) icon.innerText = '▶';
            }
        });
    }

    if (weatherViewsToggle && weatherViewsContent) {
        weatherViewsToggle.addEventListener('click', () => {
            const icon = weatherViewsToggle.querySelector('span');
            if (weatherViewsContent.style.display === 'none') {
                weatherViewsContent.style.display = 'block';
                if (icon) icon.innerText = '▼';
            } else {
                weatherViewsContent.style.display = 'none';
                if (icon) icon.innerText = '▶';
            }
        });
    }

    if (mainControlsToggle && mainControlsContent) {
        mainControlsToggle.addEventListener('click', () => {
            const icon = mainControlsToggle.querySelector('span');
            if (mainControlsContent.style.display === 'none') {
                mainControlsContent.style.display = 'block';
                if (icon) icon.innerText = '▼';
            } else {
                mainControlsContent.style.display = 'none';
                if (icon) icon.innerText = '▶';
            }
        });
    }

    // Legend Toggle
    const legend = document.getElementById('legend');
    const legendToggle = document.getElementById('legend-toggle-btn');
    if (legend && legendToggle) {
        // Show toggle only on mobile or small screens
        if (window.innerWidth <= 768) {
            legendToggle.style.display = 'block';
            legend.style.display = 'none'; // Start hidden on mobile
        }

        legendToggle.addEventListener('click', () => {
            const icon = legendToggle.querySelector('span');
            if (legend.style.display === 'none') {
                legend.style.display = 'block';
                if (icon) icon.innerText = '▲';
            } else {
                legend.style.display = 'none';
                if (icon) icon.innerText = '▼';
            }
        });
    }
    
    if (loopBtn) {
        loopBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (currentRadarMode !== 'reflectivity') return;
            toggleLoop();
        });
    }
}

function setupLegendToggles() {
    document.querySelectorAll('.legend-item').forEach(item => {
        if (item.id === 'legend-no-alerts' || item.id === 'legend-no-watches') return;
        item.addEventListener('click', (e) => {
            const type = e.currentTarget.getAttribute('data-type');
            if (!type) return;
            if (disabledAlertTypes.has(type)) {
                disabledAlertTypes.delete(type);
                e.currentTarget.classList.remove('disabled');
            } else {
                disabledAlertTypes.add(type);
                e.currentTarget.classList.add('disabled');
            }
            renderAlerts(); 
        });
    });
}

function setupRadarSelector() {
    const radarSelect = document.getElementById('radar-select');
    if (!radarSelect) return;
    radarSelect.addEventListener('change', (e) => {
        selectedRadarId = e.target.value;
        updateRadarLayersBasedOnMode();
    });
    updateRadarSelector();
}

function updateVelocityLayer() {
    if (map.hasLayer(radarVelocity)) map.removeLayer(radarVelocity);
    if (!selectedRadarId || selectedRadarId === 'composite') {
        radarVelocity = L.layerGroup(); 
        return;
    } else {
        const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
        if (!station) { radarVelocity = L.layerGroup(); return; }
        const specificWmsUrl = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/ridge.cgi';
        const sectorId = station.id.length === 4 ? station.id.substring(1).toUpperCase() : station.id.toUpperCase();
        radarVelocity = L.tileLayer.wms(specificWmsUrl, {
            layers: 'single', sector: sectorId, prod: 'N0U', format: 'image/png',
            transparent: true, opacity: 0.8, attribution: `Radar: ${station.id}`
        });
    }
}

function updateReflectivityLayer() {
    if (map.hasLayer(radarReflectivity)) map.removeLayer(radarReflectivity);
    radarReflectivity = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
        layers: 'nexrad-n0q', format: 'image/png', transparent: true, opacity: 0.8,
        attribution: 'Radar: IEM NEXRAD'
    });
}

function updateLiveLegends() {
    const refLegend = document.getElementById('live-reflectivity-legend');
    const velLegend = document.getElementById('live-velocity-legend');
    const debLegend = document.getElementById('live-debris-legend');

    if (refLegend) refLegend.style.display = 'none';
    if (velLegend) velLegend.style.display = 'none';
    if (debLegend) debLegend.style.display = 'none';

    if (currentRadarMode === 'live-tracking') {
        if (currentLiveMode === 'reflectivity' && refLegend) refLegend.style.display = 'block';
        if (currentLiveMode === 'velocity' && velLegend) velLegend.style.display = 'block';
        if (currentLiveMode === 'debris' && debLegend) debLegend.style.display = 'block';
    }
}

function updateRadarLayersBasedOnMode() {
    console.log('Updating radar layers for mode:', currentRadarMode);
    const loopBtn = document.getElementById('btn-loop');
    const precipOptions = document.getElementById('precip-options');
    const liveOptions = document.getElementById('live-tracking-options');
    const tempOptions = document.getElementById('temp-options');
    const liveIndicator = document.getElementById('live-indicator');

    if (precipOptions) precipOptions.style.display = (currentRadarMode === 'reflectivity') ? 'block' : 'none';
    if (liveOptions) liveOptions.style.display = (currentRadarMode === 'live-tracking') ? 'block' : 'none';
    if (tempOptions) tempOptions.style.display = (currentRadarMode === 'temperature') ? 'block' : 'none';
    if (liveIndicator) liveIndicator.style.display = (currentRadarMode === 'live-tracking') ? 'block' : 'none';

    updateLiveLegends();

    if (map.hasLayer(radarReflectivity)) map.removeLayer(radarReflectivity);
    if (map.hasLayer(radarVelocity)) map.removeLayer(radarVelocity);
    if (map.hasLayer(radarTemperature)) map.removeLayer(radarTemperature);
    
    if (currentRadarMode !== 'live-tracking') {
        liveRadarData = null;
        liveCanvasLayer = null;
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: 'unsubscribe' }));
        }
        liveTrackingLayer.clearLayers();
        if (liveScanInterval) { cancelAnimationFrame(liveScanInterval); liveScanInterval = null; }
        if (liveDataRefreshInterval) { clearInterval(liveDataRefreshInterval); liveDataRefreshInterval = null; }
    }

    if (currentRadarMode !== 'reflectivity' && isLooping) toggleLoop();
    if (loopBtn) loopBtn.disabled = (currentRadarMode !== 'reflectivity');

    if (currentRadarMode === 'reflectivity') {
        updateReflectivityLayer(); map.addLayer(radarReflectivity);
    } else if (currentRadarMode === 'live-tracking') {
        startLiveTracking();
    } else if (currentRadarMode === 'velocity') {
        updateVelocityLayer(); map.addLayer(radarVelocity);
    } else if (currentRadarMode === 'temperature') {
        const chkTempGradient = document.getElementById('chk-temp-gradient');
        if (chkTempGradient && chkTempGradient.checked) map.addLayer(radarTemperature);
    }
    if (isCitiesVisible) updateVisibleCities();
}

function startLiveTracking() {
    console.log('startLiveTracking called');
    if (!NEXRAD_STATIONS || NEXRAD_STATIONS.length === 0) return;
    
    if (!selectedRadarId || selectedRadarId === 'composite') {
        const nearby = getNearbyRadars();
        if (nearby.length > 0) {
            selectedRadarId = nearby[0].id;
            const select = document.getElementById('radar-select');
            if (select) select.value = selectedRadarId;
        } else {
            return;
        }
    }

    let stationId = selectedRadarId;
    if (stationId.length === 3) stationId = 'K' + stationId;

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'subscribe', station: stationId }));
    }

    // CRITICAL: Clear existing data to prevent geo-contamination
    liveRadarData = null;
    if (liveCanvasLayer) {
        liveCanvasLayer._needsFullRedraw = true;
        if (liveCanvasLayer._offscreenCtx) {
            liveCanvasLayer._offscreenCtx.clearRect(0, 0, liveCanvasLayer._offscreenCanvas.width, liveCanvasLayer._offscreenCanvas.height);
        }
    }

    const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
    if (!station) return;

    radarStationMarker = L.circleMarker([station.lat, station.lon], {
        radius: 10, fillColor: '#ffffff', color: '#000', weight: 2, opacity: 1, fillOpacity: 1
    }).addTo(liveTrackingLayer);

    azimuthLine = L.polyline([[station.lat, station.lon], [station.lat, station.lon]], {
        color: '#ffffff', weight: 2, opacity: 0.8
    }).addTo(liveTrackingLayer);

    document.getElementById('timestamp').innerText = `Connecting to Live Stream: ${stationId}...`;
    
    if (liveScanInterval) cancelAnimationFrame(liveScanInterval);
    if (liveDataRefreshInterval) clearInterval(liveDataRefreshInterval);

    function animateSweep() {
        // Sync sweep to 1 RPM (6 degrees per second) with a lag buffer
        const SWEEP_BUFFER_MS = 20000; // 20s lag buffer to ensure data availability
        const replayTime = Date.now() - SWEEP_BUFFER_MS;
        const secondsInMinute = (replayTime / 1000) % 60;
        const currentAngle = secondsInMinute * 6; 
        
        window.currentScanAzimuth = currentAngle;
        
        const rad = (90 - currentAngle) * Math.PI / 180; 
        const dist = 3.5; 
        const endLat = station.lat + dist * Math.sin(rad);
        const endLon = station.lon + dist * Math.cos(rad);
        
        if (azimuthLine) {
            azimuthLine.setLatLngs([[station.lat, station.lon], [endLat, endLon]]);
            azimuthLine.setStyle({ color: '#ffffff', weight: 3, opacity: 1.0 });
        }
        
        if (liveCanvasLayer && liveCanvasLayer._topLeft) {
            const lastAngle = window._lastSweepAngle !== undefined ? window._lastSweepAngle : currentAngle;
            liveCanvasLayer._drawIncremental(lastAngle, currentAngle);
            liveCanvasLayer._draw();
        }
        
        window._lastSweepAngle = currentAngle;
        liveScanInterval = requestAnimationFrame(animateSweep);
    }
    
    liveScanInterval = requestAnimationFrame(animateSweep);
}



const RadarCanvasLayer = L.Layer.extend({
    onAdd: function(map) {
        this._container = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
        this._container.style.pointerEvents = 'none';
        map.getPanes().overlayPane.appendChild(this._container);

        this._offscreenCanvas = document.createElement('canvas');
        this._offscreenCtx = this._offscreenCanvas.getContext('2d');
        this._tempCanvas = document.createElement('canvas'); // Reuse for shifting
        this._needsFullRedraw = true;

        map.on('viewreset', this._reset, this); 
        map.on('move', this._onMove, this);
        map.on('moveend', this._reset, this);
        this._reset();
    },
    onRemove: function(map) {
        if (this._container && this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }
        map.off('viewreset', this._reset, this); 
        map.off('move', this._onMove, this);
        map.off('moveend', this._reset, this);
        this._offscreenCanvas = null;
        this._offscreenCtx = null;
    },
    _onMove: function() {
        const topLeft = map.getBounds().getNorthWest();
        const pos = map.latLngToLayerPoint(topLeft);
        
        const dx = this._topLeft.x - pos.x;
        const dy = this._topLeft.y - pos.y;
        
        if (dx !== 0 || dy !== 0) {
            const dpr = window.devicePixelRatio || 1;
            // Shift offscreen content to stay geographically locked during pans
            this._tempCanvas.width = this._offscreenCanvas.width;
            this._tempCanvas.height = this._offscreenCanvas.height;
            const tCtx = this._tempCanvas.getContext('2d');
            tCtx.drawImage(this._offscreenCanvas, 0, 0);
            
            this._offscreenCtx.clearRect(0, 0, this._offscreenCanvas.width, this._offscreenCanvas.height);
            this._offscreenCtx.drawImage(this._tempCanvas, dx * dpr, dy * dpr);
        }

        L.DomUtil.setPosition(this._container, pos);
        this._topLeft = pos;
        this._draw(); 
    },
    _getPixelsPerKm: function(stationLat, stationLon) {
        // High-precision scale calculation using geodesic points
        const lat2 = stationLat + 0.01;
        const p1 = map.latLngToLayerPoint([stationLat, stationLon]);
        const p2 = map.latLngToLayerPoint([lat2, stationLon]);
        const distMeters = L.latLng(stationLat, stationLon).distanceTo(L.latLng(lat2, stationLon));
        return (p1.distanceTo(p2) / distMeters) * 1000;
    },
    _reset: function() {
        const size = map.getSize();
        const dpr = window.devicePixelRatio || 1;
        
        this._container.width = size.x * dpr; 
        this._container.height = size.y * dpr;
        this._container.style.width = size.x + 'px';
        this._container.style.height = size.y + 'px';
        
        this._offscreenCanvas.width = size.x * dpr;
        this._offscreenCanvas.height = size.y * dpr;

        const pos = map.latLngToLayerPoint(map.getBounds().getNorthWest());
        L.DomUtil.setPosition(this._container, pos);
        this._topLeft = pos;
        this._needsFullRedraw = true;
        this._draw();
    },
    _renderFull: function(center, pixelsPerKm) {
        if (!this._offscreenCanvas || !this._offscreenCtx) return;
        const ctx = this._offscreenCtx;
        const dpr = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, this._offscreenCanvas.width, this._offscreenCanvas.height);

        if (!liveRadarData || !liveRadarData.elevations) return;

        let momentKey = 'reflectivity';
        if (currentLiveMode === 'velocity') { momentKey = 'velocity'; }
        else if (currentLiveMode === 'debris') { momentKey = 'debris'; }

        let momentArray = [];
        for (let e = 1; e <= 5; e++) {
            const temp = liveRadarData.elevations[e] ? liveRadarData.elevations[e][momentKey] : null;
            if (temp && temp.some(m => m && m.moment_data)) { momentArray = temp; break; }
        }
        if (momentArray.length === 0) return;

        const azArray = liveRadarData.azimuths;
        const angularRes = 360 / azArray.length;
        const arcWidthRad = (angularRes * Math.PI / 180) * 2.5; // High overlap for smoothness
        const zoom = map.getZoom();
        const gateStep = 1; 
        const scale = COLOR_SCALES[momentKey];

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.translate(center.x, center.y);
        ctx.globalAlpha = 1.0;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        if (!liveRadarData.revealedUpdate) {
            liveRadarData.revealedUpdate = new Array(azArray.length).fill(1);
        }

        for (let i = 0; i < azArray.length; i++) {
            const radialAz = azArray[i];
            const moment = momentArray[i];
            
            if (!liveRadarData.revealedUpdate || !liveRadarData.revealedUpdate[i]) continue;
            if (!moment || !moment.moment_data) continue;

            const azimuth = (90 - radialAz) * Math.PI / 180;
            ctx.save();
            ctx.rotate(-azimuth);

            const firstGateKm = moment.first_gate / 1000;
            const firstGateActual = firstGateKm < 1 ? moment.first_gate : firstGateKm;
            const gateSizeKm = moment.gate_size;
            const data = moment.moment_data;

            let startJ = null;
            let currentColor = null;

            for (let j = 0; j <= data.length; j += gateStep) {
                const val = j < data.length ? data[j] : null;
                const color = val !== null && val !== undefined ? scale(val) : null;
                
                if (color !== currentColor) {
                    if (currentColor !== null && startJ !== null) {
                        const r1 = (firstGateActual + startJ * gateSizeKm) * pixelsPerKm;
                        const r2 = (firstGateActual + j * gateSizeKm) * pixelsPerKm;
                        ctx.fillStyle = currentColor;
                        ctx.strokeStyle = currentColor;
                        ctx.lineWidth = 1.5; // Thick bleed for manual anti-aliasing
                        ctx.beginPath();
                        ctx.arc(0, 0, r1, -arcWidthRad/2, arcWidthRad/2);
                        ctx.arc(0, 0, r2, arcWidthRad/2, -arcWidthRad/2, true);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                    }
                    currentColor = color;
                    startJ = j;
                }
            }
            ctx.restore();
        }
        ctx.restore();
        this._needsFullRedraw = false;
    },
    _drawIncremental: function(startAz, endAz) {
        if (!this._offscreenCanvas || !this._offscreenCtx) return;
        const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
        if (!station || !liveRadarData || !liveRadarData.elevations) return;

        const centerLayer = map.latLngToLayerPoint([station.lat, station.lon]);
        const center = { x: centerLayer.x - this._topLeft.x, y: centerLayer.y - this._topLeft.y };
        const pixelsPerKm = this._getPixelsPerKm(station.lat, station.lon);
        const dpr = window.devicePixelRatio || 1;

        const ctx = this._offscreenCtx;

        let momentKey = 'reflectivity';
        if (currentLiveMode === 'velocity') { momentKey = 'velocity'; }
        else if (currentLiveMode === 'debris') { momentKey = 'debris'; }

        let momentArray = [];
        for (let e = 1; e <= 5; e++) {
            const temp = liveRadarData.elevations[e] ? liveRadarData.elevations[e][momentKey] : null;
            if (temp && temp.some(m => m && m.moment_data)) { momentArray = temp; break; }
        }
        if (momentArray.length === 0) return;

        const azArray = liveRadarData.azimuths;
        const angularRes = 360 / azArray.length;
        const arcWidthRad = (angularRes * Math.PI / 180) * 2.5; 
        const gateStep = 1; 
        const scale = COLOR_SCALES[momentKey];

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.translate(center.x, center.y);
        ctx.globalAlpha = 1.0; 
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // 1. CLEAR A WEDGE AHEAD of the current sweep line (the 'dark' zone)
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        const clearStartRad = (endAz - 90) * Math.PI / 180;
        const clearEndRad = (endAz - 88) * Math.PI / 180; // Clear 2 degrees ahead (minimal gap)
        ctx.arc(0, 0, 460 * pixelsPerKm, clearStartRad, clearEndRad);
        ctx.lineTo(0, 0);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // 2. PAINT radials that fall within the sweep window (lastAngle to currentAngle)
        for (let i = 0; i < azArray.length; i++) {
            const radialAz = azArray[i];

            let isInside = false;
            if (startAz <= endAz) {
                isInside = (radialAz >= startAz && radialAz <= endAz);
            } else {
                isInside = (radialAz >= startAz || radialAz <= endAz);
            }

            if (!isInside) continue;

            const azimuth = (90 - radialAz) * Math.PI / 180;
            ctx.save();
            ctx.rotate(-azimuth);

            const moment = momentArray[i];
            if (moment && moment.moment_data) {
                const firstGateKm = moment.first_gate / 1000;
                const firstGateActual = firstGateKm < 1 ? moment.first_gate : firstGateKm;
                const gateSizeKm = moment.gate_size;
                const data = moment.moment_data;

                let startJ = null;
                let currentColor = null;

                for (let j = 0; j <= data.length; j += gateStep) {
                    const val = j < data.length ? data[j] : null;
                    const color = val !== null && val !== undefined ? scale(val) : null;
                    
                    if (color !== currentColor) {
                        if (currentColor !== null && startJ !== null) {
                            const r1 = (firstGateActual + startJ * gateSizeKm) * pixelsPerKm;
                            const r2 = (firstGateActual + j * gateSizeKm) * pixelsPerKm;
                            ctx.fillStyle = currentColor;
                            ctx.strokeStyle = currentColor;
                            ctx.lineWidth = 1.5;
                            ctx.beginPath();
                            ctx.arc(0, 0, r1, -arcWidthRad/2, arcWidthRad/2);
                            ctx.arc(0, 0, r2, arcWidthRad/2, -arcWidthRad/2, true);
                            ctx.closePath();
                            ctx.fill();
                            ctx.stroke();
                        }
                        currentColor = color;
                        startJ = j;
                    }
                }
                
                const roundedAz = Math.round(radialAz * 10) / 10;
                if (liveRadarData.radialsMap && liveRadarData.radialsMap.has(roundedAz)) {
                    const radial = liveRadarData.radialsMap.get(roundedAz);
                    radial.revealedUpdate = 1; // Mark as revealed
                }
                liveRadarData.revealedUpdate[i] = 1;
            }
            ctx.restore();
        }
        ctx.restore();
    },
    _draw: function() {
        if (!this._topLeft || !this._container || !this._offscreenCanvas) return;
        const ctx = this._container.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
        if (!station || !liveRadarData) return;

        const centerLayer = map.latLngToLayerPoint([station.lat, station.lon]);
        const center = { x: centerLayer.x - this._topLeft.x, y: centerLayer.y - this._topLeft.y };
        const pixelsPerKm = this._getPixelsPerKm(station.lat, station.lon);

        if (this._needsFullRedraw) {
            this._renderFull(center, pixelsPerKm);
        }

        ctx.clearRect(0, 0, this._container.width, this._container.height);
        ctx.drawImage(this._offscreenCanvas, 0, 0);
    }
});

function renderLiveRadar() {
    console.log('renderLiveRadar called, mode:', currentRadarMode, 'hasData:', !!liveRadarData);
    if (currentRadarMode !== 'live-tracking') return;
    if (!liveRadarData) return;

    if (!liveCanvasLayer) {
        console.log('Creating liveCanvasLayer');
        liveCanvasLayer = new RadarCanvasLayer();
        liveCanvasLayer.addTo(liveTrackingLayer);
    } else {
        // console.log('Updating liveCanvasLayer');
        // We do NOT set _needsFullRedraw = true here.
        // Setting it to true causes a full buffer clear which wipes the "painted" sweep data.
        // The animateSweep loop will call _draw() at 60fps, which is sufficient.
        liveCanvasLayer._draw();
    }
}

function initializeAppWithStations(data) {
    NEXRAD_STATIONS = data;
    console.log('NEXRAD Stations loaded:', NEXRAD_STATIONS.length);
    setupRadarSelector();
    setupLegendToggles();
    setupRadarButtons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        fetch('data/nexrad_stations.json').then(res => res.json()).then(initializeAppWithStations);
    });
} else {
    fetch('data/nexrad_stations.json').then(res => res.json()).then(initializeAppWithStations);
}
