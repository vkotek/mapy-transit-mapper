import {
  BRIDGE_CHANNEL,
  BridgeMessage,
  DEFAULT_SETTINGS,
  ExtensionSettings,
  ViewportState,
} from '../shared/types';
import { HitResult, TransitCanvasRenderer } from './canvas-renderer';
import { TransitHudUi } from './hud-ui';
import {
  buildFitViewportUrl,
  buildStopNavigationUrl,
  computeFitViewport,
  parseMapyUrl,
} from './map-projection';
import { stopCache } from './stop-cache';
import { TransitDataManager, TransitStateSnapshot } from './transit-data';

class MapyTransitOverlayApp {
  private settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  private viewport: ViewportState = parseMapyUrl(window.location.href);
  private renderer = new TransitCanvasRenderer();
  private hud: TransitHudUi;
  private transitData: TransitDataManager;
  private snapshot: TransitStateSnapshot;

  private hiddenLineKeys = new Set<string>();
  private highlightedLineKey: string | null = null;
  private hoveredHit: HitResult | null = null;

  private sceneEl: HTMLElement | null = null;
  private domObserver: MutationObserver | null = null;
  private rafScheduled = false;
  private domSyncScheduled = false;

  // Pointer drag tracking on #scene
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private movedDuringPointer = false;

  constructor() {
    this.transitData = new TransitDataManager((snap) => {
      this.snapshot = snap;
      this.scheduleRender();
      this.syncBadge();
    });
    this.snapshot = this.transitData.getSnapshot();

    this.hud = new TransitHudUi({
      onFitView: () => this.fitAllConnections(),
      onToggleLine: (key) => {
        if (this.hiddenLineKeys.has(key)) this.hiddenLineKeys.delete(key);
        else this.hiddenLineKeys.add(key);
        this.scheduleRender();
      },
      onHoverLine: (key) => {
        this.highlightedLineKey = key;
        this.scheduleRender();
      },
      onPatchSettings: (patch) => {
        void this.updateSettings(patch);
      },
    });
  }

  public async init(): Promise<void> {
    await this.loadSettings();
    this.bindBridgeMessages();
    this.bindStorageSync();
    this.mountWhenReady();
    this.handleUrlChange(window.location.href);
    // Notify MAIN world bridge to flush any early /api/poiagg & /api/jrpoifrpc captures
    window.postMessage(
      { channel: BRIDGE_CHANNEL, type: 'BRIDGE_READY' },
      window.location.origin
    );
  }

  private async loadSettings(): Promise<void> {
    try {
      const resp = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as {
        ok?: boolean;
        settings?: ExtensionSettings;
      };
      if (resp?.ok && resp.settings) {
        this.settings = { ...DEFAULT_SETTINGS, ...resp.settings };
      }
    } catch {
      // Fallback to defaults if SW is waking up
    }
  }

