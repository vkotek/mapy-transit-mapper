import { ViewportState } from '../shared/types';

// Verified against Mapy.com's .control-scale bar: 256px Web Mercator tiles
export const TILE_SIZE = 256;
const MAX_LAT = 85.05112878;

export interface Point2D {
  x: number;
  y: number;
}

export function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function lonLatToWorldPx(lon: number, lat: number, zoom: number): Point2D {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * worldSize;
  const sinLat = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
  return { x, y };
}

export function projectToScene(
  lon: number,
  lat: number,
  viewport: Pick<ViewportState, 'lon' | 'lat' | 'zoom'>,
  sceneWidth: number,
  sceneHeight: number
): Point2D {
  const center = lonLatToWorldPx(viewport.lon, viewport.lat, viewport.zoom);
  const pt = lonLatToWorldPx(lon, lat, viewport.zoom);
  return {
    x: sceneWidth / 2 + (pt.x - center.x),
    y: sceneHeight / 2 + (pt.y - center.y),
  };
}

export function computeFitViewport(
  coords: Array<{ lat: number; lon: number }>,
  sceneWidth: number,
  sceneHeight: number,
  paddingPx = 72
): { lon: number; lat: number; zoom: number } | null {
  if (coords.length === 0 || sceneWidth <= 0 || sceneHeight <= 0) return null;

  if (coords.length === 1) {
    return { lon: coords[0].lon, lat: coords[0].lat, zoom: 16 };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const c of coords) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }

  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;

  const availW = Math.max(80, sceneWidth - paddingPx * 2);
  const availH = Math.max(80, sceneHeight - paddingPx * 2);

  // Measure span at zoom = 0
  const nw = lonLatToWorldPx(minLon, maxLat, 0);
  const se = lonLatToWorldPx(maxLon, minLat, 0);
  const spanX = Math.max(1e-7, Math.abs(se.x - nw.x));
  const spanY = Math.max(1e-7, Math.abs(se.y - nw.y));

  const zoomX = Math.log2(availW / spanX);
  const zoomY = Math.log2(availH / spanY);
  const zoom = Math.max(4, Math.min(18, Math.min(zoomX, zoomY)));

  return { lon: centerLon, lat: centerLat, zoom: Number(zoom.toFixed(3)) };
}

export function parseMapyUrl(urlStr: string): ViewportState {
  const url = new URL(urlStr, 'https://mapy.com');
  const p = url.searchParams;

  const lon = Number(p.get('x'));
  const lat = Number(p.get('y'));
  const zoom = Number(p.get('z'));
  const pitch = p.has('pitch') ? Number(p.get('pitch')) : p.has('p') ? Number(p.get('p')) : 0;
  const bearing = p.has('rot') ? Number(p.get('rot')) : p.has('bearing') ? Number(p.get('bearing')) : 0;

  let timeboardLineId: string | null = null;
  let timeboardDirection: number | null = null;
  const tbRaw = p.get('timeboard');
  if (tbRaw) {
    try {
      const tb = JSON.parse(tbRaw) as { l?: string; d?: number };
      if (tb.l) timeboardLineId = String(tb.l);
      if (typeof tb.d === 'number') timeboardDirection = tb.d;
    } catch {
      // Ignore malformed timeboard JSON
    }
  }

  return {
    lon: Number.isFinite(lon) ? lon : 14.4378,
    lat: Number.isFinite(lat) ? lat : 50.0755,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 14,
    pitch: Number.isFinite(pitch) ? pitch : 0,
    bearing: Number.isFinite(bearing) ? bearing : 0,
    source: p.get('source'),
    stopId: p.get('source') === 'pubt' ? p.get('id') : null,
    timeboardLineId,
    timeboardDirection,
    url: urlStr,
  };
}

export function buildStopNavigationUrl(currentUrl: string, stopId: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set('source', 'pubt');
  url.searchParams.set('id', stopId);
  url.searchParams.delete('timeboard');
  return url.toString();
}

export function buildFitViewportUrl(
  currentUrl: string,
  fit: { lon: number; lat: number; zoom: number }
): string {
  const url = new URL(currentUrl);
  url.searchParams.set('x', fit.lon.toFixed(7));
  url.searchParams.set('y', fit.lat.toFixed(7));
  url.searchParams.set('z', fit.zoom.toFixed(3));
  return url.toString();
}
