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

// 1. Base Map Setup (Local GeoJSON) 
const stateStyle = { color: "#ffffff", weight: 2, opacity: 0.8, fillOpacity: 0, interactive: false };
const countyStyle = { color: "#444466", weight: 0.8, opacity: 0.5, fillOpacity: 0, interactive: false };

let countiesData = null;
const countiesLookup = {};

fetch('data/states.json').then(res => res.json()).then(data => L.geoJSON(data, { style: stateStyle }).addTo(map));
fetch('data/counties.json').then(res => res.json()).then(data => {
    countiesData = data;
    data.features.forEach(c => { countiesLookup[c.properties.STATE + c.properties.COUNTY] = c; });
    L.geoJSON(data, { style: countyStyle }).addTo(map);
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
    attribution: 'Temperature: NWS NDFD'
});

// Cache temperature lookups globally so we don't spam the NWS API when panning
const stationTempsCache = {};

// Track the currently active radar layer to allow redraws
let radarLayer = radarReflectivity;

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

function checkRadarStatus() {
    const warningDiv = document.getElementById('radar-status-warning');
    if (!selectedRadarId || selectedRadarId === 'composite') {
        warningDiv.style.display = 'none';
        return;
    }

    // IEM API endpoint for radar metadata
    const metaUrl = `https://mesonet.agron.iastate.edu/api/1/radar/${selectedRadarId}/meta`;

    fetch(metaUrl)
        .then(res => res.json())
        .then(meta => {
            if (meta && meta.vcp) {
                const vcp = meta.vcp;
                // VCPs 31 and 32 are common "Clear Air" modes where dual-pol products are often unavailable
                if (vcp === 31 || vcp === 32) {
                    warningDiv.innerText = `WARNING: ${selectedRadarId} is in Clear Air Mode (VCP ${vcp}). Velocity, CC, and ZDR products may be unavailable.`;
                    warningDiv.style.display = 'block';
                } else {
                    warningDiv.style.display = 'none';
                }
            } else {
                warningDiv.style.display = 'none';
            }
        })
        .catch(err => {
            console.debug('Could not fetch radar metadata:', err);
            warningDiv.style.display = 'none';
        });
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
            ...c,
            pop: parseInt(c.population) || 5000,
            latlng: L.latLng(c.latitude, c.longitude)
        }));
        // Sort by population descending so we process larger cities first
        allCities.sort((a, b) => b.pop - a.pop);
        updateVisibleCities();
    });

function updateVisibleCities() {
    if (!isCitiesVisible) return;
    if (!allCities || allCities.length === 0) return;
    
    cityLayer.clearLayers();

    const bounds = map.getBounds();
    const north = bounds.getNorth();
    const south = bounds.getSouth();
    const east = bounds.getEast();
    const west = bounds.getWest();
    const zoom = map.getZoom();
    
    // Calculate collision gaps based on zoom
    const minGapLat = 45 / Math.pow(2, zoom);
    const minGapLng = 75 / Math.pow(2, zoom); 
    
    // Dynamically limit how many cities to draw based on zoom level
    const maxCitiesOnScreen = zoom < 7 ? 12 : 25;
    
    const visibleMarkers = [];

    for (let i = 0; i < allCities.length; i++) {
        const city = allCities[i];

        // 1. Raw math check for bounding box (vastly faster than Leaflet's bounds.contains)
        if (city.latitude >= south && city.latitude <= north && 
            city.longitude >= west && city.longitude <= east) {
            
            // 2. Collision detection
            const isTooClose = visibleMarkers.some(m => {
                return Math.abs(m.latitude - city.latitude) < minGapLat && 
                       Math.abs(m.longitude - city.longitude) < minGapLng;
            });

            // 3. Add to map if it fits
            if (!isTooClose) {
                const marker = L.marker(city.latlng, {
                    icon: L.divIcon({
                        className: 'city-label',
                        html: `<span>${city.city}</span>`,
                        iconAnchor: [0, 0]
                    }),
                    interactive: true
                });
                
                marker.on('click', () => {
                    fetchCityWeather(city, marker);
                });

                // Store raw coords on the marker for faster collision checking
                marker.latitude = city.latitude;
                marker.longitude = city.longitude;
                
                marker.addTo(cityLayer);
                visibleMarkers.push(marker);
            }
        }
        
        // 4. THE MAGIC: Stop processing entirely once we have enough cities!
        if (visibleMarkers.length >= maxCitiesOnScreen) {
            break;
        }
    }
}

