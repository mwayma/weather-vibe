const { Level2Radar } = require('nexrad-level-2-data');

window.parseRadarData = function(uint8array) {
    const buf = Buffer.from(uint8array);
    return new Level2Radar(buf);
};
