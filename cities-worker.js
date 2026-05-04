// cities-worker.js
let allCities = [];

self.onmessage = function(e) {
    const { type, data } = e.data;
    
    if (type === 'init') {
        allCities = data;
        return;
    }
    
    if (type === 'update') {
        const { requestId, bounds, zoom, minGapLat, minGapLng, maxCitiesOnScreen } = data;
        const { south, north, west, east } = bounds;
        
        const visibleMarkers = [];

        for (let i = 0; i < allCities.length; i++) {
            const city = allCities[i];

            if (city.latitude >= south && city.latitude <= north && 
                city.longitude >= west && city.longitude <= east) {
                
                const isTooClose = visibleMarkers.some(m => {
                    return Math.abs(m.latitude - city.latitude) < minGapLat && 
                           Math.abs(m.longitude - city.longitude) < minGapLng;
                });

                if (!isTooClose) {
                    visibleMarkers.push(city);
                }
            }
            
            if (visibleMarkers.length >= maxCitiesOnScreen) {
                break;
            }
        }
        
        self.postMessage({ visibleMarkers, requestId });
    }
};
