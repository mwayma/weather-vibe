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

function updateLegend() {
    if (!activeAlertData || !activeAlertData.features) return;
    
    const types = {
        'tornado-warning': false,
        'tornado-watch': false,
        'thunderstorm-warning': false,
        'thunderstorm-watch': false,
        'hurricane': false,
        'flood': false,
        'marine': false,
        'snow': false,
        'winter-watch': false,
        'other-warning': false,
        'other-watch': false
    };

    const mapBounds = map.getBounds();

    activeAlertData.features.forEach(f => {
        if (!f.geometry) return;
        
        // Cache the calculated Leaflet bounds on the feature so we don't have to re-compute it every time you pan the map
        if (!f.properties._bounds) {
            f.properties._bounds = L.geoJSON(f).getBounds();
        }
        
        // Only flag the alert type as active if its boundaries physically intersect the boundaries of your browser screen
        if (f.properties._bounds.isValid() && mapBounds.intersects(f.properties._bounds)) {
            const type = getAlertType(f.properties.event);
            if (type) types[type] = true;
        }
    });

    // Update legend visibility based on the current viewport
    Object.keys(types).forEach(type => {
        const legendEl = document.getElementById(`legend-${type}`);
        if (legendEl) {
            legendEl.style.display = types[type] ? 'flex' : 'none';
        }
    });
    
    const anyWarnings = types['tornado-warning'] || types['thunderstorm-warning'] || types['hurricane'] || types['flood'] || types['marine'] || types['snow'] || types['other-warning'];
    const anyWatches = types['tornado-watch'] || types['thunderstorm-watch'] || types['winter-watch'] || types['other-watch'];
    
    const noAlerts = document.getElementById(`legend-no-alerts`);
    if (noAlerts) noAlerts.style.display = anyWarnings ? 'none' : 'flex';
    
    const noWatches = document.getElementById(`legend-no-watches`);
    if (noWatches) noWatches.style.display = anyWatches ? 'none' : 'flex';
}

function renderAlerts() {
    alertsLayer.clearLayers();
    if (!activeAlertData || !activeAlertData.features) return;
    
    // Pre-process features to synthesize geometries for county-based alerts that lack polygons
    activeAlertData.features.forEach(f => {
        if (!f.geometry && countiesData && f.properties.geocode?.SAME) {
            const coordinates = [];
            f.properties.geocode.SAME.forEach(fips => {
                const countyFips = fips.substring(1, 6); // Convert 6-digit NWS SAME code to 5-digit Census FIPS
                const countyFeature = countiesLookup[countyFips];
                if (countyFeature && countyFeature.geometry) {
                    if (countyFeature.geometry.type === 'Polygon') {
                        coordinates.push(countyFeature.geometry.coordinates);
                    } else if (countyFeature.geometry.type === 'MultiPolygon') {
                        coordinates.push(...countyFeature.geometry.coordinates); // Spread for multi-island counties
                    }
                }
            });
            if (coordinates.length > 0) {
                f.geometry = { type: 'MultiPolygon', coordinates: coordinates };
            }
        }
    });

    // Let the legend scanner determine visibility locally
    updateLegend();

    // Sort features by severity so more severe alerts are drawn last (on top)
    const sortedFeatures = [...activeAlertData.features].sort((a, b) => {
        return getAlertSeverity(a.properties.event) - getAlertSeverity(b.properties.event);
    });

    L.geoJSON({ type: 'FeatureCollection', features: sortedFeatures }, {
        filter: (f) => {
            const type = getAlertType(f.properties.event);
            
            // Filter out non-radar alerts AND user-toggled disabled alerts
            if (!type || disabledAlertTypes.has(type)) return false;
            return true;
        },
        style: (f) => getAlertStyle(f.properties.event),
        onEachFeature: (f, layer) => {
            let popupContent = `<div class="alert-popup">`;
            popupContent += `<h3>${f.properties.event}</h3>`;
            if (f.properties.headline) {
                popupContent += `<strong>${f.properties.headline}</strong><br><br>`;
            }
            if (f.properties.description) {
                popupContent += `<div class="alert-desc">${f.properties.description.replace(/\n/g, '<br>')}</div>`;
            }
            if (f.properties.instruction) {
                popupContent += `<strong>Instructions:</strong><div class="alert-inst">${f.properties.instruction.replace(/\n/g, '<br>')}</div>`;
            }
            popupContent += `</div>`;
            layer.bindPopup(popupContent, { maxWidth: 400, maxHeight: 300 });
        }
    }).addTo(alertsLayer);
    
}

// 4. Dynamic City Labels with Collision Detection
const cityLayer = L.layerGroup().addTo(map);
let allCities = [];
let isCitiesVisible = true;

// Load local cities as baseline
fetch('data/cities.json')
    .then(res => res.json())
    .then(cities => {
        allCities = cities.map(c => ({
            city: c.city,
            state: c.state,
            latitude: c.latitude,
            longitude: c.longitude,
            population: c.population,
            pop: parseInt(c.population) || 5000,
            station: c.station
        }));
        // Sort by population descending so we process larger cities first
        allCities.sort((a, b) => b.pop - a.pop);
        citiesWorker.postMessage({ type: 'init', data: allCities });
        updateVisibleCities();
    });

const citiesWorker = new Worker('cities-worker.js');
citiesWorker.onmessage = function(e) {
    const { visibleMarkers } = e.data;
    renderVisibleCities(visibleMarkers);
};

function updateVisibleCities() {
    if (!isCitiesVisible) return;
    if (!allCities || allCities.length === 0) return;
    
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    
    const data = {
        bounds: {
            south: bounds.getSouth(),
            north: bounds.getNorth(),
            west: bounds.getWest(),
            east: bounds.getEast()
        },
        zoom: zoom,
        minGapLat: 45 / Math.pow(2, zoom),
        minGapLng: 75 / Math.pow(2, zoom),
        maxCitiesOnScreen: zoom < 7 ? 12 : 25
    };

    citiesWorker.postMessage({ type: 'update', data });
}

function renderVisibleCities(visibleMarkers) {
    cityLayer.clearLayers();
    
    visibleMarkers.forEach(city => {
        let tempHtml = '';
        const safeCityId = (city.city + city.state).replace(/[^a-zA-Z0-9]/g, '');

        if (currentRadarMode === 'temperature' && city.station) {
            const stationId = city.station;
            if (stationTempsCache[stationId] && stationTempsCache[stationId] !== 'fetching') {
                tempHtml = `<div id="temp-${safeCityId}" class="station-${stationId}" style="color: #ffcc00; font-size: 1.1em; font-weight: bold; text-shadow: 1px 1px 2px #000;">${stationTempsCache[stationId]}&deg;</div>`;
            } else {
                tempHtml = `<div id="temp-${safeCityId}" class="station-${stationId}" style="color: #ffcc00; font-size: 1.1em; font-weight: bold; text-shadow: 1px 1px 2px #000;">...</div>`;
                fetchCityTempDisplay(city, safeCityId);
            }
        }

        const marker = L.marker(L.latLng(city.latitude, city.longitude), {
            icon: L.divIcon({
                className: 'city-label',
                html: `<div style="text-align: center;"><span>${city.city}</span>${tempHtml}</div>`,
                iconAnchor: [0, 0]
            }),
            interactive: true
        });
        
        marker.on('click', () => {
            fetchCityWeather(city, marker);
        });

        marker.addTo(cityLayer);
    });
}

