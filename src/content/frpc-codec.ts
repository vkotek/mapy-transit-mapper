/**
 * Wrapper around Seznam's official `fastrpc` library for exact wire-format
 * compatibility with Mapy.com's /api/jrpoifrpc/ and /api/poiagg endpoints,
 * plus recursive POI/coordinate extractors.
 */
import * as fastrpcNs from 'fastrpc';

const frpc = ((fastrpcNs as unknown as { default?: typeof fastrpcNs }).default ??
  fastrpcNs) as typeof fastrpcNs;

export type FrpcValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | ArrayBuffer
  | Date
  | FrpcValue[]
  | { [key: string]: FrpcValue };

export interface FrpcDecodedMessage {
  kind: 'call' | 'response' | 'value';
  method?: string;
  params?: FrpcValue[];
  value?: FrpcValue;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function decodeFrpc(input: Uint8Array | ArrayBuffer): FrpcDecodedMessage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const parsed = frpc.parse(Array.from(bytes), { arrayBuffers: true }) as unknown;

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'method' in parsed &&
    'params' in parsed &&
    typeof (parsed as { method: unknown }).method === 'string' &&
    Array.isArray((parsed as { params: unknown }).params)
  ) {
    const call = parsed as { method: string; params: FrpcValue[] };
    return {
      kind: 'call',
      method: call.method,
      params: call.params,
    };
  }

  return {
    kind: 'response',
    value: parsed as FrpcValue,
  };
}

function prepareSerializable(val: FrpcValue): fastrpcNs.SerializableData {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean' || typeof val === 'string') return val;
  if (typeof val === 'number') {
    if (!Number.isInteger(val)) {
      return new frpc.Double(val);
    }
    return val;
  }
  if (val instanceof Date) return val;
  if (val instanceof ArrayBuffer) return val;
  if (val instanceof Uint8Array) {
    return val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(val)) {
    return val.map((item) => prepareSerializable(item));
  }
  if (typeof val === 'object') {
    const out: Record<string, fastrpcNs.SerializableData> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = prepareSerializable(v);
    }
    return out;
  }
  return null;
}

export function encodeFrpcCall(method: string, params: FrpcValue[]): Uint8Array {
  const prepared = params.map((p) => prepareSerializable(p));
  const serialized = frpc.serializeCall(method, prepared);
  return new Uint8Array(serialized);
}

export interface ExtractedPoiCoord {
  id: string;
  name?: string;
  lat: number;
  lon: number;
}

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) > 0.1 &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

/**
 * Defensive recursive extractor for Mapy.com POI / stop coordinates from any
 * decoded FastRPC response (poiagg or jrpoifrpc).
 */
export function extractCoordsFromFrpc(
  value: FrpcValue,
  fallbackId?: string
): ExtractedPoiCoord[] {
  const results: ExtractedPoiCoord[] = [];
  const seen = new Set<string>();

  function visit(node: FrpcValue, inheritedId?: string, inheritedName?: string): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inheritedId, inheritedName);
      return;
    }

    const obj = node as Record<string, FrpcValue>;
    const rawId = obj.id ?? obj.poiId ?? obj.pubtId ?? obj.signId ?? obj.stopId;
    const currentId =
      rawId !== undefined && rawId !== null && String(rawId).trim() !== ''
        ? String(rawId)
        : inheritedId;

    const currentName =
      typeof obj.title === 'string' && obj.title.trim()
        ? obj.title.trim()
        : typeof obj.name === 'string' && obj.name.trim()
          ? obj.name.trim()
          : inheritedName;

    const directLat = Number(obj.lat ?? obj.latitude ?? obj.y);
    const directLon = Number(obj.lon ?? obj.lng ?? obj.longitude ?? obj.x);

    if (currentId && isValidLatLon(directLat, directLon)) {
      if (!seen.has(currentId)) {
        seen.add(currentId);
        results.push({
          id: currentId,
          name: currentName,
          lat: directLat,
          lon: directLon,
        });
      }
    }

    for (const key of ['mark', 'coord', 'coords', 'point', 'position', 'location', 'center']) {
      const sub = obj[key];
      if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
        const s = sub as Record<string, FrpcValue>;
        const sLat = Number(s.lat ?? s.latitude ?? s.y);
        const sLon = Number(s.lon ?? s.lng ?? s.longitude ?? s.x);
        if (currentId && isValidLatLon(sLat, sLon) && !seen.has(currentId)) {
          seen.add(currentId);
          results.push({
            id: currentId,
            name: currentName,
            lat: sLat,
            lon: sLon,
          });
        }
      }
    }

    for (const v of Object.values(obj)) {
      visit(v, currentId, currentName);
    }
  }

  visit(value, fallbackId, undefined);
  return results;
}
