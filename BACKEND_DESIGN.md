# Design Document: Real-Time Radar Processing Backend

## 1. Overview
The current client-side application successfully decodes NEXRAD Level 2 volume scans directly in the browser. However, due to the nature of NOAA's 5-minute volume scan release cycle, true "live" sub-minute animation is impossible via static file polling.

This document outlines the architecture for an **On-Demand Real-Time Radar Backend**. This backend will only process data for radar stations actively being viewed by a user, parsing sub-minute data "chunks" and pushing them to the client via WebSockets to achieve a broadcast-quality, fluid radar visualization.

This app is for personal amusement to track weather events as they unfold. The live radar tracking must be as near real-time as possible, and highly performant for the end-user. The interface must be responsive, ensuring functionality on mobile browsers is equal to that of desktop browsers.

## 2. Architecture & Tech Stack

*   **Backend Server:** Node.js or Python (FastAPI).
    *   *Node.js Advantage:* Can easily reuse the existing `nexrad-level-2-data` library (which natively supports chunked processing in its v2+ API).
    *   *Python Advantage:* Access to `Py-ART` (Python ARM Radar Toolkit), the industry standard for meteorological data processing, interpolation, and grid mapping.
*   **Real-Time Transport:** WebSockets (e.g., `Socket.io` or standard `ws`).
*   **Data Source:** AWS S3 `unidata-nexrad-level2-chunks` bucket.
*   **Containerization & CI/CD:**
    *   **Containerization:** Docker container wrapping the application (initially Nginx for static assets, moving to a Node.js/Python backend later). Automated via GitHub Actions.
    *   **Orchestration:** Deployed to a Kubernetes cluster using ArgoCD Autopilot for GitOps deployment.
    *   **Hostname:** Exposed at `weather.waymack.org`.

## 3. Core Data Flow (On-Demand Model)

To save compute costs, the backend will **not** process all 160+ NEXRAD stations simultaneously. It will operate purely on-demand based on client connections.

1.  **Client Connection:** User opens the app and selects "Live Tracking" for station `KLZK`.
2.  **Subscription Request:** The client opens a WebSocket connection to the backend and sends: `{"action": "subscribe", "station": "KLZK"}`.
3.  **Backend Registry:** The backend adds the client's socket ID to a "KLZK Listeners" pool. If this is the *first* listener for KLZK, the backend spawns a dedicated worker/polling loop for KLZK.
4.  **Chunk Polling:** The backend rapidly polls the S3 chunk bucket (`unidata-nexrad-level2-chunks`) for new partial-scan files for `KLZK` (released every few seconds as the dish spins).
5.  **Parsing & Assembly:** The backend downloads the binary chunk, parses it using `nexrad-level-2-data`, and extracts the new radials.
6.  **Data Push:** The backend converts the new radials into a highly compressed format (e.g., a slim JSON array or binary Protobuf) and pushes it over the WebSocket to all clients in the `KLZK Listeners` pool.
7.  **Client Render:** The browser receives the new radials instantly and paints them onto the Leaflet Canvas, creating a smooth, sweeping update across the screen.
8.  **Cleanup:** When the last client unsubscribes from `KLZK`, the backend terminates the polling loop for that station, freeing up CPU and network resources.

## 4. Addressing "Smoothness" (Interpolation)

Even with sub-minute chunks, radar data arrives in discrete slices. To achieve the "buttery smooth" morphing seen on TV broadcasts, the backend can implement **Motion Vector Interpolation**:

1.  **Grid Transformation:** The backend converts the raw polar data (radials/azimuths) into a Cartesian grid (a 2D image matrix).
2.  **Optical Flow:** The backend compares the current scan to the previous scan and calculates the velocity and direction (motion vectors) of every storm cell.
3.  **Intermediate Frames:** Based on the vectors, the backend calculates where the storm will be 1 second from now, 2 seconds from now, etc., generating "fake" intermediate frames.
4.  **Streaming:** The backend streams these interpolated frames to the client at 30-60 FPS, completely decoupling the visual animation from the radar's physical rotation speed.

## 5. Client-Side (Browser) Changes

If moving to this architecture, the client app (`app.js`) will become significantly "dumber" and faster:

*   **Responsive UI:** Ensure CSS and Leaflet configurations are strictly mobile-friendly, providing a seamless experience across desktop and mobile.
*   **Remove Binary Parsers:** Remove `pako` and `nexrad-level-2-data` from the browser.
*   **WebSocket Integration:** Implement a persistent WebSocket connection to receive parsed data.
*   **Incremental Rendering:** Instead of redrawing the entire volume scan every time, the Canvas will simply draw the *new* radials as they arrive over the socket, directly behind the simulated WSR-88D sweep line.

## 6. Scalability & Cost Considerations

*   **Network:** S3 GET requests inside the same AWS region (e.g., `us-east-1`) to an Open Data bucket are typically free, but egress to the internet costs money. Deploying the backend on AWS (EC2/ECS) minimizes data transfer costs.
*   **Compute:** Parsing Level 2 binary data is CPU intensive. Using Node.js `Worker Threads` or Python `multiprocessing` is mandatory to ensure one active radar station doesn't block the parsing of another.
*   **Statelessness:** The backend should ideally be stateless. If you scale to multiple backend servers behind a load balancer, use Redis Pub/Sub so that if Server A parses a `KLZK` chunk, it broadcasts it to Server B so Server B can update its connected clients.
