# Mapy.com Transit Connections Mapper

A Chromium Manifest V3 extension for **Google Chrome** and **Microsoft Edge** that maps public transport connections, downstream stops, and travel-time rings for the currently selected transit stop (`source=pubt&id=...`) directly onto Mapy.com’s map view.

## Features
- **Live Map Overlay:** Renders color-coded transit lines, directional chevrons, and stop nodes on a HiDPI `<canvas>` synchronized with Mapy.com’s WebGL `#scene`.
- **Passive FastRPC Tap + Caching:** Reuses `/api/jrpoifrpc/` and `/api/poiagg` payloads already fetched by Mapy.com, decodes Seznam FastRPC locally, and caches stop coordinates in IndexedDB (30-day TTL).
- **Interactive Shadow DOM HUD:**
  - **Fit all connections** button to frame all reachable stops on screen.
  - Line filter chips and bidirectional hover highlighting with Mapy.com’s sidebar & timeboard.
  - **Travel-time coloring** (isochrone mode) with a max-minutes filter slider.
  - Click any mapped stop node to jump directly to that stop on Mapy.com.

## Build & Load Unpacked (Chrome / Edge)
```bash
npm install
npm run build
```

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the generated `dist/` folder.
4. Open any transit stop on [mapy.com](https://mapy.com) (for example, a bus or tram stop with `source=pubt&id=...`).

## Development Commands
- `npm run typecheck` — TypeScript type check
- `npm test` — Run unit tests (FastRPC codec & Web Mercator projection)
- `npm run build` — Generate icons and bundle into `dist/`
