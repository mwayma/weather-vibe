// radar-worker.js
console.log('Radar Worker: Initializing...');
var window = self;

try {
    importScripts('radar-bundle.js');
    console.log('Radar Worker: Bundle loaded');
} catch (e) {
    console.error('Radar Worker: Failed to load radar-bundle.js:', e);
}

try {
    importScripts('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js');
    console.log('Radar Worker: Pako loaded');
} catch (e) {
    console.error('Radar Worker: Failed to load pako:', e);
}

self.onmessage = async function(e) {
    const { data, url } = e.data;
    console.log('Radar Worker: Processing', url);
    try {
        let uint8 = new Uint8Array(data);
        if (url.endsWith('.gz')) {
            if (typeof pako !== 'undefined') {
                uint8 = pako.ungzip(uint8);
            } else {
                throw new Error('Pako library not loaded');
            }
        }

        if (typeof self.parseRadarData !== 'function') {
            throw new Error('parseRadarData function not found');
        }

        console.log('Radar Worker: Starting parse...');
        const parsedRadar = self.parseRadarData(uint8);
        console.log('Radar Worker: Parse complete.');
        
        if (parsedRadar.isTruncated) {
            console.warn('Radar Worker: File is marked as truncated by library');
        }

        if (!parsedRadar.data || Object.keys(parsedRadar.data).length === 0) {
            throw new Error('Parsed radar data is empty');
        }

        // Extract necessary data to a plain object
        const elevations = [1, 2, 3, 4, 5];
        const extracted = {
            azimuths: [],
            elevations: {}
        };

        try {
            extracted.azimuths = parsedRadar.getAzimuth();
        } catch (e) {
            throw new Error('Failed to get azimuths: ' + e.message);
        }

        const methods = {
            reflectivity: 'getHighresReflectivity',
            velocity: 'getHighresVelocity',
            debris: 'getHighresCorrelationCoefficient'
        };

        const transfers = [];
        let hasAnyData = false;
        for (const e of elevations) {
            extracted.elevations[e] = {};
            try {
                parsedRadar.setElevation(e);
                for (const [key, method] of Object.entries(methods)) {
                    const moments = parsedRadar[method]();
                    if (moments && moments.some(m => m && m.moment_data)) {
                        hasAnyData = true;
                        extracted.elevations[e][key] = moments.map(m => {
                            if (!m) return null;
                            if (m.moment_data && m.moment_data.buffer) {
                                if (!transfers.includes(m.moment_data.buffer)) {
                                    transfers.push(m.moment_data.buffer);
                                }
                            }
                            return {
                                moment_data: m.moment_data,
                                first_gate: m.first_gate,
                                gate_size: m.gate_size
                            };
                        });
                    }
                }
            } catch (err) {}
        }

        if (!hasAnyData) {
            throw new Error('No valid radar moments found in file');
        }

        console.log('Radar Worker: Data extraction successful.');
        self.postMessage({ result: extracted, url: url }, transfers);
    } catch (err) {
        console.error('Radar Worker Error:', err.message);
        self.postMessage({ error: err.message, url: url });
    }
};