  private async updateSettings(patch: Partial<ExtensionSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    this.scheduleRender();
    try {
      await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch });
    } catch {
      // Ignore
    }
  }

  private bindStorageSync(): void {
    chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.mtm_settings?.newValue) {
        this.settings = { ...DEFAULT_SETTINGS, ...changes.mtm_settings.newValue };
        this.scheduleRender();
      }
      if (changes.mtm_cache_cleared_at) {
        void stopCache.clear();
      }
    });
  }

  private bindBridgeMessages(): void {
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as BridgeMessage | undefined;
      if (!data || data.channel !== BRIDGE_CHANNEL) return;

      if (data.type === 'URL_CHANGE') {
        this.handleUrlChange(data.url);
      } else if (data.type === 'NETWORK_CAPTURE') {
        void this.transitData.handleNetworkCapture(data);
      }
    });
  }

  private handleUrlChange(url: string): void {
    const next = parseMapyUrl(url);
    const stopChanged =
      next.stopId !== this.viewport.stopId || next.stopId !== this.snapshot.originStopId;
    this.viewport = next;
    this.renderer.resetDragOffset();

    if (stopChanged) {
      this.hiddenLineKeys.clear();
      this.highlightedLineKey = null;
      this.hoveredHit = null;
      this.hud.hideTooltip();
      this.transitData.setOriginStop(next.stopId);
    }

    this.scheduleDomSync();
    this.scheduleRender();
  }

  private mountWhenReady(): void {
    const tryMount = (): boolean => {
      const scene = document.getElementById('scene');
      if (!scene) return false;
      const isNewScene = this.sceneEl !== scene;
      this.sceneEl = scene;
      this.renderer.mount(scene, () => this.scheduleRender());
      this.hud.mount(scene);
      if (isNewScene) {
        this.bindScenePointerEvents(scene);
      }
      this.bindSidebarObservers();
      this.scheduleDomSync();
      this.scheduleRender();
      return true;
    };

    tryMount();
    const bootObserver = new MutationObserver(() => {
      const scene = document.getElementById('scene');
      if (
        scene &&
        (this.sceneEl !== scene ||
          !document.getElementById('mapy-transit-mapper-hud-host') ||
          !document.getElementById('mapy-transit-mapper-canvas'))
      ) {
        tryMount();
      }
    });
    bootObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  private bindSidebarObservers(): void {
    if (this.domObserver) return;
    this.domObserver = new MutationObserver(() => {
      this.scheduleDomSync();
    });

    const layout = document.getElementById('layout-content') || document.body;
    this.domObserver.observe(layout, { childList: true, subtree: true });

    // Highlight map line when hovering connection rows in Mapy.com's sidebar/timeboard
    document.addEventListener(
      'mouseover',
      (e) => {
        const target = e.target as HTMLElement | null;
        const lineEl = target?.closest<HTMLElement>(
          '.content-transportlines td.linetd[data-line-id], #timeboard ul.lines li.number[data-line-id]'
        );
        if (!lineEl) return;
        const lineId = lineEl.dataset.lineId;
        if (!lineId) return;
        const match = this.snapshot.lines.find((l) => l.lineId === lineId);
        if (match && this.highlightedLineKey !== match.key) {
          this.highlightedLineKey = match.key;
          this.scheduleRender();
        }
      },
      { passive: true }
    );

    document.addEventListener(
      'mouseout',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (
          target?.closest(
            '.content-transportlines td.linetd[data-line-id], #timeboard ul.lines li.number[data-line-id]'
          )
        ) {
          if (this.highlightedLineKey !== null && !this.hoveredHit) {
            this.highlightedLineKey = null;
            this.scheduleRender();
          }
        }
      },
      { passive: true }
    );
  }

  private bindScenePointerEvents(scene: HTMLElement): void {
    scene.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('#all-controls, #mapy-transit-mapper-hud-host')) return;
        this.isDragging = true;
        this.movedDuringPointer = false;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
      },
      { passive: true }
    );

    window.addEventListener(
      'pointermove',
      (e) => {
        if (this.isDragging) {
          const dx = e.clientX - this.dragStartX;
          const dy = e.clientY - this.dragStartY;
          if (Math.hypot(dx, dy) > 4) this.movedDuringPointer = true;
          this.renderer.setDragOffset(dx, dy);
          this.scheduleRender();
          return;
        }

        if (!this.settings.enabled || !this.snapshot.originStopId) return;
        const rect = scene.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
          if (this.hoveredHit) {
            this.hoveredHit = null;
            this.highlightedLineKey = null;
            this.hud.hideTooltip();
            this.scheduleRender();
          }
          return;
        }

        const hit = this.renderer.hitTest(sx, sy);
        const prevKey = this.hoveredHit?.line.key ?? null;
        const prevStop = this.hoveredHit?.stop?.id ?? null;
        const nextKey = hit?.line.key ?? null;
        const nextStop = hit?.stop?.id ?? null;

        this.hoveredHit = hit;
        if (hit) {
          this.highlightedLineKey = hit.line.key;
          this.hud.showTooltip(hit);
          scene.style.cursor = hit.kind === 'stop' ? 'pointer' : '';
        } else {
          if (prevKey !== null) this.highlightedLineKey = null;
          this.hud.hideTooltip();
          scene.style.cursor = '';
        }

        if (prevKey !== nextKey || prevStop !== nextStop) {
          this.scheduleRender();
        }
      },
      { passive: true }
    );

    window.addEventListener(
      'pointerup',
      () => {
        this.isDragging = false;
      },
      { passive: true }
    );

    scene.addEventListener('click', (e) => {
      if (this.movedDuringPointer || !this.settings.enabled) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('#all-controls, #mapy-transit-mapper-hud-host')) return;

      const rect = scene.getBoundingClientRect();
      const hit = this.renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit?.kind === 'stop' && hit.stop && !hit.stop.isOrigin) {
        const nextUrl = buildStopNavigationUrl(window.location.href, hit.stop.id);
        window.location.assign(nextUrl);
      }
    });
  }

  private fitAllConnections(): void {
    const coords: Array<{ lat: number; lon: number }> = [];
    for (const line of this.snapshot.lines) {
      if (this.hiddenLineKeys.has(line.key)) continue;
      if (!this.settings.showNearby && line.isNearby) continue;
      for (const s of line.stops) {
        if (s.lat !== undefined && s.lon !== undefined) {
          coords.push({ lat: s.lat, lon: s.lon });
        }
      }
    }

    // If #timeboard is open, close it first so the map expands to full width
    const closeOverlayBtn = document.querySelector<HTMLButtonElement>('button.close-overlay');
    if (closeOverlayBtn) {
      closeOverlayBtn.click();
    }

    const { width, height } = this.renderer.getSize();
    const fit = computeFitViewport(coords, Math.max(width, 600), height, 80);
    if (!fit) return;

    // Update URL via SPA history + popstate so Mapy.com pans/zooms without a full page reload
    const nextUrl = buildFitViewportUrl(window.location.href, fit);
    const cleaned = new URL(nextUrl);
    cleaned.searchParams.delete('timeboard');
    window.history.pushState({}, '', cleaned.toString());
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  private scheduleDomSync(): void {
    if (this.domSyncScheduled) return;
    this.domSyncScheduled = true;
    requestAnimationFrame(() => {
      this.domSyncScheduled = false;
      this.transitData.syncFromDom();
    });
  }

  private scheduleRender(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    if (!this.sceneEl) return;
    const isTiltedOrRotated =
      Math.abs(this.viewport.pitch || 0) > 1 || Math.abs(this.viewport.bearing || 0) > 1;

    this.renderer.render({
      viewport: this.viewport,
      lines: this.snapshot.lines,
      originCoord: this.snapshot.originCoord,
      settings: this.settings,
      hiddenLineKeys: this.hiddenLineKeys,
      highlightedLineKey: this.highlightedLineKey,
      hoveredStopId: this.hoveredHit?.stop?.id ?? null,
    });

    this.hud.render({
      snapshot: this.snapshot,
      settings: this.settings,
      hiddenLineKeys: this.hiddenLineKeys,
      isTiltedOrRotated,
    });
  }

  private syncBadge(): void {
    const count = this.settings.enabled && this.snapshot.originStopId ? this.snapshot.lines.length : 0;
    void chrome.runtime.sendMessage({ type: 'SET_BADGE', count }).catch(() => {});
  }
}

const app = new MapyTransitOverlayApp();
void app.init();
