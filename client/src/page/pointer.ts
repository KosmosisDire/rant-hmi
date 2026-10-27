// Where a pointer is on an element as it is drawn, turned and scaled with all around it.

import { UNIT } from "../state/bind";

/** A place on the screen, as a pointer's or a wheel's event gives it. */
export interface Spot {
  clientX: number;
  clientY: number;
}

/** What a pointer event brings: where across the element, 0 to 1, the angle around its
 *  centre (0 up, clockwise), the named part the press began on, whether it is inside, and the
 *  element's width and height as its own x and y count. */
export interface Pointer {
  x: number;
  y: number;
  angle: number;
  on: string | null;
  inside: boolean;
  w: number;
  h: number;
}

/** The named part an event happened on, the innermost. */
export const partOf = (target: EventTarget | null): string | null => (target as globalThis.Element).closest<HTMLElement | SVGElement>(".el[data-name]")?.dataset.name ?? null;

export function pointer(el: globalThis.Element, e: Spot, on: string | null): Pointer {
  const at = local(el, e);
  // a diagram's matrix is single precision, so its noise is rounded away
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5;
  const angle = (Math.atan2(at.x - at.w / 2, at.h / 2 - at.y) * 180) / Math.PI;
  // a frame measures itself in px, a shape in its diagram's units
  const units = el instanceof SVGGraphicsElement ? 1 : UNIT;
  const size = (v: number) => Math.round((v / units) * 1e5) / 1e5;
  const inside = at.x >= 0 && at.y >= 0 && at.x <= at.w && at.y <= at.h;
  return { x: clamp(at.w > 0 ? at.x / at.w : 0), y: clamp(at.h > 0 ? at.y / at.h : 0), angle, on, inside, w: size(at.w), h: size(at.h) };
}

/** A pointer's buttons by number, as its events bring them, a finger and a pen's tip left. */
const BUTTONS = ["left", "middle", "right"];

/** The button an event pressed or let go, by name, or undefined for one beyond these. */
export const buttonOf = (e: MouseEvent): string | undefined => BUTTONS[e.button];

/** The keys held as a pointer's event came. */
export const keysHeld = (e: MouseEvent) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });

/** Where a pointer falls in an element as drawn, turned and scaled with all around it: from
 *  its own top left in its own units, with its own width and height. */
export function local(el: globalThis.Element, e: Spot): { x: number; y: number; w: number; h: number } {
  if (el instanceof SVGGraphicsElement) {
    const m = el.getScreenCTM();
    const b = el.getBBox();
    if (m) {
      const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return { x: at.x - b.x, y: at.y - b.y, w: b.width, h: b.height };
    }
  }
  const { w, h, cos, sin, k, r } = drawn(el);
  const [dx, dy] = [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
  return { x: (cos * dx + sin * dy) / k + w / 2, y: (cos * dy - sin * dx) / k + h / 2, w, h };
}

/** A move of `sx` and `sy` px on the screen as the x and y of `el` count it: in the units of
 *  what holds it, a diagram's for a shape, turned and scaled as that is drawn. */
export function moved(el: globalThis.Element, sx: number, sy: number): { dx: number; dy: number } {
  const fine = (v: number) => Math.round(v * 1e5) / 1e5;
  const holder = el instanceof HTMLElement ? (el.offsetParent ?? el.parentElement) : el.parentElement;
  const m = holder instanceof SVGGraphicsElement ? holder.getScreenCTM()?.inverse() : undefined;
  if (m) return { dx: fine(m.a * sx + m.c * sy), dy: fine(m.b * sx + m.d * sy) };
  const { cos, sin, k } = holder ? drawn(holder) : { cos: 1, sin: 0, k: 1 };
  return { dx: fine((cos * sx + sin * sy) / k / UNIT), dy: fine((cos * sy - sin * sx) / k / UNIT) };
}

/** How an element is drawn: its own width and height, the turn of it and all around it, the
 *  scale its drawn box shows and that box. */
function drawn(el: globalThis.Element) {
  const [w, h] = el instanceof HTMLElement ? [el.offsetWidth, el.offsetHeight] : [0, 0];
  let turn = 0;
  for (let a: globalThis.Element | null = el; a; a = a.parentElement) {
    const s = getComputedStyle(a);
    turn += parseFloat(s.rotate) || 0;
    if (s.transform !== "none") {
      const m = new DOMMatrix(s.transform);
      turn += (Math.atan2(m.b, m.a) * 180) / Math.PI;
    }
  }
  const t = (turn * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const r = el.getBoundingClientRect();
  const across = w * Math.abs(cos) + h * Math.abs(sin);
  return { w, h, cos, sin, k: across > 0 ? r.width / across : 1, r };
}
