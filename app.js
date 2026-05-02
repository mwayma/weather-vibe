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

function checkRadarScan() {
    updateAlerts(); 
    
    const now = new Date();
    now.setMinutes(now.getMinutes() - 4);
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5);
    now.setSeconds(0);
    now.setMilliseconds(0);
    
    const latest = formatIEMTime(now);
    
    if (!isLooping) {
        document.getElementById('timestamp').innerText = `Last Checked: ${new Date().toLocaleTimeString()}`;
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
                document.getElementById('timestamp').innerText = `Loading loop frames (0/${loopTimestamps.length})...`;
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
                            document.getElementById('timestamp').innerText = `Loading loop frames (${loadedCount}/${loopTimestamps.length})...`;
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
        if (lastScanTime) document.getElementById('timestamp').innerText = `Last Checked: ${new Date().toLocaleTimeString()}`;
    }
}

function advanceLoop() {
    if (loopLayers.length === 0) return;
    loopLayers.forEach(layer => layer.setOpacity(0));
    loopLayers[currentLoopIndex].setOpacity(0.8);
    const ts = loopTimestamps[currentLoopIndex];
    const scanDate = new Date(ts);
    document.getElementById('timestamp').innerText = `Radar Scan: ${scanDate.toLocaleTimeString()} (Looping)`;
    currentLoopIndex = (currentLoopIndex + 1) % loopLayers.length;
}

// Live Tracking State
let liveTrackingLayer = L.layerGroup().addTo(map);
let radarStationMarker = null;
let azimuthLine = null;
let currentLiveMode = 'reflectivity'; // 'reflectivity', 'velocity', 'debris'
let liveRadarData = null;
let liveScanInterval = null;
let liveDataRefreshInterval = null;
let liveCanvasLayer = null;

