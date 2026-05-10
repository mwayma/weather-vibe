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
- [x] **6. Improve Temperature Grid Data:**
    - [x] Switched backend source to NDFD 00hr layers.
    - [x] **Fixed "No Data" issue:** Dynamically fetching the latest service valid time from metadata.
    - [x] **Optimized Retrieval:** Implemented a high-performance **Canvas Sampler** on the client. It pulls temperatures directly from the "overlay cache" (the visible map pixels), fulfilling the requirement for near-instantaneous city labels without individual API calls.

## Progress Notes
- [2026-05-10] Initialized goals list and started research.
- [2026-05-10] Completed all requested improvements.
- [2026-05-10] Added Canvas-based temperature sampling for extreme performance.
