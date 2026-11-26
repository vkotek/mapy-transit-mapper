import {
  BridgeNetworkMessage,
  CachedStop,
  RouteStop,
  TransitLine,
  TransportMode,
} from '../shared/types';
import {
  FrpcValue,
  base64ToBytes,
  decodeFrpc,
  encodeFrpcCall,
  extractCoordsFromFrpc,
} from './frpc-codec';
import { stopCache } from './stop-cache';

const LINE_PALETTE = [
  '#0284c7', // sky-600
  '#059669', // emerald-600
  '#d97706', // amber-600
  '#db2777', // pink-600
  '#7c3aed', // violet-600
  '#dc2626', // red-600
  '#0d9488', // teal-600
  '#2563eb', // blue-600
  '#ea580c', // orange-600
  '#4f46e5', // indigo-600
];

export interface TransitStateSnapshot {
  originStopId: string | null;
  originStopName: string;
  originCoord: { lat: number; lon: number } | null;
  lines: TransitLine[];
  pendingStopCount: number;
  resolvedStopCount: number;
  totalUniqueStops: number;
}

export class TransitDataManager {
  private originStopId: string | null = null;
  private originStopName = '';
  private linesByKey = new Map<string, TransitLine>();
  private coordsById = new Map<string, CachedStop>();
  private inFlightStopIds = new Set<string>();
  private fetchedSheetKeys = new Set<string>();
  private inFlightSheetKeys = new Set<string>();
  private pendingStopQueue: string[] = [];
  private activeStopFetches = 0;
  private readonly maxConcurrency = 6;
  private onChange: (snapshot: TransitStateSnapshot) => void;

  constructor(onChange: (snapshot: TransitStateSnapshot) => void) {
    this.onChange = onChange;
  }

  public setOriginStop(stopId: string | null): void {
    if (this.originStopId === stopId) return;
    this.originStopId = stopId;
    this.originStopName = '';
    this.linesByKey.clear();
    this.pendingStopQueue = [];
    this.fetchedSheetKeys.clear();
    this.inFlightSheetKeys.clear();
    if (stopId) {
      void this.hydrateOriginAndLines(stopId);
    }
    this.emit();
  }

  private async hydrateOriginAndLines(stopId: string): Promise<void> {
    const cached = await stopCache.getMany([stopId]);
    const hit = cached.get(stopId);
    if (hit) {
      this.coordsById.set(stopId, hit);
      if (!this.originStopName && hit.name) this.originStopName = hit.name;
      this.emit();
    }

    // Proactively fetch /api/poiagg detail for this stop so we get all lines &
    // signs immediately even if the extension was reloaded on an open tab
    await this.fetchPoiDetail(stopId, true);
  }

  public async handleNetworkCapture(msg: BridgeNetworkMessage): Promise<void> {
    try {
      const respBytes = base64ToBytes(msg.responseBase64);
      const decoded = decodeFrpc(respBytes);
      const payload = decoded.value ?? decoded.params;
      if (!payload) return;

      let reqMethod: string | undefined;
      let reqParams: FrpcValue[] | undefined;
      if (msg.requestBase64) {
        try {
          const reqDecoded = decodeFrpc(base64ToBytes(msg.requestBase64));
          reqMethod = reqDecoded.method;
          reqParams = reqDecoded.params;
        } catch {
          // Ignore
        }
      }

      if (msg.endpoint === 'poiagg') {
        const requestedId =
          reqMethod === 'detail' && reqParams && reqParams.length >= 2
            ? String(reqParams[1])
            : undefined;
        await this.processPoiaggPayload(payload, requestedId);
      } else if (msg.endpoint === 'jrpoifrpc') {
        const signId = reqParams && reqParams.length >= 1 ? String(reqParams[0]) : this.originStopId || '';
        const lineId = reqParams && reqParams.length >= 2 ? String(reqParams[1]) : '';
        const dir = reqParams && reqParams.length >= 3 ? Number(reqParams[2]) : 1;
        this.processSheetPayload(payload, signId, lineId, dir);
      }
    } catch {
      // Malformed or non-FRPC payload — DOM fallback still works
    }
  }