let socket = null;
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
        console.log('WebSocket connected');
        if (currentRadarMode === 'live-tracking' && selectedRadarId && selectedRadarId !== 'composite') {
            socket.send(JSON.stringify({ action: 'subscribe', station: selectedRadarId }));
        }
    };

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'initial_state') {
            console.log('Received initial state from server');
            liveRadarData = message.data;
            if (liveRadarData) {
                // Initialize metadata arrays if missing
                if (!liveRadarData.lastUpdated) {
                    liveRadarData.lastUpdated = new Array(liveRadarData.azimuths.length).fill(Date.now());
                }
                if (!liveRadarData.revealedUpdate) {
                    // Start with everything revealed to avoid "black screen" on load
                    liveRadarData.revealedUpdate = [...liveRadarData.lastUpdated];
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
            console.log('Received real-time radial update:', message.chunk);
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
        console.warn('WebSocket disconnected, retrying...');
        setTimeout(initWebSocket, 5000);
    };
}

function mergeRealTimeData(newData) {
    if (!liveRadarData) {
        console.log('Initializing liveRadarData with real-time update');
        liveRadarData = {
            radialsMap: new Map(), // roundedAz -> { azimuth, timestamp, revealedUpdate, elevations }
            azimuths: [],
            lastUpdated: [],
            revealedUpdate: [],
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
                revealedUpdate: 0,
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

    syncLiveRadarArrays();
    
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
    for (let e = 1; e <= 5; e++) {
        liveRadarData.elevations[e] = {
            reflectivity: new Array(len).fill(null),
            velocity: new Array(len).fill(null),
            debris: new Array(len).fill(null)
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

const COLOR_SCALES = {
    reflectivity: (val) => {
        if (val === null || val < 5) return null;
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
        if (val === null) return null;
        if (val < -60) return '#00ff00';
        if (val < -40) return '#00cc00';
        if (val < -20) return '#008800';
        if (val < 0) return '#004400';
        if (val === 0) return '#777777';
        if (val < 20) return '#440000';
        if (val < 40) return '#880000';
        if (val < 60) return '#cc0000';
        return '#ff0000';
    },
    debris: (val) => {
        if (val === null || val < 0.7) return null;
        if (val < 0.8) return '#ff00ff'; 
        if (val < 0.9) return '#0000ff';
        if (val < 0.95) return '#00ffff';
        if (val < 0.98) return '#00ff00';
        return '#ffff00';
    }
};

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
        if (liveScanInterval) { clearInterval(liveScanInterval); liveScanInterval = null; }
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

    const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
    if (!station) return;

    radarStationMarker = L.circleMarker([station.lat, station.lon], {
        radius: 10, fillColor: '#ffffff', color: '#000', weight: 2, opacity: 1, fillOpacity: 1
    }).addTo(liveTrackingLayer);

    azimuthLine = L.polyline([[station.lat, station.lon], [station.lat, station.lon]], {
        color: '#ffffff', weight: 2, opacity: 0.8
    }).addTo(liveTrackingLayer);

    document.getElementById('timestamp').innerText = `Connecting to Live Stream: ${stationId}...`;
    
    if (liveScanInterval) clearInterval(liveScanInterval);
    if (liveDataRefreshInterval) clearInterval(liveDataRefreshInterval);

    function animateSweep() {
        // Reduced buffer to 15s for more real-time feel
        const SWEEP_BUFFER_MS = 15000; 
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
    }
    
    // Use setInterval instead of requestAnimationFrame to avoid Linux focus issues
    liveScanInterval = setInterval(animateSweep, 33); // ~30fps
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
        map.on('moveend', this._reset, this);
        this._reset();
    },
    onRemove: function(map) {
        if (this._container && this._container.parentNode) {
            this._container.parentNode.removeChild(this._container);
        }
        map.off('viewreset', this._reset, this); 
        map.off('moveend', this._reset, this);
        this._offscreenCanvas = null;
        this._offscreenCtx = null;
    },
    _getPixelsPerKm: function(stationLat, stationLon) {
        const centerLayer = map.latLngToLayerPoint([stationLat, stationLon]);
        const refPoint = L.latLng(stationLat + 0.899, stationLon);
        const refLayer = map.latLngToLayerPoint(refPoint);
        return centerLayer.distanceTo(refLayer) / 100;
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
        const arcWidthRad = (angularRes * Math.PI / 180) * 1.1; // Reduced multiplier for better precision
        const zoom = map.getZoom();
        const gateStep = zoom < 7 ? 4 : (zoom < 9 ? 2 : 1);
        const scale = COLOR_SCALES[momentKey];

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.translate(center.x, center.y);
        ctx.globalAlpha = 1.0;

        if (!liveRadarData.revealedUpdate) {
            liveRadarData.revealedUpdate = new Array(azArray.length).fill(0);
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
                        ctx.beginPath();
                        ctx.arc(0, 0, r1, -arcWidthRad/2, arcWidthRad/2);
                        ctx.arc(0, 0, r2, arcWidthRad/2, -arcWidthRad/2, true);
                        ctx.closePath();
                        ctx.fill();
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
        const arcWidthRad = (angularRes * Math.PI / 180) * 1.1;
        const zoom = map.getZoom();
        const gateStep = zoom < 7 ? 4 : (zoom < 9 ? 2 : 1);
        const scale = COLOR_SCALES[momentKey];

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.translate(center.x, center.y);
        ctx.globalAlpha = 1.0; 

        // 1. CLEAR the arc between startAz and endAz (continuous clearing)
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        // Canvas angles are clockwise from positive X-axis. 
        // Our azimuth is North-relative clockwise. 
        // Conversion: CanvasAngle = (Azimuth - 90) * PI / 180
        const startRad = (startAz - 90) * Math.PI / 180;
        const endRad = (endAz - 90) * Math.PI / 180;
        
        // Add a small buffer to the clear arc to avoid slivers
        const CLEAR_BUFFER = 0.02; 
        ctx.arc(0, 0, 460 * pixelsPerKm, startRad - CLEAR_BUFFER, endRad + CLEAR_BUFFER);
        ctx.lineTo(0, 0);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // 2. PAINT radials that fall within the sweep window
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
            const radialTs = liveRadarData.lastUpdated ? liveRadarData.lastUpdated[i] : 0;
            
            // We use a small lag buffer to ensure we aren't painting "ahead" of what's likely available in S3
            const SWEEP_BUFFER_MS = 45000;
            const isDataEligible = radialTs <= (Date.now() - SWEEP_BUFFER_MS);

            if (moment && moment.moment_data && isDataEligible) {
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
                            ctx.beginPath();
                            ctx.arc(0, 0, r1, -arcWidthRad/2, arcWidthRad/2);
                            ctx.arc(0, 0, r2, arcWidthRad/2, -arcWidthRad/2, true);
                            ctx.closePath();
                            ctx.fill();
                        }
                        currentColor = color;
                        startJ = j;
                    }
                }
                
                const roundedAz = Math.round(radialAz * 10) / 10;
                if (liveRadarData.radialsMap && liveRadarData.radialsMap.has(roundedAz)) {
                    const radial = liveRadarData.radialsMap.get(roundedAz);
                    radial.revealedUpdate = radialTs;
                }
                liveRadarData.revealedUpdate[i] = radialTs;
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

        // Linux/Chrome hack: tiny opacity change forces a compositor flush
        this._container.style.opacity = (this._container.style.opacity === '0.99') ? '1.0' : '0.99';
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
