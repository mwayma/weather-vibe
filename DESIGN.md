# Design Document: Local Weather Radar App

## Overview
A standalone local web application that displays a high-contrast, news-style weather map. It features state and county boundaries, city names, a live national radar overlay, and active NWS weather warning "fences" (polygons).

## Tech Stack
- **Frontend**: HTML5, CSS3, Vanilla JavaScript.
- **Mapping Library**: Leaflet.js (for panning, zooming, and layer management).
- **Data Sources**:
    - **Boundaries**: Local GeoJSON (US States & Counties).
    - **Radar**: Iowa State University (IEM) NEXRAD tile service.
    - **Warnings**: National Weather Service (NWS) Public API (`api.weather.gov`).
    - **Cities**: Simple local JS object or GeoJSON for major cities.
- **Styling**: Dark mode/High-contrast aesthetic typical of broadcast weather graphics.

## Key Features
1. **Offline-ish Base Map**: Uses local GeoJSON for borders instead of external commercial tile services like Google/Bing.
2. **Live Radar**: Overlays the NEXRAD composite tile layer from IEM.
3. **Warning Fences**: Real-time polling of NWS alerts, drawing polygons for Tornado, Thunderstorm, and Flood warnings.
4. **City Overlay**: Labels for major cities to provide geographic context.

## Implementation Plan
1. **Phase 1: Project Setup**
    - Create `index.html`, `style.css`, and `app.js`.
    - Download US States and Counties GeoJSON files into a `data/` directory.
2. **Phase 2: Base Map & Boundaries**
    - Initialize Leaflet on a dark container.
    - Render State boundaries (thick, light-colored lines).
    - Render County boundaries (thin, darker lines).
3. **Phase 3: Weather Overlay**
    - Add the IEM NEXRAD tile layer.
    - Implement a simple refresh mechanism for radar.
4. **Phase 4: Warning Fences**
    - Fetch active alerts from `https://api.weather.gov/alerts/active?status=actual&message_type=alert`.
    - Filter for significant warnings (Tornado, Severe Thunderstorm, Flash Flood).
    - Render as polygons with color-coded styles.
5. **Phase 5: Context & UI**
    - Add city names as static markers or a GeoJSON layer.
    - Add a legend and a timestamp for the radar.

## Aesthetics
- **Background**: Deep Blue (#000033) or Black.
- **State Lines**: White or Silver.
- **County Lines**: Dark Grey.
- **Radar Opacity**: 0.6 - 0.8.
- **Warnings**: High-visibility neon colors.