  private async processPoiaggPayload(payload: FrpcValue, requestedId?: string): Promise<void> {
    // 1. Extract all POI / sign coordinates
    const extracted = extractCoordsFromFrpc(payload, requestedId);
    if (extracted.length > 0) {
      await this.commitExtractedCoords(extracted);
    }

    // 2. If this detail response is for the active origin stop, extract ALL transportlines
    if (
      this.originStopId &&
      (!requestedId || requestedId === this.originStopId) &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    ) {
      const root = payload as Record<string, FrpcValue>;
      const poi = root.poi as Record<string, FrpcValue> | undefined;
      const extend = poi?.extend as Record<string, FrpcValue> | undefined;
      const transportlines = extend?.transportlines;

      if (Array.isArray(transportlines)) {
        let addedAny = false;
        for (const group of transportlines) {
          if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
          const g = group as Record<string, FrpcValue>;
          const mode = this.modeFromLabel(String(g.label || ''));
          const lines = g.lines;
          if (!Array.isArray(lines)) continue;

          for (const rawLine of lines) {
            if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) continue;
            const l = rawLine as Record<string, FrpcValue>;
            const lineId = String(l.id || '');
            const label = String(l.title || lineId);
            const departures = l.departures;
            if (!lineId || !Array.isArray(departures)) continue;

            for (const rawDep of departures) {
              if (!rawDep || typeof rawDep !== 'object' || Array.isArray(rawDep)) continue;
              const d = rawDep as Record<string, FrpcValue>;
              const direction = Number(d.direction ?? 1);
              const signIds = Array.isArray(d.signId)
                ? d.signId.map((s) => String(s))
                : d.signId !== undefined
                  ? [String(d.signId)]
                  : [this.originStopId];
              const signId = signIds[0] || this.originStopId;
              const terminus = String(d.terminus || '');
              const timesArr = Array.isArray(d.times)
                ? d.times
                    .map((t) => {
                      if (!t || typeof t !== 'object' || Array.isArray(t)) return '';
                      const iso = String((t as Record<string, FrpcValue>).time || '');
                      const m = iso.match(/T(\d{2}:\d{2})/);
                      return m ? m[1] : iso;
                    })
                    .filter(Boolean)
                : [];

              const key = `${lineId}:${direction}:${signId}`;
              const existing = this.linesByKey.get(key);
              if (!existing) {
                this.linesByKey.set(key, {
                  key,
                  lineId,
                  label,
                  direction: Number.isFinite(direction) ? direction : 1,
                  signId,
                  isNearby: signId !== this.originStopId,
                  mode,
                  destination: terminus,
                  nextDepartures: timesArr,
                  stops: [
                    {
                      id: signId,
                      name: this.originStopName || `Stop ${signId}`,
                      isOrigin: true,
                      minutesFromOrigin: 0,
                    },
                  ],
                  color: this.pickColor(`${lineId}:${direction}`),
                });
                addedAny = true;
              } else {
                if (label) existing.label = label;
                if (terminus) existing.destination = terminus;
                if (timesArr.length > 0) existing.nextDepartures = timesArr;
              }
            }
          }
        }

        if (addedAny) {
          this.applyCoordinatesToLines();
          this.emit();
        }
        // Automatically fetch full stopList for every line serving this stop!
        void this.fetchAllLineSheets();
      }
    }
  }

  private processSheetPayload(
    payload: FrpcValue,
    signId: string,
    lineId: string,
    direction: number
  ): void {
    if (!this.originStopId || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    const root = payload as Record<string, FrpcValue>;
    const sheet = root.sheet as Record<string, FrpcValue> | undefined;
    const intervals = sheet?.intervals;
    if (!Array.isArray(intervals) || intervals.length === 0) return;

    const firstInterval = intervals[0] as Record<string, FrpcValue> | undefined;
    const stopList = firstInterval?.stopList;
    if (!Array.isArray(stopList) || stopList.length < 2) return;

    const sheetDir =
      typeof sheet?.direction === 'number' ? sheet.direction : direction;
    const effectiveSignId = signId || this.originStopId;

    // Parse ordered stops + cumulative minutes if present
    const parsedStops: RouteStop[] = [];
    for (const raw of stopList) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const s = raw as Record<string, FrpcValue>;
      const sid = String(s.id ?? '');
      if (!sid) continue;
      const title = String(s.title || s.name || `Stop ${sid}`);
      const exc = Array.isArray(s.stopExc) ? s.stopExc.map(String) : [];
      const zone = exc.find((e) => /^u?\d+$/i.test(e)) || exc[0];
      const minsRaw = s.time ?? s.minutes ?? s.delta ?? s.travelTime;
      const mins =
        typeof minsRaw === 'number' && Number.isFinite(minsRaw) ? minsRaw : undefined;

      parsedStops.push({
        id: sid,
        name: title,
        zone,
        minutesFromOrigin: sid === effectiveSignId ? 0 : mins,
        isOrigin: sid === effectiveSignId || sid === this.originStopId,
      });
    }

    if (parsedStops.length < 2) return;

    // Match existing line entry by (lineId, direction, signId) or (lineId, direction)
    let key = `${lineId}:${sheetDir}:${effectiveSignId}`;
    let existing = this.linesByKey.get(key);
    if (!existing && lineId) {
      for (const candidate of this.linesByKey.values()) {
        if (candidate.lineId === lineId && candidate.direction === sheetDir) {
          existing = candidate;
          key = candidate.key;
          break;
        }
      }
    }

    if (existing) {
      existing.stops = parsedStops;
      if (!existing.destination) {
        existing.destination = parsedStops[parsedStops.length - 1].name;
      }
    } else if (lineId) {
      this.linesByKey.set(key, {
        key,
        lineId,
        label: lineId.slice(-3),
        direction: sheetDir,
        signId: effectiveSignId,
        isNearby: effectiveSignId !== this.originStopId,
        mode: 'bus',
        destination: parsedStops[parsedStops.length - 1].name,
        nextDepartures: [],
        stops: parsedStops,
        color: this.pickColor(`${lineId}:${sheetDir}`),
      });
    }

    this.fetchedSheetKeys.add(key);
    this.applyCoordinatesToLines();
    void this.resolveMissingStops();
    this.emit();
  }

  private async fetchAllLineSheets(): Promise<void> {
    const lines = Array.from(this.linesByKey.values());
    await Promise.all(
      lines.map(async (line) => {
        if (
          line.stops.length >= 2 ||
          this.fetchedSheetKeys.has(line.key) ||
          this.inFlightSheetKeys.has(line.key)
        ) {
          return;
        }
        this.inFlightSheetKeys.add(line.key);
        try {
          const signNum = Number(line.signId);
          const body = encodeFrpcCall('sheetIntervals', [
            Number.isFinite(signNum) ? signNum : line.signId,
            String(line.lineId),
            Number(line.direction),
            { lang: ['en'] },
          ]);

          const resp = await fetch(`${window.location.origin}/api/jrpoifrpc/`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-frpc',
              Accept: 'application/x-frpc',
            },
            body: body.slice(),
            credentials: 'same-origin',
          });
          if (!resp.ok) return;

          const buf = await resp.arrayBuffer();
          const decoded = decodeFrpc(buf);
          const payload = decoded.value ?? decoded.params;
          if (payload) {
            this.processSheetPayload(payload, line.signId, line.lineId, line.direction);
          }
        } catch {
          // Non-fatal
        } finally {
          this.inFlightSheetKeys.delete(line.key);
        }
      })
    );
  }

  /**
   * Scrapes live transit connections, stop lists, and origin GPS from Mapy.com's DOM.
   * Mirrors Mapy.com's exact markup for `.content-transportlines` and `#timeboard`.
   */
  public syncFromDom(): void {
    if (!this.originStopId) return;

    let changed = false;

    // 1. Origin stop name & GPS from sidebar
    const titleEl =
      document.querySelector('#timeboard .header h4') ||
      document.querySelector('#layout-content .content-title h1');
    if (titleEl?.textContent) {
      const name = titleEl.textContent.trim();
      if (name && name !== this.originStopName) {
        this.originStopName = name;
        changed = true;
      }
    }

    const gpsInput = document.querySelector<HTMLInputElement>(
      '#layout-content div.gps input[readonly]'
    );
    if (gpsInput?.value) {
      const parsed = this.parseGpsString(gpsInput.value);
      if (parsed && !this.coordsById.has(this.originStopId)) {
        const rec: CachedStop = {
          id: this.originStopId,
          name: this.originStopName || `Stop ${this.originStopId}`,
          lat: parsed.lat,
          lon: parsed.lon,
          updatedAt: Date.now(),
        };
        this.coordsById.set(this.originStopId, rec);
        void stopCache.putMany([rec]);
        changed = true;
      }
    }

    // 2. Scrape connections table from Stop Detail Sidebar (.content-transportlines)
    const activeMode = this.detectActiveMode();
    const lineCells = document.querySelectorAll<HTMLElement>(
      '.card-content.content-transportlines td.linetd[data-line-id]'
    );
    for (const cell of lineCells) {
      const lineId = cell.dataset.lineId || '';
      const dir = Number(cell.dataset.lineDirection ?? '1');
      const signId = cell.dataset.signid || this.originStopId;
      if (!lineId) continue;

      const row = cell.closest('tr');
      // Exact Mapy.com markup: <td class="link"><span class="number">628</span></td>
      const label =
        row?.querySelector('td.link .number')?.textContent?.trim() ||
        row?.querySelector('.number')?.textContent?.trim() ||
        lineId;

      // Exact Mapy.com markup: <a class="direction"><div>Litoměřice, aut.nádr. <span>5:09, 6:04</span></div></a>
      const dirDiv = cell.querySelector('a.direction div');
      const timesSpan = dirDiv?.querySelector('span');
      const nextDepartures = (timesSpan?.textContent || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let destination = '';
      if (dirDiv) {
        destination = Array.from(dirDiv.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent || '')
          .join('')
          .trim();
      }

      const key = `${lineId}:${dir}:${signId}`;
      const existing = this.linesByKey.get(key);
      if (!existing) {
        this.linesByKey.set(key, {
          key,
          lineId,
          label,
          direction: Number.isFinite(dir) ? dir : 1,
          signId,
          isNearby: signId !== this.originStopId,
          mode: activeMode,
          destination,
          nextDepartures,
          stops: [
            {
              id: signId,
              name: this.originStopName || `Stop ${signId}`,
              isOrigin: true,
              minutesFromOrigin: 0,
            },
          ],
          color: this.pickColor(`${lineId}:${dir}`),
        });
        changed = true;
      } else {
        if (label && existing.label !== label) {
          existing.label = label;
          changed = true;
        }
        if (destination && !existing.destination) {
          existing.destination = destination;
          existing.nextDepartures = nextDepartures;
          changed = true;
        }
      }
    }

    // 3. Scrape ordered stop list from #timeboard table.line (gives exact travel minutes too!)
    const timeboardEl = document.getElementById('timeboard');
    if (timeboardEl) {
      const urlParams = new URLSearchParams(window.location.search);
      const activeLineLi = timeboardEl.querySelector<HTMLElement>(
        'ul.lines li.number.active, ul.lines li.number[aria-current="true"], ul.lines li.number.selected'
      );
      let tbLineId = activeLineLi?.dataset.lineId || '';
      let tbDir = Number(activeLineLi?.dataset.lineDirection ?? '1');
      let tbLabel = activeLineLi?.dataset.logLine || activeLineLi?.textContent?.trim() || '';

      const tbRaw = urlParams.get('timeboard');
      if (tbRaw) {
        try {
          const tb = JSON.parse(tbRaw) as { l?: string; d?: number };
          if (tb.l) tbLineId = String(tb.l);
          if (typeof tb.d === 'number') tbDir = tb.d;
        } catch {
          // Ignore
        }
      }

      if (!tbLabel && tbLineId) {
        const matchLi = timeboardEl.querySelector<HTMLElement>(
          `ul.lines li.number[data-line-id="${CSS.escape(tbLineId)}"]`
        );
        tbLabel = matchLi?.dataset.logLine || matchLi?.textContent?.trim() || tbLineId;
      }

      const stopRows = timeboardEl.querySelectorAll<HTMLTableRowElement>('table.line tr');
      if (tbLineId && stopRows.length > 0) {
        const parsedStops: RouteStop[] = [];
        for (const tr of stopRows) {
          const tds = tr.querySelectorAll('td');
          const minText = tds[0]?.textContent?.trim() || '';
          const minutes = /^\d{1,3}$/.test(minText) ? Number(minText) : undefined;
          const link = tr.querySelector<HTMLAnchorElement>('a[data-pubt-id], a[href*="source=pubt"]');
          const zone = tr.querySelector('em.note')?.textContent?.trim();

          let stopId = link?.dataset.pubtId || '';
          if (!stopId && link?.href) {
            try {
              stopId = new URL(link.href, window.location.origin).searchParams.get('id') || '';
            } catch {
              // Ignore
            }
          }

          if (stopId) {
            parsedStops.push({
              id: stopId,
              name: link?.textContent?.trim() || `Stop ${stopId}`,
              zone,
              minutesFromOrigin: minutes,
              isOrigin: stopId === this.originStopId,
            });
          } else if (tr.classList.contains('actual') && this.originStopId) {
            const cell = tds[1];
            const nameText = cell
              ? Array.from(cell.childNodes)
                  .filter((n) => n.nodeType === Node.TEXT_NODE)
                  .map((n) => n.textContent || '')
                  .join('')
                  .trim()
              : this.originStopName;
            parsedStops.push({
              id: this.originStopId,
              name: nameText || this.originStopName || `Stop ${this.originStopId}`,
              zone,
              minutesFromOrigin: 0,
              isOrigin: true,
            });
          }
        }

        if (parsedStops.length >= 2) {
          const destHeading =
            timeboardEl.querySelector('.sheet-container h3')?.textContent?.trim() || '';
          const destName = destHeading.includes('→')
            ? destHeading.split('→').pop()?.trim() || destHeading
            : parsedStops[parsedStops.length - 1].name;

          // Match existing line key or create new
          let key = `${tbLineId}:${tbDir}:${this.originStopId}`;
          let existing = this.linesByKey.get(key);
          if (!existing) {
            for (const cand of this.linesByKey.values()) {
              if (cand.lineId === tbLineId && cand.direction === tbDir) {
                existing = cand;
                key = cand.key;
                break;
              }
            }
          }

          const prevSig = existing?.stops.map((s) => `${s.id}:${s.minutesFromOrigin ?? ''}`).join(',') ?? '';
          const nextSig = parsedStops.map((s) => `${s.id}:${s.minutesFromOrigin ?? ''}`).join(',');
          if (!existing || prevSig !== nextSig) {
            this.linesByKey.set(key, {
              key,
              lineId: tbLineId,
              label: tbLabel || existing?.label || tbLineId,
              direction: tbDir,
              signId: existing?.signId || this.originStopId,
              isNearby: existing?.isNearby ?? false,
              mode: this.detectTimeboardMode(timeboardEl),
              destination: destName || existing?.destination || '',
              nextDepartures: existing?.nextDepartures || [],
              stops: parsedStops,
              color: existing?.color || this.pickColor(`${tbLineId}:${tbDir}`),
            });
            changed = true;
          }
        }
      }
    }

    if (changed) {
      this.applyCoordinatesToLines();
      void this.fetchAllLineSheets();
      void this.resolveMissingStops();
      this.emit();
    }
  }

  private applyCoordinatesToLines(): void {
    for (const line of this.linesByKey.values()) {
      for (const stop of line.stops) {
        const cached = this.coordsById.get(stop.id);
        if (cached) {
          stop.lat = cached.lat;
          stop.lon = cached.lon;
          if (!stop.name || stop.name.startsWith('Stop ')) {
            stop.name = cached.name;
          }
        }
      }
    }
  }

  private async resolveMissingStops(): Promise<void> {
    const missing = new Set<string>();
    for (const line of this.linesByKey.values()) {
      for (const stop of line.stops) {
        if (
          (stop.lat === undefined || stop.lon === undefined) &&
          !this.coordsById.has(stop.id) &&
          !this.inFlightStopIds.has(stop.id)
        ) {
          missing.add(stop.id);
        }
      }
    }
    if (missing.size === 0) return;

    const ids = Array.from(missing);
    const fromDb = await stopCache.getMany(ids);
    const stillMissing: string[] = [];

    for (const id of ids) {
      const hit = fromDb.get(id);
      if (hit) {
        this.coordsById.set(id, hit);
      } else if (!this.pendingStopQueue.includes(id)) {
        stillMissing.push(id);
      }
    }

    if (fromDb.size > 0) {
      this.applyCoordinatesToLines();
      this.emit();
    }

    if (stillMissing.length > 0) {
      this.pendingStopQueue.push(...stillMissing);
      this.pumpFetchQueue();
    }
  }

  private pumpFetchQueue(): void {
    while (this.activeStopFetches < this.maxConcurrency && this.pendingStopQueue.length > 0) {
      const nextId = this.pendingStopQueue.shift()!;
      if (this.coordsById.has(nextId) || this.inFlightStopIds.has(nextId)) continue;
      this.inFlightStopIds.add(nextId);
      this.activeStopFetches++;
      void this.fetchPoiDetail(nextId, false).finally(() => {
        this.inFlightStopIds.delete(nextId);
        this.activeStopFetches--;
        this.pumpFetchQueue();
      });
    }
  }

  private async fetchPoiDetail(stopId: string, parseLines: boolean): Promise<void> {
    try {
      const idNum = Number(stopId);
      const body = encodeFrpcCall('detail', [
        'pubt',
        Number.isFinite(idNum) ? idNum : stopId,
        { fetchPhoto: false, lang: ['en'] },
      ]);

      const resp = await fetch(`${window.location.origin}/api/poiagg`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-frpc',
          Accept: 'application/x-frpc',
        },
        body: body.slice(),
        credentials: 'same-origin',
      });
      if (!resp.ok) return;

      const buf = await resp.arrayBuffer();
      const decoded = decodeFrpc(buf);
      const payload = decoded.value ?? decoded.params;
      if (!payload) return;

      if (parseLines) {
        await this.processPoiaggPayload(payload, stopId);
      } else {
        const extracted = extractCoordsFromFrpc(payload, stopId);
        if (extracted.length > 0) {
          await this.commitExtractedCoords(extracted);
        }
      }
    } catch {
      // Non-fatal
    }
  }

  private async commitExtractedCoords(
    extracted: Array<{ id: string; name?: string; lat: number; lon: number }>
  ): Promise<void> {
    const now = Date.now();
    const toCache: CachedStop[] = extracted.map((item) => ({
      id: item.id,
      name: item.name || this.coordsById.get(item.id)?.name || `Stop ${item.id}`,
      lat: item.lat,
      lon: item.lon,
      updatedAt: now,
    }));
    for (const rec of toCache) {
      this.coordsById.set(rec.id, rec);
    }
    await stopCache.putMany(toCache);
    this.applyCoordinatesToLines();
    this.emit();
  }

  private parseGpsString(raw: string): { lat: number; lon: number } | null {
    const m = raw.match(/([\d.]+)\s*([NS])\s*,\s*([\d.]+)\s*([EW])/i);
    if (!m) return null;
    const lat = Number(m[1]) * (m[2].toUpperCase() === 'S' ? -1 : 1);
    const lon = Number(m[3]) * (m[4].toUpperCase() === 'W' ? -1 : 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  private modeFromLabel(label: string): TransportMode {
    const lower = label.toLowerCase();
    if (lower.includes('tram')) return 'tram';
    if (lower.includes('metro') || lower.includes('subway')) return 'metro';
    if (lower.includes('train') || lower.includes('vlak')) return 'train';
    if (lower.includes('trolley') || lower.includes('trolej')) return 'trolleybus';
    if (lower.includes('ferry') || lower.includes('přívoz') || lower.includes('boat')) return 'ferry';
    return 'bus';
  }

  private detectActiveMode(): TransportMode {
    const active = document.querySelector('.card-content.content-transportlines .thin-tabs .active');
    return this.modeFromLabel(active?.className || '');
  }

  private detectTimeboardMode(tb: HTMLElement): TransportMode {
    const active = tb.querySelector<HTMLElement>('ul.tabs .active, ul.tabs li[data-log-type]');
    return this.modeFromLabel(active?.dataset.logType || '');
  }

  private pickColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return LINE_PALETTE[hash % LINE_PALETTE.length];
  }

  public getSnapshot(): TransitStateSnapshot {
    const uniqueStops = new Set<string>();
    let resolved = 0;
    for (const line of this.linesByKey.values()) {
      for (const s of line.stops) {
        if (!uniqueStops.has(s.id)) {
          uniqueStops.add(s.id);
          if (s.lat !== undefined && s.lon !== undefined) resolved++;
        }
      }
    }

    const originRec = this.originStopId ? this.coordsById.get(this.originStopId) : undefined;
    return {
      originStopId: this.originStopId,
      originStopName: this.originStopName || originRec?.name || '',
      originCoord: originRec ? { lat: originRec.lat, lon: originRec.lon } : null,
      lines: Array.from(this.linesByKey.values()),
      pendingStopCount: this.pendingStopQueue.length + this.inFlightStopIds.size,
      resolvedStopCount: resolved,
      totalUniqueStops: uniqueStops.size,
    };
  }

  private emit(): void {
    this.onChange(this.getSnapshot());
  }
}