async function fetchCityWeather(city, marker) {
    try {
        marker.bindPopup(`<div style="text-align:center;">Fetching weather...</div>`).openPopup();

        // 1. Get the NWS grid point to find the nearest observation stations
        const pointRes = await fetch(`https://api.weather.gov/points/${city.latitude},${city.longitude}`);
        const pointData = await pointRes.json();
        
        // 2. Fetch the list of stations for this grid point and grab the closest one
        const stationsRes = await fetch(pointData.properties.observationStations);
        const stationsData = await stationsRes.json();
        const stationId = stationsData.features[0].properties.stationIdentifier;

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

async function fetchCityTempDisplay(city) {
    if (!city.station) return; // Only fetch if there is a known reporting station

    const cacheKey = city.city + city.state;
    if (stationTempsCache[cacheKey]) return; // Already fetched or fetching
    
    stationTempsCache[cacheKey] = 'fetching';
    const safeCityId = cacheKey.replace(/[^a-zA-Z0-9]/g, '');
    
    try {
        const obsRes = await fetch(`https://api.weather.gov/stations/${city.station}/observations/latest`);
        const obsData = await obsRes.json();
        
        const tempC = obsData.properties.temperature.value;
        if (tempC !== null) {
            const tempF = Math.round((tempC * 9/5) + 32);
            stationTempsCache[cacheKey] = tempF;
            document.querySelectorAll(`#temp-${safeCityId}`).forEach(el => el.innerHTML = `${tempF}&deg;`);
        } else {
            throw new Error("No temp data");
        }
    } catch (err) {
        console.debug('Failed to load temp for', city.city);
        stationTempsCache[cacheKey] = '--';
        document.querySelectorAll(`#temp-${safeCityId}`).forEach(el => el.innerHTML = '--&deg;');
    }
}

let selectedRadarId = ''; // Start empty so we can auto-select the nearest

function getNearbyRadars(maxDistance = 200) {
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
    
    // Default to the closest radar if no valid selection exists, or if a single-site mode is active but composite is selected
    const needsSingleSite = currentRadarMode !== 'reflectivity';
    if (!isCurrentSelectionAvailable || selectedRadarId === '' || (selectedRadarId === 'composite' && needsSingleSite)) {
        if (nearbyRadars.length > 0) {
            selectedRadarId = nearbyRadars[0].id;
        } else {
            selectedRadarId = 'composite';
        }
        
        // Only update layers if we actually changed the selection programmatically after initial load
        if (typeof NEXRAD_STATIONS !== 'undefined' && NEXRAD_STATIONS.length > 0) {
            updateRadarLayersBasedOnMode();
        }
    }
    
    select.value = selectedRadarId;
}

// Update radar selector on map move
map.on('moveend', () => {
    updateVisibleCities();
    updateRadarSelector();
    updateLegend();
});
map.on('zoomend', () => {
    updateVisibleCities();
    updateRadarSelector();
    updateLegend();
});

// 5. Radar Scan Refresh Logic
function formatIEMTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00Z`;
}

function checkRadarScan() {
    updateAlerts(); // Fetch live NWS data in background every 30 seconds
    
    // We bypass the IEM GetCapabilities endpoint due to a server-side XML timezone bug.
    // Instead, calculate the latest available 5-minute interval using the local clock.
    // IEM NEXRAD composites take ~4 minutes to render, so we subtract 4 minutes 
    // to ensure we only request tiles that have finished processing.
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
        
        // Rebuild loop timestamps based on the exact calculated time
        const times = [];
        const latestDate = new Date(now.getTime());
        for (let i = 0; i < 12; i++) {
            const d = new Date(latestDate.getTime() - (i * 5 * 60000));
            times.push(formatIEMTime(d));
        }
        loopTimestamps = times.reverse(); // Oldest to newest
        
        if (!isLooping) {
            if (typeof radarLayer !== 'undefined' && typeof radarLayer.setParams === 'function') {
                // Update cachebuster to force Leaflet to fetch the new tiles
                radarLayer.setParams({ _cb: new Date().getTime() }, false);
            }
            checkRadarStatus(); // Check the radar's operational mode
        } else {
            // We are looping. Seamlessly update the preloaded buffer.
            if (loopLayers.length > 0) {
                const oldLayer = loopLayers.shift();
                map.removeLayer(oldLayer); // Remove oldest frame
                
                const newLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi', {
                    layers: 'nexrad-n0q-wmst',
                    format: 'image/png',
                    transparent: true,
                    opacity: 0,
                    time: latest,
                    attribution: 'Radar: IEM NEXRAD'
                }).addTo(map); // Pre-load newest frame in the background
                
                loopLayers.push(newLayer);
                
                // Adjust the loop index back by 1 since we shifted the array left,
                // ensuring the playback animation doesn't skip a frame
                currentLoopIndex = Math.max(0, currentLoopIndex - 1);
            }
        }
    }
}

checkRadarScan();
setInterval(checkRadarScan, 30000);
updateAlerts();

// Radar Playback Loop functions
function toggleLoop() {
    const loopBtn = document.getElementById('btn-loop');
    isLooping = !isLooping;
    if (isLooping) {
        loopBtn.classList.add('active');
        loopBtn.innerText = 'Stop Loop';
        
        if (loopTimestamps.length > 0) {
            currentLoopIndex = 0;
            
            let loadedCount = 0;
            document.getElementById('timestamp').innerText = `Loading loop frames (0/${loopTimestamps.length})...`;
            
            // Hide the live WMS layer
            if (map.hasLayer(radarReflectivity)) {
                map.removeLayer(radarReflectivity);
            }
            
            // Pre-load all 12 historical frames as invisible layers to buffer them
            loopLayers = loopTimestamps.map(ts => {
                const layer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi', {
                    layers: 'nexrad-n0q-wmst',
                    format: 'image/png',
                    transparent: true,
                    opacity: 0, // Hidden while downloading
                    time: ts,
                    attribution: 'Radar: IEM NEXRAD'
                });
                
                layer.on('load', function onLayerLoad() {
                    layer.off('load', onLayerLoad); // Stop listening once loaded
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
        }
    } else {
        loopBtn.classList.remove('active');
        loopBtn.innerText = 'Play Loop';
        clearInterval(loopInterval);
        loopInterval = null;
        
        // Remove all pre-loaded loop layers
        loopLayers.forEach(layer => map.removeLayer(layer));
        loopLayers = [];
        
        // Revert to live WMS endpoint cleanly by re-initializing the layer
        updateRadarLayersBasedOnMode();
        
        if (lastScanTime) {
            document.getElementById('timestamp').innerText = `Last Checked: ${new Date().toLocaleTimeString()}`;
        }
    }
}

function advanceLoop() {
    if (loopLayers.length === 0) return;
    
    // Hide all layers
    loopLayers.forEach(layer => layer.setOpacity(0));
    
    // Show the current frame
    loopLayers[currentLoopIndex].setOpacity(0.8);
    
    const ts = loopTimestamps[currentLoopIndex];
    const scanDate = new Date(ts);
    document.getElementById('timestamp').innerText = `Radar Scan: ${scanDate.toLocaleTimeString()} (Looping)`;
    
    currentLoopIndex = (currentLoopIndex + 1) % loopLayers.length;
}

// 6. Radar Control Buttons
function setupRadarButtons() {
    const reflectivityBtn = document.getElementById('btn-reflectivity');
    const velocityBtn = document.getElementById('btn-velocity');
    const temperatureBtn = document.getElementById('btn-temperature');
    const loopBtn = document.getElementById('btn-loop');
    const reflectivityLegend = document.getElementById('reflectivity-legend');
    const velocityLegend = document.getElementById('velocity-legend');
    
    const chkCities = document.getElementById('chk-cities');
    const chkRoads = document.getElementById('chk-roads');
    const chkCounties = document.getElementById('chk-counties');
    const chkStates = document.getElementById('chk-states');
    const chkTempGradient = document.getElementById('chk-temp-gradient');
    const mapLayersToggle = document.getElementById('map-layers-toggle');
    const mapLayersContent = document.getElementById('map-layers-content');
    const weatherViewsToggle = document.getElementById('weather-views-toggle');
    const weatherViewsContent = document.getElementById('weather-views-content');

    reflectivityBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (reflectivityBtn.classList.contains('active')) {
            // If it's active, turn it off
            currentRadarMode = 'none';
            reflectivityBtn.classList.remove('active');
            reflectivityLegend.style.display = 'none';
        } else {
            // If it's not active, turn it on
            currentRadarMode = 'reflectivity';
            reflectivityBtn.classList.add('active');
            velocityBtn.classList.remove('active');
            if (temperatureBtn) temperatureBtn.classList.remove('active');
            reflectivityLegend.style.display = 'block';
            velocityLegend.style.display = 'none';
        }
        updateRadarLayersBasedOnMode();
    });
    
    velocityBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (velocityBtn.classList.contains('active')) {
            // If it's active, turn it off
            currentRadarMode = 'none';
            velocityBtn.classList.remove('active');
            velocityLegend.style.display = 'none';
        } else {
            // If it's not active, turn it on
            currentRadarMode = 'velocity';
            if (selectedRadarId === 'composite') {
                updateRadarSelector(); // Auto-switch to local radar
            }
            velocityBtn.classList.add('active');
            reflectivityBtn.classList.remove('active');
            if (temperatureBtn) temperatureBtn.classList.remove('active');
            velocityLegend.style.display = 'block';
            reflectivityLegend.style.display = 'none';
        }
        updateRadarLayersBasedOnMode();
    });
    
    if (temperatureBtn) {
        temperatureBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (temperatureBtn.classList.contains('active')) {
                currentRadarMode = 'none';
                temperatureBtn.classList.remove('active');
            } else {
                currentRadarMode = 'temperature';
                temperatureBtn.classList.add('active');
                reflectivityBtn.classList.remove('active');
                velocityBtn.classList.remove('active');
                reflectivityLegend.style.display = 'none';
                velocityLegend.style.display = 'none';
            }
            updateRadarLayersBasedOnMode();
        });
    }

    if (chkCities) {
        chkCities.addEventListener('change', (e) => {
            isCitiesVisible = e.target.checked;
            if (isCitiesVisible) {
                map.addLayer(cityLayer);
                updateVisibleCities();
            } else {
                map.removeLayer(cityLayer);
            }
        });
    }
    
    if (chkRoads) {
        chkRoads.addEventListener('change', (e) => {
            isRoadsVisible = e.target.checked;
            if (isRoadsVisible) {
                map.addLayer(roadsLayer);
            } else {
                map.removeLayer(roadsLayer);
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
        chkTempGradient.addEventListener('change', () => {
            updateRadarLayersBasedOnMode();
        });
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
    
    if (loopBtn) {
        loopBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
            renderAlerts(); // Redraw layer based on new toggle state
        });
    });
}

// Set up buttons once DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupRadarButtons);
} else {
    setupRadarButtons();
}

// 7. Radar Selector Handler
function setupRadarSelector() {
    const radarSelect = document.getElementById('radar-select');
    
    if (!radarSelect) {
        console.error('Radar selector not found in DOM');
        return;
    }
    
    radarSelect.addEventListener('change', (e) => {
        selectedRadarId = e.target.value;
        console.log('Radar selected:', selectedRadarId);        
        updateRadarLayersBasedOnMode();
        checkRadarStatus();
    });
    
    // Initial population
    updateRadarSelector();
}

function updateVelocityLayer() {
    // Remove the old radarVelocity layer if it exists on the map
    if (map.hasLayer(radarVelocity)) {
        map.removeLayer(radarVelocity);
    }

    if (!selectedRadarId || selectedRadarId === 'composite') {
        console.log('Velocity data requires a specific radar station selection.');
        radarVelocity = L.layerGroup(); // Empty layer to prevent WMS 400 errors
        return;
    } else {
        // Find the selected radar station
        const station = NEXRAD_STATIONS.find(s => s.id === selectedRadarId);
        if (!station) {
            console.error('Radar station not found:', selectedRadarId);
            radarVelocity = L.layerGroup(); 
            return;
        }
        // IEM uses a specific ridge.cgi endpoint for single-site radar data
        const specificWmsUrl = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/ridge.cgi';
        // IEM ridge expects a 3-character uppercase sector ID (e.g., 'LZK' instead of 'KLZK')
        const sectorId = station.id.length === 4 ? station.id.substring(1).toUpperCase() : station.id.toUpperCase();
        console.log('Updating velocity layer for station:', station.id, 'using sector:', sectorId);
        
        radarVelocity = L.tileLayer.wms(specificWmsUrl, {
            layers: 'single', // The target WMS layer for individual stations is 'single'
            sector: sectorId, // 3-character Station ID
            prod: 'N0U', // Product ID (N0U for base velocity)
            format: 'image/png',
            transparent: true,
            opacity: 0.8,
            attribution: `Radar: IEM NEXRAD (${station.id})`
        });
    }
}

function updateReflectivityLayer() {
    if (map.hasLayer(radarReflectivity)) {
        map.removeLayer(radarReflectivity);
    }
    // Re-initialize the reflectivity layer (it's always composite for reflectivity)
    radarReflectivity = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
        layers: 'nexrad-n0q',
        format: 'image/png',
        transparent: true,
        opacity: 0.8,
        attribution: 'Radar: IEM NEXRAD'
    });
}

// New function to manage radar layer visibility based on current mode
function updateRadarLayersBasedOnMode() {
    const loopBtn = document.getElementById('btn-loop');
    const precipOptions = document.getElementById('precip-options');
    const tempOptions = document.getElementById('temp-options');

    // Toggle sub-menus
    if (precipOptions) precipOptions.style.display = (currentRadarMode === 'reflectivity') ? 'block' : 'none';
    if (tempOptions) tempOptions.style.display = (currentRadarMode === 'temperature') ? 'block' : 'none';

    // Clean up all potential layers first
    if (map.hasLayer(radarReflectivity)) {
        map.removeLayer(radarReflectivity);
    }
    if (map.hasLayer(radarVelocity)) {
        map.removeLayer(radarVelocity);
    }
    if (map.hasLayer(radarTemperature)) {
        map.removeLayer(radarTemperature);
    }

    // Stop loop if it's running and we're not in a mode that supports it
    if (currentRadarMode !== 'reflectivity' && isLooping) {
        toggleLoop();
    }
    loopBtn.disabled = (currentRadarMode !== 'reflectivity');

    if (currentRadarMode === 'reflectivity') {
        loopBtn.disabled = false;
        updateReflectivityLayer();
        map.addLayer(radarReflectivity);
        radarLayer = radarReflectivity;
    } else if (currentRadarMode === 'velocity') {
        loopBtn.disabled = true;
        updateVelocityLayer();
        map.addLayer(radarVelocity);
        radarLayer = radarVelocity;
    } else if (currentRadarMode === 'temperature') {
        const chkTempGradient = document.getElementById('chk-temp-gradient');
        if (chkTempGradient && chkTempGradient.checked) {
            map.addLayer(radarTemperature);
            radarLayer = radarTemperature;
        } else {
            radarLayer = null;
        }
    } else { // 'none' state
        radarLayer = null; // No active layer
    }

    // Re-render cities so their temperatures show/hide accordingly
    if (isCitiesVisible) {
        updateVisibleCities();
    }
}

// Initial setup when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        fetch('data/nexrad_stations.json')
            .then(res => res.json())
            .then(data => {
                NEXRAD_STATIONS = data;
                setupRadarSelector(); // Call setupRadarSelector after NEXRAD_STATIONS is loaded
                setupLegendToggles(); // Bind legend click events
            })
            .catch(err => console.error('Error loading NEXRAD stations:', err));
    });
} else {
    fetch('data/nexrad_stations.json')
        .then(res => res.json())
        .then(data => {
            NEXRAD_STATIONS = data;
            setupRadarSelector(); // Call setupRadarSelector after NEXRAD_STATIONS is loaded
            setupLegendToggles();
        })
        .catch(err => console.error('Error loading NEXRAD stations:', err));
}
