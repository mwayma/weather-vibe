// radar-worker.js
self.onmessage = function(e) {
    const { type, data, stationId } = e.data;
    
    if (type === 'parse_batch') {
        try {
            const start = performance.now();
            const message = typeof data === 'string' ? JSON.parse(data) : data;
            if (!message) return;
            
            if (message.type === 'radial_batch') {
                const radials = message.radials.map(radial => {
                    const roundedAz = Math.round(radial.azimuth * 10) / 10;
                    return {
                        roundedAz,
                        radial
                    };
                });
                
                const end = performance.now();
                // console.log(`[Worker] Processed batch of ${radials.length} radials in ${(end - start).toFixed(2)}ms`);
                
                self.postMessage({
                    type: 'processed_batch',
                    radials: radials,
                    latestAzimuth: message.latestAzimuth,
                    stationId: message.stationId
                });
            } else if (message.type === 'initial_state') {
                const end = performance.now();
                console.log(`[Worker] Parsed initial_state in ${(end - start).toFixed(2)}ms`);
                self.postMessage(message);
            } else {
                self.postMessage(message);
            }
        } catch (err) {
            console.error('Worker parse error:', err);
        }
    }
};
