# Local Weather Radar App

A standalone local web application that displays a high-contrast, news-style weather map with live radar and warning overlays.

## Features
- **Local Base Map**: Uses US Census GeoJSON for state and county boundaries (no Google/Bing/OSM tiles).
- **Live Radar**: National NEXRAD composite from Iowa State University (IEM).
- **Warning Fences**: Real-time polygons for Tornado, Severe Thunderstorm, and Flash Flood warnings from the NWS.
- **City Labels**: Major US cities for geographic context.

## How to Run
Due to browser security restrictions (CORS) when loading local JSON files, you must run this using a simple web server.

### Option 1: Python (Recommended)
If you have Python installed, run this command in the project directory:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000` in your browser.

### Option 2: Node.js
If you have `http-server` installed:
```bash
npx http-server
```

## Data Sources
- **Radar**: [Iowa State University IEM](https://mesonet.agron.iastate.edu/ogc/)
- **Warnings**: [National Weather Service API](https://api.weather.gov/)
- **Boundaries**: [Eric Celeste / US Census Bureau](https://eric.clst.org/tech/usgeojson/)
