# Weather App Improvement Goals

- [x] **1. Fix Radar Legend Spectrum:** Added missing CSS classes in `style.css` for all radar products (reflectivity, velocity, debris, ZDR, width).
- [x] **2. Correct Modal Icons (Sunrise/Sunset):** Implemented `adjustIconForTime` helper in `app.js` using fetched almanac data to dynamically swap /day/ and /night/ icons based on local sunrise/sunset times.
- [x] **3. Update Storm Attributes:**
    - [x] Changed labels for Rotation, Hail, and Core to use icons: 🔄 ROTATION, 🧊 HAIL, ⛈️ STORM CORE.
    - [x] Increased marker size to accommodate longer, more explicit names.
- [x] **4. Remove "Grid Temp (Map)":**
    - [x] Removed from city label click popup.
    - [x] Removed from modal current conditions view.
- [x] **5. Enhance High/Low Forecast:**
    - [x] Added Today's High and Low to the current weather view.
    - [x] Added "Next High" and "Next Low" metrics derived from the hourly forecast.
- [x] **6. Improve Temperature Grid Data:** Switched backend source from NDFD (forecast) to RTMA (Real-Time Mesoscale Analysis) in `server.js` for more accurate "current" condition representation.

## Progress Notes
- [2026-05-10] Initialized goals list and started research.
- [2026-05-10] Completed all requested improvements.
