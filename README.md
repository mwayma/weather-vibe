# Weather Vibe

Weather Vibe is a local, browser-based radar console for monitoring current radar, live single-site NEXRAD chunks, and active National Weather Service alerts on a high-contrast map.

## What It Does

- Shows a national precipitation radar composite from Iowa State University IEM.
- Plays a short precipitation loop from recent WMS radar frames.
- Connects to a local WebSocket backend for live single-site Level II radar chunks.
- Renders live radar products on a custom Leaflet canvas layer:
  - composite reflectivity
  - base velocity
  - correlation coefficient
  - differential reflectivity
  - spectrum width
- Supports buffered live mode for smoother sweep playback and low-latency mode for faster updates.
- Draws the live sweep azimuth line above the radar canvas.
- Shows active NWS warning, watch, advisory, and statement polygons.
- Uses local GeoJSON for land, water, rivers, states, counties, and city labels.
- Uses a worker for city label filtering and collision reduction.
- Uses canvas renderers and cached live radar drawing to keep panning and zooming responsive.

## Running Locally

Install dependencies once:

```bash
npm install
```

Start the app server:

```bash
PORT=3000 node server.js
```

Open:

```text
http://localhost:3000
```

The Node server is required for the live radar WebSocket path. A static file server can load the map UI, but it will not provide the live Level II radar stream.

## UI Overview

- **Products** switches between precipitation, live radar, wind velocity, and temperature.
- **Live Radar** exposes product, tilt, and latency controls when live tracking is active.
- **Map Layers** toggles cities, roads, rivers, water, counties, and states.
- **Radar Site** selects the nearest radar site when single-site products are active.
- **Legend** shows active warning/watch categories and radar product scales.

## Data Sources

- **Radar WMS**: Iowa State University IEM
- **Live Level II chunks**: Unidata NEXRAD Level II chunk archive
- **Alerts**: National Weather Service API
- **Base geography**: local GeoJSON files in `data/`
- **Roads**: Esri World Transportation reference tiles

## Notes

This is situational-awareness software, not an official warning source. Always use official NWS products and local emergency guidance for safety decisions.
