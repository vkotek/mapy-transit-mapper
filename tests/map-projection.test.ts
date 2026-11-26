import { describe, expect, it } from 'vitest';
import {
  TILE_SIZE,
  computeFitViewport,
  parseMapyUrl,
  projectToScene,
} from '../src/content/map-projection';

describe('map-projection', () => {
  it('parses the reference Mapy.com transit URL accurately', () => {
    const url =
      'https://mapy.com/en/turisticka?source=pubt&id=15334169&timeboard=%7B%22l%22%3A%22552628%22%2C%22d%22%3A-1%2C%22v%22%3A%7B%22from%22%3A%222026-11-26T01%3A00%3A00%2B01%3A00%22%2C%22to%22%3A%222026-12-11T01%3A00%3A00%2B01%3A00%22%7D%7D&x=14.0912965&y=50.5241815&z=18.358';
    const state = parseMapyUrl(url);
    expect(state.source).toBe('pubt');
    expect(state.stopId).toBe('15334169');
    expect(state.timeboardLineId).toBe('552628');
    expect(state.timeboardDirection).toBe(-1);
    expect(state.lon).toBeCloseTo(14.0912965, 6);
    expect(state.lat).toBeCloseTo(50.5241815, 6);
    expect(state.zoom).toBeCloseTo(18.358, 3);
  });

  it('projects viewport center to exact #scene midpoint', () => {
    const vp = { lon: 14.0912965, lat: 50.5241815, zoom: 18.358 };
    const pt = projectToScene(vp.lon, vp.lat, vp, 925, 1274);
    expect(pt.x).toBeCloseTo(462.5, 4);
    expect(pt.y).toBeCloseTo(637, 4);
  });

  it('matches Mapy.com 256px Web Mercator scale bar (~84.6px per 25m at z=18.358)', () => {
    expect(TILE_SIZE).toBe(256);
    const lat = 50.5241815;
    const zoom = 18.358;
    const metersPerPx =
      (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * Math.pow(2, zoom));
    const pxFor25m = 25 / metersPerPx;
    expect(pxFor25m).toBeGreaterThan(83);
    expect(pxFor25m).toBeLessThan(86);
  });

  it('computes a bounding-box viewport that fits all stops inside #scene', () => {
    const stops = [
      { lat: 50.5242, lon: 14.0959 },
      { lat: 50.5335, lon: 14.1319 }, // Litoměřice
      { lat: 50.5175, lon: 14.0630 }, // Velké Žernoseky
    ];
    const fit = computeFitViewport(stops, 925, 800, 80);
    expect(fit).not.toBeNull();
    expect(fit!.zoom).toBeGreaterThan(10);
    expect(fit!.zoom).toBeLessThan(16);

    for (const s of stops) {
      const pt = projectToScene(s.lon, s.lat, fit!, 925, 800);
      expect(pt.x).toBeGreaterThanOrEqual(75);
      expect(pt.x).toBeLessThanOrEqual(925 - 75);
      expect(pt.y).toBeGreaterThanOrEqual(75);
      expect(pt.y).toBeLessThanOrEqual(800 - 75);
    }
  });
});
