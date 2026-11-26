import { ExtensionSettings, TransitLine } from '../shared/types';
import { HitResult } from './canvas-renderer';
import { TransitStateSnapshot } from './transit-data';

export interface HudCallbacks {
  onFitView: () => void;
  onToggleLine: (lineKey: string) => void;
  onHoverLine: (lineKey: string | null) => void;
  onPatchSettings: (patch: Partial<ExtensionSettings>) => void;
}

export class TransitHudUi {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private panelEl: HTMLDivElement;
  private tooltipEl: HTMLDivElement;
  private collapsed = false;
  private callbacks: HudCallbacks;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.host = document.createElement('div');
    this.host.id = 'mapy-transit-mapper-hud-host';
    Object.assign(this.host.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '25',
    });

    this.shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f8fafc;
      }
      .panel {
        position: absolute;
        top: 64px;
        left: 12px;
        width: min(248px, calc(100% - 24px));
        max-height: calc(100% - 140px);
        overflow-y: auto;
        background: rgba(15, 23, 42, 0.92);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 12px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
        padding: 10px 12px;
        pointer-events: auto;
        font-size: 12px;
        line-height: 1.35;
      }
      .panel.hidden { display: none; }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 8px;
      }
      .title-wrap {
        min-width: 0;
      }
      .title {
        font-weight: 700;
        font-size: 12.5px;
        color: #f8fafc;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub {
        font-size: 10.5px;
        color: #94a3b8;
      }
      .icon-btn {
        background: rgba(148, 163, 184, 0.16);
        border: none;
        color: #e2e8f0;
        border-radius: 6px;
        padding: 4px 7px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
      }
      .icon-btn:hover { background: rgba(148, 163, 184, 0.3); }
      .actions {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
      }
      .primary-btn {
        flex: 1;
        background: #0f766e;
        color: #ffffff;
        border: none;
        border-radius: 7px;
        padding: 6px 8px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .primary-btn:hover { background: #0d9488; }
      .primary-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .toggles {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-bottom: 8px;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(148, 163, 184, 0.3);
        background: rgba(30, 41, 59, 0.8);
        color: #cbd5e1;
        user-select: none;
      }
      .chip.active {
        background: rgba(15, 118, 110, 0.35);
        border-color: #14b8a6;
        color: #ffffff;
      }
      .lines {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 6px;
      }
      .line-row {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 4px 6px;
        border-radius: 7px;
        cursor: pointer;
        background: rgba(30, 41, 59, 0.55);
        border: 1px solid transparent;
      }
      .line-row:hover {
        background: rgba(51, 65, 85, 0.85);
        border-color: rgba(148, 163, 184, 0.3);
      }
      .line-row.muted { opacity: 0.45; }
      .badge {
        min-width: 28px;
        text-align: center;
        padding: 2px 5px;
        border-radius: 5px;
        font-weight: 700;
        font-size: 11px;
        color: #ffffff;
      }
      .line-meta {
        min-width: 0;
        flex: 1;
      }
      .line-dest {
        font-size: 11px;
        color: #f1f5f9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .line-sub {
        font-size: 10px;
        color: #94a3b8;
      }
      .slider-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 6px 0;
        font-size: 11px;
        color: #cbd5e1;
      }
      .slider-row input { flex: 1; accent-color: #14b8a6; }
      .warn {
        background: rgba(217, 119, 6, 0.2);
        border: 1px solid rgba(251, 191, 36, 0.5);
        color: #fde68a;
        border-radius: 7px;
        padding: 5px 7px;
        font-size: 11px;
        margin-bottom: 7px;
      }
      .tooltip {
        position: absolute;
        display: none;
        max-width: 230px;
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 8px;
        padding: 7px 9px;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.38);
        pointer-events: none;
        font-size: 11.5px;
        color: #f8fafc;
        z-index: 30;
      }
      .tooltip.visible { display: block; }
      .tt-head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 700;
        margin-bottom: 3px;
      }
      .tt-sub {
        font-size: 10.5px;
        color: #cbd5e1;
      }
      .tt-hint {
        margin-top: 4px;
        font-size: 10px;
        color: #5eead4;
      }
    `;

    this.panelEl = document.createElement('div');
    this.panelEl.className = 'panel hidden';

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'tooltip';

    this.shadow.append(style, this.panelEl, this.tooltipEl);
  }

  public mount(sceneEl: HTMLElement): void {
    if (this.host.parentElement === sceneEl) return;
    sceneEl.appendChild(this.host);
  }

  public unmount(): void {
    this.host.remove();
  }

  public render(params: {
    snapshot: TransitStateSnapshot;
    settings: ExtensionSettings;
    hiddenLineKeys: Set<string>;
    isTiltedOrRotated: boolean;
  }): void {
    const { snapshot, settings, hiddenLineKeys, isTiltedOrRotated } = params;

    if (!settings.enabled || !snapshot.originStopId) {
      this.panelEl.classList.add('hidden');
      this.hideTooltip();
      return;
    }

    this.panelEl.classList.remove('hidden');
    this.panelEl.replaceChildren();

    // Header
    const header = document.createElement('div');
    header.className = 'header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'title-wrap';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = snapshot.originStopName || `Transit Stop #${snapshot.originStopId}`;

    const sub = document.createElement('div');
    sub.className = 'sub';
    const loadingText =
      snapshot.pendingStopCount > 0
        ? ` • resolving ${snapshot.pendingStopCount} stops…`
        : '';
    sub.textContent = `${snapshot.lines.length} line(s) • ${snapshot.resolvedStopCount}/${snapshot.totalUniqueStops} stops${loadingText}`;

    titleWrap.append(title, sub);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'icon-btn';
    collapseBtn.textContent = this.collapsed ? '+' : '−';
    collapseBtn.title = this.collapsed ? 'Expand' : 'Collapse';
    collapseBtn.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render(params);
    });

    header.append(titleWrap, collapseBtn);
    this.panelEl.append(header);

    if (this.collapsed) return;

    if (isTiltedOrRotated) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = 'Switch to 2D north-up view for exact transit overlay alignment.';
      this.panelEl.append(warn);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'actions';
    const fitBtn = document.createElement('button');
    fitBtn.className = 'primary-btn';
    fitBtn.textContent = 'Fit all connections';
    fitBtn.disabled = snapshot.resolvedStopCount < 2;
    fitBtn.addEventListener('click', () => this.callbacks.onFitView());
    actions.append(fitBtn);
    this.panelEl.append(actions);

    // Quick toggles
    const toggles = document.createElement('div');
    toggles.className = 'toggles';
    toggles.append(
      this.makeToggleChip('Nearby', settings.showNearby, () =>
        this.callbacks.onPatchSettings({ showNearby: !settings.showNearby })
      ),
      this.makeToggleChip('Travel time', settings.travelTimeColors, () =>
        this.callbacks.onPatchSettings({ travelTimeColors: !settings.travelTimeColors })
      ),
      this.makeToggleChip('Labels', settings.showStopLabels, () =>
        this.callbacks.onPatchSettings({ showStopLabels: !settings.showStopLabels })
      )
    );
    this.panelEl.append(toggles);

    if (settings.travelTimeColors) {
      const sliderRow = document.createElement('div');
      sliderRow.className = 'slider-row';
      const lbl = document.createElement('span');
      lbl.textContent = settings.maxMinutes > 0 ? `≤ ${settings.maxMinutes}m` : 'All';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '60';
      slider.step = '5';
      slider.value = String(settings.maxMinutes);
      slider.addEventListener('input', () => {
        this.callbacks.onPatchSettings({ maxMinutes: Number(slider.value) });
      });
      sliderRow.append(document.createTextNode('Max:'), slider, lbl);
      this.panelEl.append(sliderRow);
    }

    // Line list
    const linesWrap = document.createElement('div');
    linesWrap.className = 'lines';
    for (const line of snapshot.lines) {
      linesWrap.append(this.makeLineRow(line, hiddenLineKeys.has(line.key)));
    }
    if (snapshot.lines.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sub';
      empty.textContent = 'Open a connection or timetable in the sidebar to map its stops.';
      linesWrap.append(empty);
    }
    this.panelEl.append(linesWrap);
  }

  private makeToggleChip(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `chip${active ? ' active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private makeLineRow(line: TransitLine, hidden: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.className = `line-row${hidden ? ' muted' : ''}`;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = line.color;
    badge.textContent = line.label;

    const meta = document.createElement('div');
    meta.className = 'line-meta';
    const dest = document.createElement('div');
    dest.className = 'line-dest';
    dest.textContent = line.destination || `${line.stops.length} stops`;

    const sub = document.createElement('div');
    sub.className = 'line-sub';
    const resolvedCount = line.stops.filter((s) => s.lat !== undefined).length;
    sub.textContent = `${line.isNearby ? 'Nearby • ' : ''}${resolvedCount}/${line.stops.length} stops`;

    meta.append(dest, sub);
    row.append(badge, meta);

    row.addEventListener('click', () => this.callbacks.onToggleLine(line.key));
    row.addEventListener('mouseenter', () => this.callbacks.onHoverLine(line.key));
    row.addEventListener('mouseleave', () => this.callbacks.onHoverLine(null));
    return row;
  }

  public showTooltip(hit: HitResult): void {
    this.tooltipEl.replaceChildren();

    const head = document.createElement('div');
    head.className = 'tt-head';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = hit.line.color;
    badge.textContent = hit.line.label;

    const title = document.createElement('span');
    title.textContent = hit.stop ? hit.stop.name : `→ ${hit.line.destination}`;
    head.append(badge, title);
    this.tooltipEl.append(head);

    const details: string[] = [];
    if (hit.stop?.minutesFromOrigin !== undefined) {
      details.push(`+${hit.stop.minutesFromOrigin} min from selected stop`);
    }
    if (hit.stop?.zone) {
      details.push(`Zone: ${hit.stop.zone}`);
    }
    if (hit.line.destination && hit.stop) {
      details.push(`Direction: ${hit.line.destination}`);
    }
    if (hit.line.nextDepartures.length > 0) {
      details.push(`Next: ${hit.line.nextDepartures.slice(0, 3).join(', ')}`);
    }

    for (const line of details) {
      const div = document.createElement('div');
      div.className = 'tt-sub';
      div.textContent = line;
      this.tooltipEl.append(div);
    }

    if (hit.stop && !hit.stop.isOrigin) {
      const hint = document.createElement('div');
      hint.className = 'tt-hint';
      hint.textContent = 'Click stop to open on map';
      this.tooltipEl.append(hint);
    }

    this.tooltipEl.style.left = `${Math.max(12, hit.screenX + 14)}px`;
    this.tooltipEl.style.top = `${Math.max(12, hit.screenY - 12)}px`;
    this.tooltipEl.classList.add('visible');
  }

  public hideTooltip(): void {
    this.tooltipEl.classList.remove('visible');
  }
}
