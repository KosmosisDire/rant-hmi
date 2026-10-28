// Scroll and zoom on a running screen: a wheel or a trackpad over an element that takes them,
// two fingers on it, or one that moves on what takes scroll. What a frame brings gathers and
// goes once, as the element's own x counts it.

import { createEffect, createMemo, onCleanup } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { Scope } from "../state/bind";
import { eventInfo, takes } from "../state/events";
import { fingers } from "../ui/fingers";
import { kept, take } from "../ui/press";
import { wheelPx, zoomBy } from "../ui/wheel";
import type { Act } from "./act";
import { moved, partOf, pointer, type Spot } from "./pointer";

/** Where a scroll or a zoom comes from, as its `from` filter names it. */
type From = "wheel" | "fingers";

/** Whether `h` hears what fingers on the element do, so the browser must pan nothing there. */
const fingered = (h: Handler) => eventInfo(h.event)?.from === "wheel" && takes(h, h.event, { from: "fingers" });

/** How far a lone finger moves before it scrolls, in px, so a tap stays a tap. */
const SLOP = 10;

/** Safari's pinch on a trackpad, which comes as no wheel. */
type Gesture = Event & { scale: number; clientX?: number; clientY?: number };

/** An element's scroll and zoom, and whether fingers move it, so a finger on it pans no page.
 *  A wheel or a trackpad's glide scrolls it, and with Ctrl, as a trackpad's pinch comes, zooms
 *  it: one that takes no scroll from a wheel zooms by any wheel. Two fingers scroll it by their
 *  middle and zoom it by their spread, the innermost that hears first, and end the presses
 *  they began. One finger scrolls it once it moves a little, unless what it pressed drags.
 *  Each says what it came from, a wheel or fingers. What no handler here hears is left to
 *  what holds it, so the page or a frame around still scrolls. */
export function useScroll(p: { element: Element; act?: Act; scope: Scope }, self: () => globalThis.Element | undefined) {
  const scrolls = createMemo(() => !!p.act && p.element.handlers.some(fingered));
  const wheeled = createMemo(() => !!p.act && p.element.handlers.some((h) => eventInfo(h.event)?.from === "wheel"));
  createEffect(() => {
    const el = self();
    const act = p.act;
    if (!el || !act || !wheeled()) return;
    const hears = (event: string, from: From) => p.element.handlers.some((h) => takes(h, event, { from }) && act.hears(p.element, h, p.scope));
    // since the last frame: how far what it shows moved in px on the screen, the zoom, where,
    // and what moved it
    let gathered: { sx: number; sy: number; zoom: number; at: Spot; on: string | null; from: From } | null = null;
    const send = () => {
      if (!gathered) return;
      const { sx, sy, zoom, at, on, from } = gathered;
      gathered = null;
      const { x, y, w, h } = pointer(el, at, on);
      if (sx !== 0 || sy !== 0) act.fire(p.element, "scroll", { x, y, on, from, w, h, ...moved(el, sx, sy) }, p.scope);
      if (zoom !== 1) act.fire(p.element, "zoom", { x, y, on, from, w, h, factor: zoom }, p.scope);
    };
    const gather = (from: From, at: Spot, on: string | null, sx: number, sy: number, zoom = 1) => {
      if (!gathered) {
        gathered = { sx: 0, sy: 0, zoom: 1, at, on, from };
        requestAnimationFrame(send);
      }
      Object.assign(gathered, { at, on, from, sx: gathered.sx + sx, sy: gathered.sy + sy, zoom: gathered.zoom * zoom });
    };
    // the part under a place, when it is on this element
    const under = (at: Spot) => {
      const hit = document.elementFromPoint(at.clientX, at.clientY);
      return hit && el.contains(hit) ? partOf(hit) : null;
    };

    const wheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      const zooms = e.ctrlKey || !hears("scroll", "wheel");
      if (!hears(zooms ? "zoom" : "scroll", "wheel")) return;
      e.preventDefault();
      const px = wheelPx(e, el.getBoundingClientRect());
      // what it shows moves against the turn, across for a wheel that turns one way with Shift
      if (zooms) gather("wheel", e, partOf(e.target), 0, 0, zoomBy(px.y));
      else if (e.shiftKey && px.x === 0) gather("wheel", e, partOf(e.target), -px.y, 0);
      else gather("wheel", e, partOf(e.target), -px.x, -px.y);
    };

    // the gesture that takes fingers here, and the finger scrolling alone and where it was last
    const me = {};
    let last: Spot & { spread: number } | null = null;
    let alone: { id: number; from: Spot } | null = null;
    const finger = fingers({
      begin: (at, ids) => {
        if (!(hears("scroll", "fingers") || hears("zoom", "fingers")) || !take(ids, me)) return false;
        last = at;
        return true;
      },
      move: (at) => {
        if (!last) return;
        gather("fingers", at, under(at), at.clientX - last.clientX, at.clientY - last.clientY, at.spread / last.spread);
        last = at;
      },
      end: () => (last = null),
      lone: (down, now) => {
        if (alone?.id !== down.pointerId) {
          if (!hears("scroll", "fingers") || Math.hypot(now.clientX - down.clientX, now.clientY - down.clientY) < SLOP || kept(down.pointerId) || !take([down.pointerId], me)) return;
          alone = { id: down.pointerId, from: down };
        }
        gather("fingers", now, partOf(down.target), now.clientX - alone.from.clientX, now.clientY - alone.from.clientY);
        alone.from = now;
      },
    });
    // a pinch the innermost takes first, so one around it finds the fingers held. A finger
    // alone is a new one, as a pointer's id may come again
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && finger.down(e) === 1) alone = null;
    };

    // a fingers' own pinch on a touch screen comes as these too, so they count only without
    let scale = 1;
    const gesture = (e: Event) => {
      const g = e as Gesture;
      if (e.defaultPrevented || finger.count() > 0 || !hears("zoom", "wheel")) return;
      e.preventDefault();
      const s = e.type === "gesturestart" ? 1 : g.scale;
      const r = el.getBoundingClientRect();
      const at = Number.isFinite(g.clientX) && Number.isFinite(g.clientY) ? { clientX: g.clientX!, clientY: g.clientY! } : { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      if (s !== scale) gather("wheel", at, under(at), 0, 0, s / scale);
      scale = s;
    };

    el.addEventListener("wheel", wheel as EventListener, { passive: false });
    el.addEventListener("pointerdown", down as EventListener);
    for (const type of ["gesturestart", "gesturechange"]) el.addEventListener(type, gesture);
    onCleanup(() => {
      el.removeEventListener("wheel", wheel as EventListener);
      el.removeEventListener("pointerdown", down as EventListener);
      for (const type of ["gesturestart", "gesturechange"]) el.removeEventListener(type, gesture);
      gathered = null;
    });
  });
  return scrolls;
}
