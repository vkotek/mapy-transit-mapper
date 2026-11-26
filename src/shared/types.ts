export const BRIDGE_CHANNEL = 'MAPY_TRANSIT_MAPPER_V1';

export type TransportMode = 'bus' | 'tram' | 'metro' | 'train' | 'ferry' | 'trolleybus' | 'other';

export interface ViewportState {
  lon: number;
  lat: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
  source: string | null;
  stopId: string | null;
  timeboardLineId: string | null;
  timeboardDirection: number | null;
  url: string;
}

export interface CachedStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  zone?: string;
  updatedAt: number;
}

export interface RouteStop {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
  zone?: string;
  minutesFromOrigin?: number;
  isOrigin?: boolean;
}

export interface TransitLine {
  key: string; // `${lineId}:${direction}:${signId}`
  lineId: string;
  label: string; // e.g. "628", "621"
  direction: number; // 1 or -1
  signId: string; // platform pubt ID
  isNearby: boolean; // true if signId !== selectedStopId
  mode: TransportMode;
  destination: string;
  nextDepartures: string[];
  stops: RouteStop[];
  color: string;
}

export interface ExtensionSettings {
  enabled: boolean;
  showNearby: boolean;
  curvedLines: boolean;
  travelTimeColors: boolean;
  maxMinutes: number; // 0 = unlimited
  showStopLabels: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  showNearby: true,
  curvedLines: true,
  travelTimeColors: false,
  maxMinutes: 0,
  showStopLabels: true,
};

export interface BridgeReadyMessage {
  channel: typeof BRIDGE_CHANNEL;
  type: 'BRIDGE_READY';
}

export interface BridgeUrlMessage {
  channel: typeof BRIDGE_CHANNEL;
  type: 'URL_CHANGE';
  url: string;
}

export interface BridgeNetworkMessage {
  channel: typeof BRIDGE_CHANNEL;
  type: 'NETWORK_CAPTURE';
  endpoint: 'jrpoifrpc' | 'poiagg';
  url: string;
  requestBase64: string | null;
  responseBase64: string;
  contentType: string;
}

export type BridgeMessage = BridgeReadyMessage | BridgeUrlMessage | BridgeNetworkMessage;
