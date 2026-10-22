// Scroll and zoom on a running screen, from a wheel or a trackpad over an element that takes
// them. What the turns of a frame move gathers and goes once, as the element's own x counts it.

import { createEffect, onCleanup } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { At } from "../state/bind";
import { eventInfo } from "../state/events";
import { wheelPx, zoomBy } from "../ui/wheel";
import type { Act } from "./act";
import { moved, partOf, pointer, type Spot } from "./pointer";

const wheeled = (h: Handler) => eventInfo(h.event)?.from === "wheel";

/** An element's scroll and zoom. A wheel or a trackpad's glide scrolls it, and with Ctrl, as a
 *  trackpad's pinch comes, zooms it: one that takes no scroll zooms by any wheel. A turn no
 *  handler here hears is left to what holds it, so the page or a frame around still scrolls. */
export function useScroll(p: { element: Element; act?: Act; at?: At }, self: () => globalThis.Element | undefined) {
  createEffect(() => {
    const el = self();
    const act = p.act;
    if (!el || !act || !p.element.handlers.some(wheeled)) return;
    const hears = (event: string) => p.element.handlers.some((h) => h.event === event && act.hears(p.element, h, p.at));
    // since the last frame: how far what it shows moved in px on the screen, the zoom, and the last turn's place
    let gathered: { sx: number; sy: number; zoom: number; at: Spot; on: string | null } | null = null;
    const send = () => {
      if (!gathered) return;
      const { sx, sy, zoom, at, on } = gathered;
      gathered = null;
      const { x, y } = pointer(el, at, on);
      if (sx !== 0 || sy !== 0) act.fire(p.element, "scroll", { x, y, on, ...moved(el, sx, sy) }, p.at);
      if (zoom !== 1) act.fire(p.element, "zoom", { x, y, on, factor: zoom }, p.at);
    };
    const wheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      const zooms = e.ctrlKey || !hears("scroll");
      if (!hears(zooms ? "zoom" : "scroll")) return;
      e.preventDefault();
      if (!gathered) {
        gathered = { sx: 0, sy: 0, zoom: 1, at: e, on: null };
        requestAnimationFrame(send);
      }
      Object.assign(gathered, { at: e, on: partOf(e.target) });
      const px = wheelPx(e, el.getBoundingClientRect());
      if (zooms) gathered.zoom *= zoomBy(px.y);
      // what it shows moves against the turn, across for a wheel that turns one way with Shift
      else if (e.shiftKey && px.x === 0) gathered.sx -= px.y;
      else {
        gathered.sx -= px.x;
        gathered.sy -= px.y;
      }
    };
    el.addEventListener("wheel", wheel as EventListener, { passive: false });
    onCleanup(() => {
      el.removeEventListener("wheel", wheel as EventListener);
      gathered = null;
    });
  });
}
