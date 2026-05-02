// radar-worker.js
self.onmessage = function(e) {
    const { type, data, stationId } = e.data;
    
    if (type === 'parse_batch') {
        try {
            // If data is passed as a string (raw WS message), parse it here
            const message = typeof data === 'string' ? JSON.parse(data) : data;
            
            if (message.type === 'radial_batch') {
                const radials = message.radials.map(radial => {
                    const roundedAz = Math.round(radial.azimuth * 10) / 10;
                    return {
                        roundedAz,
                        radial
                    };
                });
                
                self.postMessage({
                    type: 'processed_batch',
                    radials: radials,
                    latestAzimuth: message.latestAzimuth,
                    stationId: message.stationId
                });
            } else {
                // Forward other message types back to main thread
                self.postMessage(message);
            }
        } catch (err) {
            console.error('Worker parse error:', err);
        }
    }
};
