/* The canvas viewport: the artboard is a fixed-aspect SVG in canvas units, and this
 * scales it to fit and never stretches it (spec 3.1). Edit mode adds pan and zoom on
 * every device (wheel, drag on empty space, pinch); operate mode locks to fit on
 * desktop, so an accidental zoom on a wall panel cannot happen. Pan and zoom are one
 * CSS transform, so they never repaint the artboard. */

import { armSwallow } from "./menu.js";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const MARGIN = 28;

export interface ViewportHooks {
  /* may this pointerdown start a pan? (a widget keeps its own drag) */
  canPan(ev: PointerEvent): boolean;
  onTap(x: number, y: number, ev: PointerEvent): void;
  /* the transform changed: anything drawn in screen-constant sizes must redraw */
  onViewChange(): void;
  /* touch stand-in for right-click */
  onLongPress(x: number, y: number, ev: PointerEvent): void;
}

const LONG_PRESS_MS = 480;

export class Viewport {
  private fitScale = 1;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private unitW = 1440;
  private unitH = 810;
  private locked = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: any = null;
  private longPress: any = null;

  constructor(private stage: HTMLElement, private layer: HTMLElement, private hooks: ViewportHooks) {
    stage.addEventListener("wheel", (ev) => this.onWheel(ev as WheelEvent), { passive: false });
    stage.addEventListener("pointerdown", (ev) => this.onDown(ev as PointerEvent));
    stage.addEventListener("pointermove", (ev) => this.onMove(ev as PointerEvent));
    stage.addEventListener("pointerup", (ev) => this.onUp(ev as PointerEvent));
    stage.addEventListener("pointercancel", (ev) => this.onUp(ev as PointerEvent));
    window.addEventListener("blur", () => {
      this.pointers.clear();
      this.gesture = null;
      this.cancelLongPress();
    });
    new ResizeObserver(() => this.fit(false)).observe(stage);
  }

  setArtboard(w: number, h: number): void {
    this.unitW = w;
    this.unitH = h;
    this.layer.style.width = w + "px";
    this.layer.style.height = h + "px";
    this.fit(true);
  }

  /* lock to fit (operate mode on a desktop) */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.fit(true);
  }

  scale(): number {
    return this.fitScale * this.zoom;
  }

  /* a client point in artboard units */
  toArtboard(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.stage.getBoundingClientRect();
    const s = this.scale();
    return { x: (clientX - box.left - this.panX) / s, y: (clientY - box.top - this.panY) / s };
  }

  fit(reset: boolean): void {
    const w = this.stage.clientWidth || 1;
    const h = this.stage.clientHeight || 1;
    this.fitScale = Math.min((w - 2 * MARGIN) / this.unitW, (h - 2 * MARGIN) / this.unitH);
    if (this.fitScale <= 0) this.fitScale = 0.1;
    if (reset || this.locked) this.zoom = 1;
    this.center(reset || this.locked);
    this.apply();
  }

  private center(hard: boolean): void {
    const w = this.stage.clientWidth || 1;
    const h = this.stage.clientHeight || 1;
    const s = this.scale();
    if (hard) {
      this.panX = (w - this.unitW * s) / 2;
      this.panY = (h - this.unitH * s) / 2;
      return;
    }
    /* keep at least a corner of the artboard reachable */
    const keep = 100;
    this.panX = Math.max(keep - this.unitW * s, Math.min(w - keep, this.panX));
    this.panY = Math.max(keep - this.unitH * s, Math.min(h - keep, this.panY));
  }

  private apply(): void {
    this.hooks.onViewChange();
    this.layer.style.transform =
      `translate(${this.panX.toFixed(1)}px,${this.panY.toFixed(1)}px) scale(${this.scale().toFixed(4)})`;
  }

  private zoomAt(px: number, py: number, zoom: number): void {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const before = this.scale();
    const cx = (px - this.panX) / before;
    const cy = (py - this.panY) / before;
    this.zoom = next;
    const after = this.scale();
    this.panX = px - cx * after;
    this.panY = py - cy * after;
    this.center(false);
    this.apply();
  }

  private onWheel(ev: WheelEvent): void {
    if (this.locked) return;
    ev.preventDefault();
    const box = this.stage.getBoundingClientRect();
    this.zoomAt(ev.clientX - box.left, ev.clientY - box.top, this.zoom * Math.exp(-ev.deltaY * 0.0015));
  }

  private onDown(ev: PointerEvent): void {
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    this.startLongPress(ev);
    if (this.locked) return;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const box = this.stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - box.left;
      const my = (a.y + b.y) / 2 - box.top;
      const s = this.scale();
      this.gesture = {
        mode: "pinch",
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: this.zoom,
        ax: (mx - this.panX) / s,
        ay: (my - this.panY) / s,
      };
      return;
    }
    if (this.pointers.size !== 1) return;
    if (ev.button !== 1 && !this.hooks.canPan(ev)) return;
    this.gesture = {
      mode: "pan",
      sx: ev.clientX,
      sy: ev.clientY,
      px: this.panX,
      py: this.panY,
      moved: false,
    };
    try {
      this.stage.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety, not a requirement */
    }
  }

  private onMove(ev: PointerEvent): void {
    if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.longPress && Math.hypot(ev.clientX - this.longPress.x, ev.clientY - this.longPress.y) > 8)
      this.cancelLongPress();
    if (!this.gesture) return;
    const box = this.stage.getBoundingClientRect();
    if (this.gesture.mode === "pinch") {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const mx = (a.x + b.x) / 2 - box.left;
      const my = (a.y + b.y) / 2 - box.top;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (this.gesture.z0 * distance) / this.gesture.d0));
      const s = this.scale();
      this.panX = mx - this.gesture.ax * s;
      this.panY = my - this.gesture.ay * s;
      this.center(false);
      this.apply();
      ev.preventDefault();
      return;
    }
    const dx = ev.clientX - this.gesture.sx;
    const dy = ev.clientY - this.gesture.sy;
    if (!this.gesture.moved && Math.hypot(dx, dy) > 5) this.gesture.moved = true;
    this.panX = this.gesture.px + dx;
    this.panY = this.gesture.py + dy;
    this.center(false);
    this.apply();
  }

  private onUp(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    this.cancelLongPress();
    if (!this.gesture) return;
    if (this.gesture.mode === "pan" && !this.gesture.moved) {
      const point = this.toArtboard(ev.clientX, ev.clientY);
      this.hooks.onTap(point.x, point.y, ev);
    }
    if (this.pointers.size === 0) this.gesture = null;
  }

  /* a long press is the touch stand-in for right-click; a mouse uses contextmenu */
  private startLongPress(ev: PointerEvent): void {
    this.cancelLongPress();
    if (ev.pointerType === "mouse" || this.pointers.size !== 1) return;
    const point = this.toArtboard(ev.clientX, ev.clientY);
    this.longPress = {
      x: ev.clientX,
      y: ev.clientY,
      timer: window.setTimeout(() => {
        this.longPress = null;
        this.gesture = null;
        armSwallow();
        this.hooks.onLongPress(point.x, point.y, ev);
      }, LONG_PRESS_MS),
    };
  }

  private cancelLongPress(): void {
    if (!this.longPress) return;
    window.clearTimeout(this.longPress.timer);
    this.longPress = null;
  }
}
