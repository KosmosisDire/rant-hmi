// Where a pointer is on an element as it is drawn, turned and scaled with all around it.

/** A place on the screen, as a pointer's or a wheel's event gives it. */
export interface Spot {
  clientX: number;
  clientY: number;
}

/** What a pointer event brings: where across the element, 0 to 1, the angle around its
 *  centre (0 up, clockwise), the named part the press began on, and whether it is inside. */
export interface Pointer {
  x: number;
  y: number;
  angle: number;
  on: string | null;
  inside: boolean;
}

/** The named part an event happened on, the innermost. */
export const partOf = (target: EventTarget | null): string | null => (target as globalThis.Element).closest<HTMLElement | SVGElement>(".el[data-name]")?.dataset.name ?? null;

export function pointer(el: globalThis.Element, e: Spot, on: string | null): Pointer {
  const at = local(el, e);
  // a diagram's matrix is single precision, so its noise is rounded away
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5;
  const angle = (Math.atan2(at.x - at.w / 2, at.h / 2 - at.y) * 180) / Math.PI;
  return { x: clamp(at.w > 0 ? at.x / at.w : 0), y: clamp(at.h > 0 ? at.y / at.h : 0), angle, on, inside: at.x >= 0 && at.y >= 0 && at.x <= at.w && at.y <= at.h };
}

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
  const [w, h] = el instanceof HTMLElement ? [el.offsetWidth, el.offsetHeight] : [0, 0];
  // the turn of it and all around it, then the scale its drawn box shows
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
  const k = across > 0 ? r.width / across : 1;
  const [dx, dy] = [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
  return { x: (cos * dx + sin * dy) / k + w / 2, y: (cos * dy - sin * dx) / k + h / 2, w, h };
}