async function fetchCityWeather(city, marker) {
    try {
        marker.bindPopup(`<div style="text-align:center;">Fetching weather...</div>`).openPopup();

        let stationId = city.station;

        if (!stationId) {
            // 1. Get the NWS grid point to find the nearest observation stations
            const pointRes = await fetch(`https://api.weather.gov/points/${city.latitude},${city.longitude}`);
            const pointData = await pointRes.json();
            
            // 2. Fetch the list of stations for this grid point and grab the closest one
            const stationsRes = await fetch(pointData.properties.observationStations);
            const stationsData = await stationsRes.json();
            stationId = stationsData.features[0].properties.stationIdentifier;
            city.station = stationId; // Cache it locally to save API calls in the future
        }

        // 3. Fetch the latest observation for the closest station using the NWS endpoint
        const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`);
        const obsData = await obsRes.json();
        
        const tempC = obsData.properties.temperature.value;
        const tempF = tempC !== null ? Math.round((tempC * 9/5) + 32) : '--';
        const desc = obsData.properties.textDescription || 'Unknown conditions';
        
        marker.setPopupContent(`
            <div style="text-align: center; min-width: 120px;">
                <strong>${city.city}</strong><br>
                <span style="font-size: 1.5em; font-weight: bold;">${tempF}&deg;F</span><br>
                ${desc}<br>
                <small style="color: #666; margin-top: 5px; display: block;">Station: ${stationId}</small>
            </div>
        `);
    } catch (err) {
        console.error('Error fetching NWS weather:', err);
        marker.setPopupContent('<div style="text-align:center;">Weather data unavailable</div>');
    }
}

async function fetchCityTempDisplay(city, safeCityId) {
    if (!city.station) return; // Only fetch if there is a known reporting station

    const stationId = city.station;

    if (stationTempsCache[stationId] === 'fetching') return; // Already fetching
    if (stationTempsCache[stationId]) {
        const tempDiv = document.getElementById(`temp-${safeCityId}`);
        if (tempDiv) tempDiv.innerHTML = `${stationTempsCache[stationId]}&deg;`;
        return;
    }
    
    stationTempsCache[stationId] = 'fetching';

    try {
        const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`);
        const obsData = await obsRes.json();
        
        const tempC = obsData.properties.temperature.value;
        if (tempC !== null) {
            const tempF = Math.round((tempC * 9/5) + 32);
            stationTempsCache[stationId] = tempF;
            // Bulk update all visible cities that share this station
            document.querySelectorAll(`.station-${stationId}`).forEach(el => el.innerHTML = `${tempF}&deg;`);
        } else {
            throw new Error("No temp data");
        }
    } catch (err) {
        console.debug('Failed to load temp for', city.city);
        stationTempsCache[stationId] = '--';
        document.querySelectorAll(`.station-${stationId}`).forEach(el => el.innerHTML = '--&deg;');
    }
}

// Global initialization
let selectedRadarId = ''; 
let NEXRAD_STATIONS = [];

