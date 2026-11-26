import { ExtensionSettings, RouteStop, TransitLine, ViewportState } from '../shared/types';
import { Point2D, projectToScene } from './map-projection';

export interface HitResult {
  kind: 'stop' | 'line';
  line: TransitLine;
  stop?: RouteStop;
  screenX: number;
  screenY: number;
}

interface ProjectedStop {
  stop: RouteStop;
  line: TransitLine;
  pt: Point2D;
}

interface ProjectedSegment {
  line: TransitLine;
  a: Point2D;
  b: Point2D;
}

export class TransitCanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sceneEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private width = 0;
  private height = 0;

  // Live gesture delta for smooth dragging between URL replaceState commits
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  // Last projected geometry for fast pointer hit-testing
  private projectedStops: ProjectedStop[] = [];
  private projectedSegments: ProjectedSegment[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'mapy-transit-mapper-canvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '5',
    });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  public mount(sceneEl: HTMLElement, onResize: () => void): void {
    if (this.sceneEl === sceneEl && this.canvas.isConnected) return;
    this.unmount();
    this.sceneEl = sceneEl;

    const allControls = sceneEl.querySelector('#all-controls');
    if (allControls) {
      sceneEl.insertBefore(this.canvas, allControls);
    } else {
      sceneEl.appendChild(this.canvas);
    }

    this.updateSize();
    this.resizeObserver = new ResizeObserver(() => {
      this.updateSize();
      onResize();
    });
    this.resizeObserver.observe(sceneEl);
  }

  public unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.remove();
    this.sceneEl = null;
  }

  public getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  public setDragOffset(dx: number, dy: number): void {
    this.dragOffsetX = dx;
    this.dragOffsetY = dy;
  }

  public resetDragOffset(): void {
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
  }

  private updateSize(): void {
    if (!this.sceneEl) return;
    const rect = this.sceneEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  public clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.projectedStops = [];
    this.projectedSegments = [];
  }

  public render(params: {
    viewport: ViewportState;
    lines: TransitLine[];
    originCoord: { lat: number; lon: number } | null;
    settings: ExtensionSettings;
    hiddenLineKeys: Set<string>;
    highlightedLineKey: string | null;
    hoveredStopId: string | null;
  }): void {
    const {
      viewport,
      lines,
      originCoord,
      settings,
      hiddenLineKeys,
      highlightedLineKey,
      hoveredStopId,
    } = params;

    this.clear();
    if (!settings.enabled || !this.sceneEl || this.width <= 1 || this.height <= 1) return;

    // Guard against 3D tilt or rotated map where 2D Web Mercator overlay would drift
    if (Math.abs(viewport.pitch || 0) > 1 || Math.abs(viewport.bearing || 0) > 1) {
      return;
    }

    const ctx = this.ctx;
    ctx.save();
    if (this.dragOffsetX !== 0 || this.dragOffsetY !== 0) {
      ctx.translate(this.dragOffsetX, this.dragOffsetY);
    }

    const visibleLines = lines.filter((line) => {
      if (hiddenLineKeys.has(line.key)) return false;
      if (!settings.showNearby && line.isNearby) return false;
      return true;
    });

    // Draw non-highlighted lines first, then highlighted line on top
    const orderedLines = [...visibleLines].sort((a, b) => {
      const aHi = a.key === highlightedLineKey ? 1 : 0;
      const bHi = b.key === highlightedLineKey ? 1 : 0;
      return aHi - bHi;
    });

    const drawnLabels: Array<{ x: number; y: number; w: number; h: number }> = [];

    for (const line of orderedLines) {
      const isHighlighted = highlightedLineKey === line.key;
      const isDimmed = highlightedLineKey !== null && !isHighlighted;

      const resolvedStops = line.stops.filter((s) => {
        if (s.lat === undefined || s.lon === undefined) return false;
        if (
          settings.maxMinutes > 0 &&
          s.minutesFromOrigin !== undefined &&
          s.minutesFromOrigin > settings.maxMinutes
        ) {
          return false;
        }
        return true;
      });

      if (resolvedStops.length === 0) continue;

      const pts = resolvedStops.map((s) => ({
        stop: s,
        pt: projectToScene(s.lon!, s.lat!, viewport, this.width, this.height),
      }));

      // 1. Draw polyline segments
      if (pts.length >= 2) {
        ctx.save();
        ctx.globalAlpha = isDimmed ? 0.22 : line.isNearby ? 0.65 : 0.92;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // White halo casing for contrast over tourist map contours
        ctx.beginPath();
        this.traceRoutePath(ctx, pts.map((p) => p.pt), settings.curvedLines);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = isHighlighted ? 8 : 6;
        ctx.setLineDash([]);
        ctx.stroke();

        // Colored route stroke
        ctx.beginPath();
        this.traceRoutePath(ctx, pts.map((p) => p.pt), settings.curvedLines);
        ctx.strokeStyle = line.color;
        ctx.lineWidth = isHighlighted ? 4.5 : 3;
        if (line.isNearby) ctx.setLineDash([7, 5]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Directional chevrons on segments longer than 42px
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i].pt;
          const b = pts[i + 1].pt;
          this.projectedSegments.push({ line, a, b });
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          if (dist >= 42) {
            this.drawChevron(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x), line.color);
          }
        }
        ctx.restore();
      }

      // 2. Draw stop nodes
      for (const { stop, pt } of pts) {
        this.projectedStops.push({ stop, line, pt });

        const isHovered = hoveredStopId === stop.id;
        const radius = stop.isOrigin ? 7 : isHovered ? 6.5 : isHighlighted ? 5.5 : 4.5;
        const fill = settings.travelTimeColors
          ? this.travelTimeColor(stop.minutesFromOrigin)
          : line.color;

        ctx.save();
        ctx.globalAlpha = isDimmed && !stop.isOrigin ? 0.28 : 1;

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius + 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = stop.isOrigin ? '#0f766e' : fill;
        ctx.fill();

        // Optional stop label + travel time badge
        const shouldLabel =
          settings.showStopLabels &&
          !stop.isOrigin &&
          (isHighlighted || isHovered || viewport.zoom >= 13.5);

        if (shouldLabel && pt.x > -40 && pt.x < this.width + 40 && pt.y > -20 && pt.y < this.height + 20) {
          const labelText =
            stop.minutesFromOrigin !== undefined
              ? `${stop.name} (+${stop.minutesFromOrigin}m)`
              : stop.name;
          ctx.font = '600 11px system-ui, -apple-system, sans-serif';
          const textW = ctx.measureText(labelText).width;
          const box = { x: pt.x + 9, y: pt.y - 10, w: textW + 10, h: 18 };
          const overlaps = !isHovered && drawnLabels.some((b) => this.boxesOverlap(b, box));
          if (!overlaps) {
            drawnLabels.push(box);
            this.drawLabelPill(ctx, box.x, box.y, box.w, box.h, labelText, fill);
          }
        }
        ctx.restore();
      }
    }

    // 3. Draw emphasized origin hub marker on top
    if (originCoord) {
      const originPt = projectToScene(
        originCoord.lon,
        originCoord.lat,
        viewport,
        this.width,
        this.height
      );
      ctx.save();
      ctx.beginPath();
      ctx.arc(originPt.x, originPt.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 118, 110, 0.22)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(originPt.x, originPt.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(originPt.x, originPt.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#0f766e';
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  public hitTest(screenX: number, screenY: number): HitResult | null {
    const x = screenX - this.dragOffsetX;
    const y = screenY - this.dragOffsetY;

    // 1. Check stop nodes first (10px radius)
    let bestStop: HitResult | null = null;
    let bestStopDist = 11;
    for (const item of this.projectedStops) {
      const d = Math.hypot(x - item.pt.x, y - item.pt.y);
      if (d < bestStopDist) {
        bestStopDist = d;
        bestStop = {
          kind: 'stop',
          line: item.line,
          stop: item.stop,
          screenX: item.pt.x + this.dragOffsetX,
          screenY: item.pt.y + this.dragOffsetY,
        };
      }
    }
    if (bestStop) return bestStop;

    // 2. Check line segments (8px tolerance)
    let bestLine: HitResult | null = null;
    let bestLineDist = 8;
    for (const seg of this.projectedSegments) {
      const d = this.distToSegment(x, y, seg.a.x, seg.a.y, seg.b.x, seg.b.y);
      if (d < bestLineDist) {
        bestLineDist = d;
        bestLine = {
          kind: 'line',
          line: seg.line,
          screenX,
          screenY,
        };
      }
    }
    return bestLine;
  }

  private traceRoutePath(ctx: CanvasRenderingContext2D, pts: Point2D[], curved: boolean): void {
    ctx.moveTo(pts[0].x, pts[0].y);
    if (!curved || pts.length <= 2) {
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      return;
    }
    // Subtle Catmull-Rom -> cubic Bezier spline so the curve passes through every stop
    const tension = 0.25;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];

      const cp1x = p1.x + ((p2.x - p0.x) * tension) / 3;
      const cp1y = p1.y + ((p2.y - p0.y) * tension) / 3;
      const cp2x = p2.x - ((p3.x - p1.x) * tension) / 3;
      const cp2y = p2.y - ((p3.y - p1.y) * tension) / 3;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  private drawChevron(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    angle: number,
    color: string
  ): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-4, -3.5);
    ctx.lineTo(3, 0);
    ctx.lineTo(-4, 3.5);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  private drawLabelPill(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
    accent: string
  ): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y + h / 2 + 0.5);
  }

  private travelTimeColor(minutes?: number): string {
    if (minutes === undefined) return '#64748b';
    if (minutes <= 10) return '#10b981'; // emerald
    if (minutes <= 25) return '#f59e0b'; // amber
    return '#ef4444'; // red
  }

  private boxesOverlap(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ): boolean {
    return !(a.x + a.w + 4 < b.x || b.x + b.w + 4 < a.x || a.y + a.h + 2 < b.y || b.y + b.h + 2 < a.y);
  }

  private distToSegment(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
}
