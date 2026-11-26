import { describe, expect, it } from 'vitest';
import {
  decodeFrpc,
  encodeFrpcCall,
  extractCoordsFromFrpc,
} from '../src/content/frpc-codec';

describe('frpc-codec', () => {
  it('encodes and decodes a FastRPC v2.1 method call with nested types', () => {
    const encoded = encodeFrpcCall('poi.detail', [
      {
        source: 'pubt',
        id: 15334169,
        negative: -42,
        lat: 50.5242081,
        lon: 14.0959206,
        active: true,
        empty: null,
        tags: ['bus', 'stop'],
      },
    ]);

    expect(encoded[0]).toBe(0xca);
    expect(encoded[1]).toBe(0x11);

    const decoded = decodeFrpc(encoded);
    expect(decoded.kind).toBe('call');
    expect(decoded.method).toBe('poi.detail');
    expect(decoded.params).toHaveLength(1);

    const arg = decoded.params![0] as Record<string, unknown>;
    expect(arg.source).toBe('pubt');
    expect(arg.id).toBe(15334169);
    expect(arg.negative).toBe(-42);
    expect(arg.lat).toBeCloseTo(50.5242081, 6);
    expect(arg.lon).toBeCloseTo(14.0959206, 6);
    expect(arg.active).toBe(true);
    expect(arg.empty).toBeNull();
    expect(arg.tags).toEqual(['bus', 'stop']);
  });

  it('extracts POI coordinates recursively from nested FastRPC structs', () => {
    const sample = {
      status: 200,
      result: {
        poi: {
          id: 15334169,
          title: 'Žalhostice, žel.zast.',
          mark: { lat: 50.5242081, lon: 14.0959206 },
        },
        nearby: [
          {
            pubtId: '15239313',
            name: 'Žalhostice, obec',
            y: 50.5251,
            x: 14.0942,
          },
        ],
      },
    };

    const coords = extractCoordsFromFrpc(sample);
    expect(coords).toHaveLength(2);
    expect(coords[0]).toEqual({
      id: '15334169',
      name: 'Žalhostice, žel.zast.',
      lat: 50.5242081,
      lon: 14.0959206,
    });
    expect(coords[1]).toEqual({
      id: '15239313',
      name: 'Žalhostice, obec',
      lat: 50.5251,
      lon: 14.0942,
    });
  });

  it('uses fallbackId when nested coordinate objects omit the POI id', () => {
    const sample = {
      status: 200,
      detail: {
        title: 'Litoměřice, aut.nádr.',
        coord: { lat: 50.5335, lon: 14.1319 },
      },
    };
    const coords = extractCoordsFromFrpc(sample, '15240025');
    expect(coords).toEqual([
      {
        id: '15240025',
        name: 'Litoměřice, aut.nádr.',
        lat: 50.5335,
        lon: 14.1319,
      },
    ]);
  });
});