function getNearbyRadars(maxDistance = 200) {
    if (!NEXRAD_STATIONS || NEXRAD_STATIONS.length === 0) return [];
    
    const bounds = map.getBounds();
    const centerLat = bounds.getCenter().lat;
    const centerLon = bounds.getCenter().lng;
    
    // Simple distance calculation (in miles, approximate)
    const toMiles = (lat1, lon1, lat2, lon2) => {
        const R = 3959; // Earth radius in miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };
    
    return NEXRAD_STATIONS
        .map(station => ({
            ...station,
            distance: toMiles(centerLat, centerLon, station.lat, station.lon)
        }))
        .filter(station => station.distance < maxDistance)
        .sort((a, b) => a.distance - b.distance);
}

function updateRadarSelector() {
    const select = document.getElementById('radar-select');
    if (!select) return;

    const nearbyRadars = getNearbyRadars();
    
    // Clear existing options except composite
    while (select.options.length > 1) {
        select.remove(1);
    }
    
    let isCurrentSelectionAvailable = (selectedRadarId === 'composite');

    // Add nearby radars
    nearbyRadars.forEach(radar => {
        const option = document.createElement('option');
        option.value = radar.id;
        option.text = `${radar.name} (${Math.round(radar.distance)} mi)`;
        select.appendChild(option);
        
        if (radar.id === selectedRadarId) {
            isCurrentSelectionAvailable = true;
        }
    });
    
    const needsSingleSite = currentRadarMode !== 'reflectivity';
    if (!isCurrentSelectionAvailable || selectedRadarId === '' || (selectedRadarId === 'composite' && needsSingleSite)) {
        if (nearbyRadars.length > 0) {
            selectedRadarId = nearbyRadars[0].id;
        } else {
            selectedRadarId = 'composite';
        }
        
        if (NEXRAD_STATIONS.length > 0) {
            updateRadarLayersBasedOnMode();
        }
    }
    
    select.value = selectedRadarId;
}

// Update radar selector on map move with debounce
let mapMoveTimeout = null;
function handleMapMove() {
    if (mapMoveTimeout) clearTimeout(mapMoveTimeout);
    mapMoveTimeout = setTimeout(() => {
        updateVisibleCities();
        updateRadarSelector();
        updateLegend();
    }, 500); // 500ms debounce
}

map.on('moveend', handleMapMove);
map.on('zoomend', handleMapMove);

// 5. Radar Scan Refresh Logic
function formatIEMTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00Z`;
}

function setTimestampForMode(mode, text) {
    if (currentRadarMode !== mode) return;
    const timestampEl = document.getElementById('timestamp');
    if (timestampEl) timestampEl.innerText = text;
}

function formatLag(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown lag';
    if (ms < 1000) return `${Math.round(ms)} ms lag`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} sec lag`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s lag`;
}

function checkRadarScan() {
    updateAlerts(); 
    
    const now = new Date();
    now.setMinutes(now.getMinutes() - 4);
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5);
    now.setSeconds(0);
    now.setMilliseconds(0);
    
    const latest = formatIEMTime(now);
    
    if (!isLooping) {
        setTimestampForMode('reflectivity', `Last Checked: ${new Date().toLocaleTimeString()}`);
    }
    
    if (latest !== lastScanTime) {
        lastScanTime = latest;
        
        const times = [];
        const latestDate = new Date(now.getTime());
        for (let i = 0; i < 6; i++) {
            const d = new Date(latestDate.getTime() - (i * 5 * 60000));
            times.push(formatIEMTime(d));
        }
        loopTimestamps = times.reverse(); 
        
        // Background load loop frames
        if (!isLooping) {
            if (typeof radarLayer !== 'undefined' && radarLayer && typeof radarLayer.setParams === 'function') {
                radarLayer.setParams({ _cb: new Date().getTime() }, false);
            }
            
            if (initialRadarLoadComplete) {
                preloadLoopLayers(loopTimestamps);
            } else {
                pendingLoopPreload = loopTimestamps;
            }
        } else {            if (loopLayers.length > 0) {
                const oldLayer = loopLayers.shift();
                map.removeLayer(oldLayer); 
                
                const newLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi', {
                    layers: 'nexrad-n0q-wmst',
                    format: 'image/png',
                    transparent: true,
                    opacity: 0,
                    time: latest,
                    attribution: 'Radar: IEM NEXRAD'
                }).addTo(map); 
                
                loopLayers.push(newLayer);
                currentLoopIndex = Math.max(0, currentLoopIndex - 1);
            }
        }
    }
}

checkRadarScan();
setInterval(checkRadarScan, 30000);
updateAlerts();

function preloadLoopLayers(timestamps) {
    // Clear existing loop layers if they exist and we're not looping
    if (!isLooping) {
        loopLayers.forEach(l => map.removeLayer(l));
        loopLayers = timestamps.map(ts => {
            return L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi', {
                layers: 'nexrad-n0q-wmst',
                format: 'image/png',
                transparent: true,
                opacity: 0, 
                time: ts,
                attribution: 'Radar: IEM NEXRAD'
            }).addTo(map);
        });
    }
}

// Radar Playback Loop functions
function toggleLoop() {
    const loopBtn = document.getElementById('btn-loop');
    isLooping = !isLooping;
    if (isLooping) {
        if (loopBtn) {
            loopBtn.classList.add('active');
            loopBtn.innerText = 'Stop Loop';
        }
        
        if (loopTimestamps.length > 0) {
            currentLoopIndex = 0;
            
            if (map.hasLayer(radarReflectivity)) map.removeLayer(radarReflectivity);
            
            // If we don't have loop layers yet (e.g. just started), load them
            if (loopLayers.length === 0) {
                let loadedCount = 0;
                setTimestampForMode('reflectivity', `Loading loop frames (0/${loopTimestamps.length})...`);
                loopLayers = loopTimestamps.map(ts => {
                    const layer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi', {
                        layers: 'nexrad-n0q-wmst',
                        format: 'image/png',
                        transparent: true,
                        opacity: 0, 
                        time: ts,
                        attribution: 'Radar: IEM NEXRAD'
                    });
                    
                    layer.on('load', function onLayerLoad() {
                        layer.off('load', onLayerLoad);
                        loadedCount++;
                        if (isLooping && !loopInterval) {
                            setTimestampForMode('reflectivity', `Loading loop frames (${loadedCount}/${loopTimestamps.length})...`);
                            if (loadedCount === loopTimestamps.length) {
                                loopInterval = setInterval(advanceLoop, 1000);
                                advanceLoop();
                            }
                        }
                    });
                    return layer.addTo(map);
                });
            } else {
                // Use already pre-loaded layers
                loopInterval = setInterval(advanceLoop, 1000);
                advanceLoop();
            }
        }
    } else {
        if (loopBtn) {
            loopBtn.classList.remove('active');
            loopBtn.innerText = 'Play Loop';
        }
        clearInterval(loopInterval);
        loopInterval = null;
        loopLayers.forEach(layer => layer.setOpacity(0)); // Keep them but hide them
        updateRadarLayersBasedOnMode();
        if (lastScanTime) setTimestampForMode('reflectivity', `Last Checked: ${new Date().toLocaleTimeString()}`);
    }
}

function advanceLoop() {
    if (loopLayers.length === 0) return;
    loopLayers.forEach(layer => layer.setOpacity(0));
    loopLayers[currentLoopIndex].setOpacity(0.8);
    const ts = loopTimestamps[currentLoopIndex];
    const scanDate = new Date(ts);
    setTimestampForMode('reflectivity', `Radar Scan: ${scanDate.toLocaleTimeString()} (Looping)`);
    currentLoopIndex = (currentLoopIndex + 1) % loopLayers.length;
}

// Live Tracking State
let liveTrackingLayer = L.layerGroup().addTo(map);
let radarStationMarker = null;
let azimuthLine = null;
let currentLiveMode = 'reflectivity'; // 'reflectivity', 'velocity', 'debris'
let liveRadarData = null;
let incomingRadialBuffer = new Map(); // roundedAz -> radial data
let liveScanInterval = null;
let liveDataRefreshInterval = null;
let liveCanvasLayer = null;
let targetAzimuth = 0;
let currentAngle = 0;
let sweepSpeed = 0.009; // Degrees per millisecond
let lastSweepTime = performance.now();
let lastAzimuthMetadataTime = 0;
let liveCanvasDrawPending = false;
let lastLiveStatusUpdate = 0;
let lastLiveDataMessageAt = Date.now();
let lastSocketMessageAt = Date.now();
let lastLiveResubscribeAt = 0;
let lastRenderedRadialTimestamp = 0;
let lastRenderedRadialAzimuth = null;
let lastReceivedRadialElevations = null;
let lastLiveStatusLabel = 'Live';

let liveReconnectInProgress = false;
let socketGeneration = 0;
let liveLatencyMode = 'buffered';
let bufferedRadialQueue = [];
const LIVE_STATUS_INTERVAL_MS = 1000;
const LIVE_DATA_STALE_MS = 25000;
const LIVE_DATA_RESUBSCRIBE_MS = 60000;
const LIVE_SOCKET_STALE_MS = 45000;
const LIVE_BUFFER_DELAY_MS = 15000;
const LIVE_BUFFER_MAX_EXTRA_LAG_MS = 600000; // 10 minutes history allowed in buffer
const MAX_BUFFERED_RADIALS_PER_FRAME = 40;
const MAX_BUFFERED_QUEUE_RADIALS = 5000;
const LIVE_RADIAL_DISPLAY_RESOLUTION_DEG = 0.5;

let socket = null;
function getCurrentStationId() {
    let currentStationId = selectedRadarId;
    if (currentStationId && currentStationId.length === 3) currentStationId = 'K' + currentStationId;
    return currentStationId;
}

function subscribeToLiveStation(initial = false) {
    const stationId = getCurrentStationId();
    if (socket && socket.readyState === WebSocket.OPEN && currentRadarMode === 'live-tracking' && stationId && stationId !== 'composite') {
        socket.send(JSON.stringify({ action: 'subscribe', station: stationId, initial }));
        lastLiveResubscribeAt = Date.now();
    }
}

function restartWebSocket(reason) {
    if (liveReconnectInProgress) return;
    liveReconnectInProgress = true;
    console.warn(`Restarting WebSocket: ${reason}`);

    const oldSocket = socket;
    if (oldSocket) {
        oldSocket.onclose = null;
        oldSocket.onerror = null;
        try { oldSocket.close(); } catch (e) {}
    }

    setTimeout(() => {
        liveReconnectInProgress = false;
        initWebSocket();
    }, 250);
}

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const generation = ++socketGeneration;
    socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
        if (generation !== socketGeneration) return;
        console.log('WebSocket connected');
        lastSocketMessageAt = Date.now();
        subscribeToLiveStation(!liveRadarData?.radialsMap?.size);
    };

    socket.onmessage = (event) => {
        if (generation !== socketGeneration) return;
        lastSocketMessageAt = Date.now();
        const message = JSON.parse(event.data);
        
        // 4-letter normalization for verification
        const currentStationId = getCurrentStationId();

        if (message.type === 'initial_state') {
            // Verify stationId to prevent cross-session contamination
            if (message.stationId && message.stationId !== currentStationId) {
                console.warn('Ignoring initial_state for mismatched station:', message.stationId);
                return;
            }

            console.log('Received initial state for', message.stationId);
            lastLiveDataMessageAt = Date.now();
            clearLivePlaybackState();
            if (liveCanvasLayer) liveCanvasLayer._clearOffscreen();
            liveRadarData = message.data;
            if (liveRadarData) {
                // Optimize memory: Convert moment_data to Uint8Array
                if (liveRadarData.elevations) {
                    for (const products of Object.values(liveRadarData.elevations)) {
                        for (const momentsArray of Object.values(products)) {
                            if (Array.isArray(momentsArray)) {
                                momentsArray.forEach(m => {
                                    if (m && m.moment_data && Array.isArray(m.moment_data)) {
                                        m.moment_data = new Uint8Array(m.moment_data);
                                    }
                                });
                            }
                        }
                    }
                }

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
                    const displayAzimuth = getDisplayAzimuth(az);
                    const mapKey = `${message.stationId || currentStationId}_${displayAzimuth.toFixed(1)}`;
                    const radialElevations = {};
                    for (const [e, products] of Object.entries(liveRadarData.elevations)) {
                        radialElevations[e] = {};
                        for (const [product, moments] of Object.entries(products)) {
                            radialElevations[e][product] = moments[i];
                        }
                    }
                    const existing = liveRadarData.radialsMap.get(mapKey);
                    if (!existing) {
                        liveRadarData.radialsMap.set(mapKey, {
                            azimuth: displayAzimuth,
                            sourceAzimuth: normalizeAzimuth(az),
                            timestamp: liveRadarData.timestamps[i],
                            revealedUpdate: liveRadarData.revealedUpdate[i],
                            elevations: radialElevations,
                            isNewDisplayRay: true
                        });
                    } else {
                        existing.timestamp = Math.max(existing.timestamp || 0, liveRadarData.timestamps[i] || 0);
                        existing.sourceAzimuth = normalizeAzimuth(az);
                        existing.revealedUpdate = liveRadarData.revealedUpdate[i];
                        for (const [e, products] of Object.entries(radialElevations)) {
                            if (!existing.elevations[e]) existing.elevations[e] = {};
                            for (const [product, moment] of Object.entries(products)) {
                                if (moment) existing.elevations[e][product] = moment;
                            }
                        }
                    }
                });
            }
            if (liveCanvasLayer) liveCanvasLayer._needsFullRedraw = true;
            renderLiveRadar();
        } else if (message.type === 'radial_batch') {
            // Verify stationId
            if (message.stationId && message.stationId !== currentStationId) return;
            lastLiveDataMessageAt = Date.now();

            // console.log(`Received batch of ${message.radials.length} radials`);
            if (message.latestAzimuth !== undefined && liveLatencyMode === 'low-latency') {
                targetAzimuth = normalizeAzimuth(message.latestAzimuth);
                lastAzimuthMetadataTime = performance.now();
            }

            const radials = message.radials.map(radial => {
                const roundedAz = Math.round(radial.azimuth * 10) / 10;
                
                // Optimize memory: Convert moment_data to Uint8Array
                if (radial.elevations) {
                    for (const products of Object.values(radial.elevations)) {
                        for (const m of Object.values(products)) {
                            if (m && m.moment_data && Array.isArray(m.moment_data)) {
                                m.moment_data = new Uint8Array(m.moment_data);
                            }
                        }
                    }
                }
                radial.azimuth = normalizeAzimuth(radial.azimuth);
                return { radial, roundedAz };
            });

            if (liveLatencyMode === 'buffered') {
                enqueueBufferedRadials(radials.map(item => item.radial));
            } else {
                radials.forEach(({ radial, roundedAz }) => applyLiveRadial(roundedAz, radial));
                recordRenderedRadials(radials.map(item => item.radial), 'Low Latency');
                renderLiveStatus(true);
                requestLiveCanvasDraw();
            }
        } else if (message.type === 'radial_update') {
            // Verify stationId
            if (message.stationId && message.stationId !== currentStationId) return;
            lastLiveDataMessageAt = Date.now();

            console.log('Received real-time update:', message.chunk);
            if (message.latestAzimuth !== undefined) {
                targetAzimuth = normalizeAzimuth(message.latestAzimuth);
                lastAzimuthMetadataTime = performance.now();
            }
            mergeRealTimeData(message.data);
            updateLiveDataTimestamp(message.data);
        } else if (message.type === 'clear_data') {
            if (message.stationId && message.stationId !== currentStationId) return;
            console.log('Server requested soft volume transition:', message.volumeId);
            window._lastSweepAngle = currentAngle;
            requestLiveCanvasDraw();
        } else if (message.type === 'volume_start') {
            if (message.stationId && message.stationId !== currentStationId) return;
            console.log('Server started new volume:', message.volumeId);
            window._lastSweepAngle = currentAngle;
        } else if (message.type === 'status') {
            console.log('WebSocket Status:', message.message);
        } else if (message.type === 'heartbeat') {
            // Heartbeat received, server is alive
        }
    };

    socket.onclose = () => {
        if (generation !== socketGeneration) return;
        console.warn('WebSocket disconnected, retrying...');
        setTimeout(initWebSocket, 1000);
    };

    socket.onerror = (error) => {
        if (generation !== socketGeneration) return;
        console.warn('WebSocket error:', error);
    };
}

setInterval(() => {
    if (currentRadarMode !== 'live-tracking') return;
    renderLiveStatus();

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    const now = Date.now();
    if ((now - lastSocketMessageAt) > LIVE_SOCKET_STALE_MS) {
        restartWebSocket('socket messages stale');
        return;
    }

    if ((now - lastLiveDataMessageAt) > LIVE_DATA_RESUBSCRIBE_MS && (now - lastLiveResubscribeAt) > LIVE_DATA_RESUBSCRIBE_MS) {
        console.warn('Live radial data stale; refreshing station subscription');
        subscribeToLiveStation();
    }
}, 1000);

function findStation(id) {
    if (!id || !NEXRAD_STATIONS) return null;
    const normalized = id.length === 3 ? 'K' + id.toUpperCase() : id.toUpperCase();
    return NEXRAD_STATIONS.find(s => s.id === normalized || s.id === normalized.slice(1));
}

function normalizeAzimuth(azimuth) {
    return ((Number(azimuth) % 360) + 360) % 360;
}

function getDisplayAzimuth(azimuth) {
    const normalized = normalizeAzimuth(azimuth);
    const quantized = Math.round(normalized / LIVE_RADIAL_DISPLAY_RESOLUTION_DEG) * LIVE_RADIAL_DISPLAY_RESOLUTION_DEG;
    return normalizeAzimuth(quantized);
}

function requestLiveCanvasDraw() {
    if (!liveCanvasLayer || liveCanvasDrawPending) return;
    liveCanvasDrawPending = true;
    requestAnimationFrame(() => {
        liveCanvasDrawPending = false;
        if (liveCanvasLayer) liveCanvasLayer._draw();
    });
}

function recordRenderedRadials(radials, label = 'Live') {
    if (!Array.isArray(radials) || radials.length === 0) return;

    const latest = radials.reduce((best, radial) => {
        const timestamp = Number(radial.timestamp);
        return Number.isFinite(timestamp) && timestamp > best.timestamp ? { timestamp, azimuth: radial.azimuth } : best;
    }, { timestamp: 0, azimuth: null });

    if (!latest.timestamp) return;

    lastRenderedRadialTimestamp = latest.timestamp;
    lastRenderedRadialAzimuth = Number.isFinite(Number(latest.azimuth)) ? normalizeAzimuth(latest.azimuth) : lastRenderedRadialAzimuth;
    lastReceivedRadialElevations = summarizeRadialElevations(radials);
    lastLiveStatusLabel = label;
}

function getLiveMomentKey() {
    if (currentLiveMode === 'velocity') return 'velocity';
    if (currentLiveMode === 'debris') return 'debris';
    if (currentLiveMode === 'zdr') return 'zdr';
    if (currentLiveMode === 'width') return 'width';
    return 'reflectivity';
}

function summarizeRadialElevations(radials) {
    const momentKey = getLiveMomentKey();
    const elevations = new Set();

    radials.forEach(radial => {
        for (const [e, products] of Object.entries(radial.elevations || {})) {
            const moment = products?.[momentKey];
            if (moment?.moment_data) elevations.add(Number(e));
        }
    });

    const sorted = Array.from(elevations).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    if (sorted.length === 1) return `Tilt ${sorted[0]}`;

    const first = sorted[0];
    const contiguous = sorted.every((value, index) => value === first + index);
    return contiguous ? `Tilts ${first}-${sorted[sorted.length - 1]}` : `Tilts ${sorted.join(',')}`;
}

function renderLiveStatus(force = false) {
    if (currentRadarMode !== 'live-tracking') return;
    const now = Date.now();
    if (!force && now - lastLiveStatusUpdate < LIVE_STATUS_INTERVAL_MS) return;

    const socketState = socket ? socket.readyState : WebSocket.CLOSED;
    const socketText = socketState === WebSocket.OPEN ? '' : ' | reconnecting';

    if (!lastRenderedRadialTimestamp) {
        const queueText = liveLatencyMode === 'buffered' && bufferedRadialQueue.length > 0
            ? ` | ${bufferedRadialQueue.length} queued`
            : '';
        setTimestampForMode('live-tracking', `${lastLiveStatusLabel}: waiting for live chunks${queueText}${socketText}`);
        lastLiveStatusUpdate = now;
        return;
    }

    const chunkDate = new Date(lastRenderedRadialTimestamp);
    const lagMs = now - lastRenderedRadialTimestamp;
    const azText = Number.isFinite(Number(lastRenderedRadialAzimuth)) ? ` | Az ${lastRenderedRadialAzimuth.toFixed(1)}°` : '';
    const scanText = lastReceivedRadialElevations ? ` | Scan ${lastReceivedRadialElevations}` : '';
    const viewText = selectedLiveElevation === 'auto'
        ? (currentLiveMode === 'reflectivity' ? ' | View Composite' : ' | View Base')
        : ` | View Tilt ${selectedLiveElevation}`;
    const staleText = (now - lastLiveDataMessageAt) > LIVE_DATA_STALE_MS
        ? ` | no chunks ${formatLag(now - lastLiveDataMessageAt).replace(' lag', '')}`
        : '';
    setTimestampForMode('live-tracking', `${lastLiveStatusLabel}: ${chunkDate.toLocaleTimeString()} | ${formatLag(lagMs)}${azText}${scanText}${viewText}${staleText}${socketText}`);
    lastLiveStatusUpdate = now;
}

function updateLiveDataTimestamp(data) {
    if (!data || !Array.isArray(data.timestamps)) return;
    const radials = data.timestamps.map((timestamp, i) => ({
        timestamp,
        azimuth: Array.isArray(data.azimuths) ? data.azimuths[i] : undefined
    }));
    recordRenderedRadials(radials);
    renderLiveStatus(true);
}

function enqueueBufferedRadials(radials) {
    if (!Array.isArray(radials) || radials.length === 0) return;
    const minTimestamp = Date.now() - LIVE_BUFFER_DELAY_MS - LIVE_BUFFER_MAX_EXTRA_LAG_MS;
    radials.forEach(radial => {
        if (!Number.isFinite(Number(radial.timestamp))) radial.timestamp = Date.now();
    });
    bufferedRadialQueue.push(...radials.filter(radial => radial.timestamp >= minTimestamp));
    bufferedRadialQueue.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    while (bufferedRadialQueue.length > 0 && bufferedRadialQueue[0].timestamp < minTimestamp) {
        bufferedRadialQueue.shift();
    }
    if (bufferedRadialQueue.length > MAX_BUFFERED_QUEUE_RADIALS) {
        bufferedRadialQueue.splice(0, bufferedRadialQueue.length - MAX_BUFFERED_QUEUE_RADIALS);
    }
}

function processBufferedRadials() {
    if (liveLatencyMode !== 'buffered' || bufferedRadialQueue.length === 0) return;

    const cutoff = Date.now() - LIVE_BUFFER_DELAY_MS;
    const ready = [];

    while (bufferedRadialQueue.length > 0 && ready.length < MAX_BUFFERED_RADIALS_PER_FRAME) {
        const next = bufferedRadialQueue[0];
        if (!Number.isFinite(Number(next.timestamp)) || next.timestamp > cutoff) break;
        ready.push(bufferedRadialQueue.shift());
    }

    if (ready.length === 0) return;

    ready.forEach(radial => {
        const roundedAz = getDisplayAzimuth(radial.azimuth);
        applyLiveRadial(roundedAz, radial);
    });

    const latestAzimuth = ready[ready.length - 1]?.azimuth;
    if (Number.isFinite(Number(latestAzimuth))) {
        targetAzimuth = normalizeAzimuth(latestAzimuth);
        lastAzimuthMetadataTime = performance.now();
    }

    recordRenderedRadials(ready, 'Buffered Live');
    renderLiveStatus(true);
    requestLiveCanvasDraw();
}

function clearLivePlaybackState() {
    bufferedRadialQueue = [];
    incomingRadialBuffer.clear();
    liveCanvasDrawPending = false;
    lastRenderedRadialTimestamp = 0;
    lastRenderedRadialAzimuth = null;
    lastReceivedRadialElevations = null;
}

function destroyLiveCanvasLayer() {
    if (!liveCanvasLayer) return;
    try {
        liveTrackingLayer.removeLayer(liveCanvasLayer);
    } catch (e) {
        console.warn('Unable to remove live canvas layer:', e);
    }
    liveCanvasLayer = null;
    liveCanvasDrawPending = false;
}

function setLiveLatencyMode(mode) {
    liveLatencyMode = mode === 'low-latency' ? 'low-latency' : 'buffered';
    bufferedRadialQueue = [];
    incomingRadialBuffer.clear();
    if (azimuthLine) {
        azimuthLine.setStyle({ opacity: liveLatencyMode === 'buffered' ? 0.8 : 0 });
    }
    requestLiveCanvasDraw();
}

function applyLiveRadial(roundedAz, radial) {
    const stationId = getCurrentStationId();
    if (radial.stationId && radial.stationId !== stationId) return;

    if (!liveRadarData || !liveRadarData.radialsMap) {
        liveRadarData = { 
            radialsMap: new Map(), 
            stationId: stationId,
            azimuths: [],
            lastUpdated: [],
            revealedUpdate: [],
            timestamps: [],
            elevations: {}
        };
    }
    
    const station = findStation(stationId);
    if (station) {
        radial.stationLat = station.lat;
        radial.stationLon = station.lon;
    }

    radial.azimuth = normalizeAzimuth(radial.azimuth);
    const displayAzimuth = getDisplayAzimuth(radial.azimuth);
    radial.revealedUpdate = 1;
    
    // Key by station and display azimuth so slightly offset tilts merge into one composite ray.
    const mapKey = `${stationId}_${displayAzimuth.toFixed(1)}`;
    
    if (!liveRadarData.radialsMap.has(mapKey)) {
        liveRadarData.radialsMap.set(mapKey, {
            azimuth: displayAzimuth,
            sourceAzimuth: radial.azimuth,
            timestamp: radial.timestamp,
            elevations: {},
            stationLat: station ? station.lat : null,
            stationLon: station ? station.lon : null,
            isNewDisplayRay: true
        });
    }

    const existingRadial = liveRadarData.radialsMap.get(mapKey);
    existingRadial.timestamp = radial.timestamp;
    existingRadial.sourceAzimuth = radial.azimuth;
    existingRadial.revealedUpdate = 1;

    // Merge new elevations into the existing radial
    if (radial.elevations) {
        for (const [e, products] of Object.entries(radial.elevations)) {
            if (!existingRadial.elevations[e]) existingRadial.elevations[e] = {};
            for (const [product, moment] of Object.entries(products)) {
                if (moment) existingRadial.elevations[e][product] = moment;
            }
        }
    }

    if (!liveCanvasLayer) {
        renderLiveRadar();
    } else {
        // Incremental draw is smoother and prevents full-screen flickers
        liveCanvasLayer._drawRadialToOffscreen(existingRadial);
        existingRadial.isNewDisplayRay = false;
        requestLiveCanvasDraw();
    }
}

function mergeRealTimeData(newData) {
    if (!liveRadarData) {
        console.log('Initializing liveRadarData with real-time update');
        liveRadarData = {
            radialsMap: new Map(), // roundedAz -> { azimuth, timestamp, elevations }
            azimuths: [],
            timestamps: [],
            elevations: {}
        };
    }

    if (!liveRadarData.radialsMap) {
        liveRadarData.radialsMap = new Map();
    }

    const now = Date.now();
    newData.azimuths.forEach((az, i) => {
        const roundedAz = Math.round(az * 10) / 10;
        const timestamp = (newData.timestamps && newData.timestamps[i]) ? newData.timestamps[i] : now;

        if (!liveRadarData.radialsMap.has(roundedAz)) {
            liveRadarData.radialsMap.set(roundedAz, {
                azimuth: az,
                timestamp: timestamp,
                elevations: {}
            });
        }

        const radial = liveRadarData.radialsMap.get(roundedAz);
        radial.timestamp = timestamp;

        for (const [e, elevations] of Object.entries(newData.elevations)) {
            if (!radial.elevations[e]) radial.elevations[e] = {};
            for (const [product, moments] of Object.entries(elevations)) {
                radial.elevations[e][product] = moments[i];
            }
        }
    });

    // CRITICAL: Ensure the layer exists and is ready to render
    if (!liveCanvasLayer) {
        renderLiveRadar();
    }
}

function syncLiveRadarArrays() {
    if (!liveRadarData || !liveRadarData.radialsMap) return;

    const sortedAzKeys = Array.from(liveRadarData.radialsMap.keys()).sort((a, b) => a - b);
    const len = sortedAzKeys.length;
    
    liveRadarData.azimuths = new Array(len);
    liveRadarData.lastUpdated = new Array(len);
    liveRadarData.revealedUpdate = new Array(len);
    liveRadarData.timestamps = new Array(len);
    
    // Pre-initialize elevation products with null arrays to ensure length consistency
    liveRadarData.elevations = {};
    for (let e = 1; e <= 22; e++) {
        liveRadarData.elevations[e] = {
            reflectivity: new Array(len).fill(null),
            velocity: new Array(len).fill(null),
            debris: new Array(len).fill(null),
            zdr: new Array(len).fill(null),
            width: new Array(len).fill(null)
        };
    }

    sortedAzKeys.forEach((key, i) => {
        const radial = liveRadarData.radialsMap.get(key);
        liveRadarData.azimuths[i] = radial.azimuth;
        liveRadarData.lastUpdated[i] = radial.timestamp;
        liveRadarData.revealedUpdate[i] = radial.revealedUpdate;
        liveRadarData.timestamps[i] = radial.timestamp;

        for (const [e, products] of Object.entries(radial.elevations)) {
            for (const [product, moment] of Object.entries(products)) {
                if (liveRadarData.elevations[e] && liveRadarData.elevations[e][product]) {
                    liveRadarData.elevations[e][product][i] = moment;
                }
            }
        }
    });
}

initWebSocket();

const COLOR_BINS = {
    reflectivity: [
        [5, null], [10, '#04e9e7'], [15, '#019ff4'], [20, '#0300f4'],
        [25, '#02fd02'], [30, '#01c501'], [35, '#008e00'],
        [40, '#fdf802'], [45, '#e5bc00'], [50, '#fd9500'],
        [55, '#fd0000'], [60, '#d40000'], [65, '#bc0000'],
        [70, '#f800fd'], [75, '#9854c6'], [Infinity, '#fdfdfd']
    ],
    velocity: [
        [-80, '#00ffff'], [-60, '#00ccff'], [-40, '#0099ff'],
        [-20, '#00ff00'], [-10, '#00c000'], [-5, '#007000'],
        [5, null], [10, '#700000'], [20, '#a00000'],
        [40, '#ff0000'], [60, '#ff9900'], [80, '#ffff00'],
        [Infinity, '#ffff00']
    ],
    debris: [
        [0.6, null], [0.75, '#6a00ff'], [0.82, '#0055ff'],
        [0.9, '#00d5ff'], [0.95, '#00ff00'], [0.98, '#ffff00'],
        [1.01, '#ff0000'], [Infinity, '#ffffff']
    ],
    zdr: [
        [-3, '#4d4d4d'], [-1, '#0066ff'], [0, '#00ccff'],
        [1, '#00ff00'], [2, '#ffff00'], [3, '#ff9900'],
        [5, '#ff0000'], [8, '#ff00ff'], [Infinity, '#ffffff']
    ],
    width: [
        [1, null], [2, '#4d4d4d'], [4, '#0055ff'],
        [6, '#00d5ff'], [8, '#00ff00'], [10, '#ffff00'],
        [14, '#ff9900'], [18, '#ff0000'], [Infinity, '#ff00ff']
    ]
};

const COLOR_SCALES = Object.fromEntries(Object.entries(COLOR_BINS).map(([product, bins]) => [
    product,
    (val) => {
        if (val === null || val === undefined || Number.isNaN(Number(val))) return null;
        const numeric = Number(val);
        const bin = bins.find(([upper]) => numeric < upper);
        return bin ? bin[1] : null;
    }
]));

    let selectedLiveElevation = 'auto'; // 'auto' or 1-22
function setupRadarButtons() {
    console.log('Initializing radar buttons...');
    const reflectivityBtn = document.getElementById('btn-reflectivity');
    const liveTrackingBtn = document.getElementById('btn-live-tracking');
    const velocityBtn = document.getElementById('btn-velocity');
    const temperatureBtn = document.getElementById('btn-temperature');
    const loopBtn = document.getElementById('btn-loop');
    
    const liveOptions = document.getElementById('live-tracking-options');
    const btnLiveReflectivity = document.getElementById('btn-live-reflectivity');
    const btnLiveVelocity = document.getElementById('btn-live-velocity');
    const btnLiveDebris = document.getElementById('btn-live-debris');
    const btnLiveBuffered = document.getElementById('btn-live-buffered');
    const btnLiveLowLatency = document.getElementById('btn-live-low-latency');

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

    const btnLiveZdr = document.getElementById('btn-live-zdr');
    const btnLiveWidth = document.getElementById('btn-live-width');
    const elevSelect = document.getElementById('live-elevation-select');

    if (elevSelect) {
        elevSelect.addEventListener('change', (e) => {
            selectedLiveElevation = e.target.value;
            console.log('Elevation selection changed to:', selectedLiveElevation);
            if (liveCanvasLayer) {
                liveCanvasLayer._needsFullRedraw = true;
                requestLiveCanvasDraw();
            }
        });
    }

    const setLiveView = (mode) => {
        currentLiveMode = mode;
        [btnLiveReflectivity, btnLiveVelocity, btnLiveDebris, btnLiveZdr, btnLiveWidth].forEach(btn => {
            if (btn) btn.classList.toggle('active', btn.id === `btn-live-${mode}`);
        });

        // Toggle legends
        ['reflectivity', 'velocity', 'debris', 'zdr', 'width'].forEach(l => {
            const el = document.getElementById(`live-${l}-legend`);
            if (el) el.style.display = l === mode ? 'block' : 'none';
        });

        if (liveCanvasLayer) {
            liveCanvasLayer._needsFullRedraw = true;
            requestLiveCanvasDraw();
        } else if (liveRadarData?.radialsMap?.size) {
            renderLiveRadar();
        }
    };

    if (btnLiveReflectivity) btnLiveReflectivity.onclick = () => setLiveView('reflectivity');
    if (btnLiveVelocity) btnLiveVelocity.onclick = () => setLiveView('velocity');
    if (btnLiveDebris) btnLiveDebris.onclick = () => setLiveView('debris');
    if (btnLiveZdr) btnLiveZdr.onclick = () => setLiveView('zdr');
    if (btnLiveWidth) btnLiveWidth.onclick = () => setLiveView('width');

    if (btnLiveBuffered) {
        btnLiveBuffered.addEventListener('click', () => {
            setLiveLatencyMode('buffered');
            btnLiveBuffered.classList.add('active');
            if (btnLiveLowLatency) btnLiveLowLatency.classList.remove('active');
            setTimestampForMode('live-tracking', `Buffered Live: waiting for ${Math.round(LIVE_BUFFER_DELAY_MS / 1000)}s buffer...`);
        });
    }

    if (btnLiveLowLatency) {
        btnLiveLowLatency.addEventListener('click', () => {
            setLiveLatencyMode('low-latency');
            btnLiveLowLatency.classList.add('active');
            if (btnLiveBuffered) btnLiveBuffered.classList.remove('active');
            setTimestampForMode('live-tracking', 'Low Latency: waiting for live chunks...');
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
    const liveLegendIds = ['reflectivity', 'velocity', 'debris', 'zdr', 'width'];
    liveLegendIds.forEach(product => {
        const legend = document.getElementById(`live-${product}-legend`);
        if (legend) legend.style.display = 'none';
    });

    if (currentRadarMode === 'live-tracking') {
        const activeLegend = document.getElementById(`live-${currentLiveMode}-legend`);
        if (activeLegend) activeLegend.style.display = 'block';
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
        destroyLiveCanvasLayer();
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
    if (stationId && stationId.length === 3) {
        stationId = 'K' + stationId;
        selectedRadarId = stationId;
    }

    // CRITICAL: Clear existing data to prevent geo-contamination
    liveRadarData = null;
    clearLivePlaybackState();
    currentAngle = 0;
    targetAzimuth = 0;
    lastAzimuthMetadataTime = 0;
    lastLiveStatusUpdate = 0;
    lastSweepTime = performance.now();

    // Fix memory leak: Remove old layers from liveTrackingLayer
    if (radarStationMarker) { liveTrackingLayer.removeLayer(radarStationMarker); radarStationMarker = null; }
    if (azimuthLine) { liveTrackingLayer.removeLayer(azimuthLine); azimuthLine = null; }
    destroyLiveCanvasLayer();

    const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
    if (!station) return;

    radarStationMarker = L.circleMarker([station.lat, station.lon], {
        radius: 10, fillColor: '#ffffff', color: '#000', weight: 2, opacity: 1, fillOpacity: 1
    }).addTo(liveTrackingLayer);

    azimuthLine = L.polyline([[station.lat, station.lon], [station.lat, station.lon]], {
        color: '#ffffff', weight: 2, opacity: liveLatencyMode === 'buffered' ? 0.8 : 0
    }).addTo(liveTrackingLayer);

    const liveModeLabel = liveLatencyMode === 'buffered'
        ? `Buffered Live: building ${Math.round(LIVE_BUFFER_DELAY_MS / 1000)}s buffer for ${stationId}...`
        : `Low Latency: connecting to ${stationId}...`;
    setTimestampForMode('live-tracking', liveModeLabel);
    subscribeToLiveStation(true);
    
    if (liveScanInterval) cancelAnimationFrame(liveScanInterval);
    if (liveDataRefreshInterval) clearInterval(liveDataRefreshInterval);

    function animateSweep() {
        const now = performance.now();
        const dt = now - lastSweepTime;
        lastSweepTime = now;

        const ageSinceMetadata = now - lastAzimuthMetadataTime;
        if (lastAzimuthMetadataTime && ageSinceMetadata < 2500) {
            const diff = ((targetAzimuth - currentAngle + 540) % 360) - 180;
            if (Math.abs(diff) > 0.2) {
                currentAngle = normalizeAzimuth(currentAngle + diff * Math.min(1, dt / 120));
            } else {
                currentAngle = targetAzimuth;
            }
        } else {
            currentAngle = normalizeAzimuth(currentAngle + sweepSpeed * dt);
        }
        
        window.currentScanAzimuth = currentAngle;
        
        const rad = (90 - currentAngle) * Math.PI / 180; 
        const dist = 3.5; 
        const endLat = station.lat + dist * Math.sin(rad);
        const endLon = station.lon + dist * Math.cos(rad);
        
        if (azimuthLine) {
            azimuthLine.setLatLngs([[station.lat, station.lon], [endLat, endLon]]);
        }

        processBufferedRadials();
        
        if (liveCanvasLayer && liveCanvasLayer._topLeft) {
            // Paint newly received radials immediately; the sweep is visual state, not a data gate.
            for (const [roundedAz, radial] of incomingRadialBuffer) {
                applyLiveRadial(roundedAz, radial);
                incomingRadialBuffer.delete(roundedAz);
            }
            requestLiveCanvasDraw();
        } else if (incomingRadialBuffer.size > 0) {
            // Initialize rendering if data is waiting
            for (const [roundedAz, radial] of incomingRadialBuffer) {
                applyLiveRadial(roundedAz, radial);
                incomingRadialBuffer.delete(roundedAz);
            }
            if (liveRadarData) renderLiveRadar();
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
        const pos = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._container, pos);
        this._topLeft = pos;
        this._updateCachedCoords();
        this._draw(); 
    },
    _getPixelsPerKm: function(stationLat, stationLon) {
        const centerLayer = map.latLngToLayerPoint([stationLat, stationLon]);
        const refPoint = L.latLng(stationLat + 0.00899, stationLon);
        const refLayer = map.latLngToLayerPoint(refPoint);
        return centerLayer.distanceTo(refLayer);
    },
    _updateCachedCoords: function() {
        const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
        if (!station || !this._topLeft) return;

        const dpr = window.devicePixelRatio || 1;
        const centerLayer = map.latLngToLayerPoint([station.lat, station.lon]);
        this._cachedCenter = { 
            x: (centerLayer.x - this._topLeft.x) * dpr, 
            y: (centerLayer.y - this._topLeft.y) * dpr 
        };
        this._cachedPixelsPerKm = this._getPixelsPerKm(station.lat, station.lon) * dpr;
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

        const pos = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._container, pos);
        this._topLeft = pos;
        this._updateCachedCoords();
        this._needsFullRedraw = true;
        this._draw();
    },
    _drawRadialToOffscreen: function(radial) {
        if (!this._offscreenCanvas || !this._offscreenCtx || !this._cachedCenter) return;
        
        const ctx = this._offscreenCtx;
        const center = this._cachedCenter;
        const pixelsPerKm = this._cachedPixelsPerKm;
        const momentKey = getLiveMomentKey();
        const scale = COLOR_SCALES[momentKey];
        if (!scale) return;

        const arcWidthRad = (LIVE_RADIAL_DISPLAY_RESOLUTION_DEG * Math.PI / 180) * 1.15;
        const gateStep = 1;
        const azimuth = normalizeAzimuth(radial.azimuth);
        let moment = null;

        if (selectedLiveElevation === 'auto') {
            if (currentLiveMode === 'reflectivity') {
                let compositeData = null;
                let bestMoment = null;
                
                for (let e = 1; e <= 22; e++) {
                    const m = radial.elevations[e]?.reflectivity;
                    if (m?.moment_data) {
                        if (!compositeData) {
                            compositeData = new Float32Array(m.moment_data.length).fill(-Infinity);
                            bestMoment = m;
                        }
                        for (let i = 0; i < m.moment_data.length; i++) {
                            if (m.moment_data[i] > compositeData[i]) {
                                compositeData[i] = m.moment_data[i];
                            }
                        }
                    }
                }
                if (bestMoment) {
                    moment = { ...bestMoment, moment_data: compositeData };
                }
            } else {
                for (let e = 1; e <= 22; e++) {
                    const candidate = radial.elevations[e]?.[momentKey];
                    if (candidate?.moment_data) {
                        moment = candidate;
                        break;
                    }
                }
            }
        } else {
            const e = parseInt(selectedLiveElevation);
            const candidate = radial.elevations[e]?.[momentKey];
            if (candidate?.moment_data) {
                moment = candidate;
            }
        }

        if (!moment?.moment_data) return;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate((azimuth - 90) * Math.PI / 180);

        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 500 * pixelsPerKm, -arcWidthRad / 2, arcWidthRad / 2);
        ctx.closePath();
        ctx.fill();

        ctx.globalCompositeOperation = 'source-over';
        try {
            // Scaling Fix: gate_size and first_gate
            const firstGateActual = (moment.first_gate > 1000) ? moment.first_gate / 1000 : moment.first_gate;
            const gateSizeKm = (moment.gate_size >= 1) ? moment.gate_size / 1000 : moment.gate_size;
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
                        ctx.beginPath();
                        ctx.arc(0, 0, r1, -arcWidthRad / 2, arcWidthRad / 2);
                        ctx.arc(0, 0, r2, arcWidthRad / 2, -arcWidthRad / 2, true);
                        ctx.closePath();
                        ctx.fill();
                    }
                    currentColor = color;
                    startJ = j;
                }
            }
        } finally {
            ctx.restore();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
        }
    },
    _clearOffscreen: function() {
        if (!this._offscreenCanvas || !this._offscreenCtx) return;
        const ctx = this._offscreenCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, this._offscreenCanvas.width, this._offscreenCanvas.height);
        this._needsFullRedraw = false;
    },
    _renderFull: function() {
        if (!this._offscreenCanvas || !this._offscreenCtx) return;
        this._clearOffscreen();
        if (!liveRadarData || !liveRadarData.radialsMap) return;
        for (const radial of liveRadarData.radialsMap.values()) {
            this._drawRadialToOffscreen(radial);
        }
        this._needsFullRedraw = false;
    },
    _draw: function() {
        if (!this._topLeft || !this._container || !this._offscreenCanvas) return;
        const ctx = this._container.getContext('2d');

        if (this._needsFullRedraw) {
            this._renderFull();
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
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
        if (liveCanvasLayer._needsFullRedraw) {
            liveCanvasLayer._renderFull();
        }
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
