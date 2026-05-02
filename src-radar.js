const { Level2Radar } = require('nexrad-level-2-data');

const parseRadarData = function(uint8array) {
    const buf = Buffer.from(uint8array);
    return new Level2Radar(buf);
};

// Use self as the primary global scope for both Workers and Browsers
if (typeof self !== 'undefined') {
    self.parseRadarData = parseRadarData;
} else if (typeof window !== 'undefined') {
    window.parseRadarData = parseRadarData;
} else if (typeof global !== 'undefined') {
    global.parseRadarData = parseRadarData;
}
