/* The template renderer: one engine for every widget type, driven entirely by the
 * registry's data (spec 2.3). Layout is proportional, so a widget fills its tile at any
 * size and no template carries a pixel position: boxes split their rect by `dir` and
 * per-child weight, an aspect-locked child takes its size from the cross axis, and a
 * child that cannot meet its min_px is dropped so a template sheds parts as space
 * shrinks. Every attribute is a program (program.ts), including the layout ones. */

import { attrBool, attrColor, attrNum, attrText, Cells, run } from "./program.js";
import { LUCIDE } from "./lucide.js";
import { escapeXml, parseRich, richMarkup, richUnits } from "./rich.js";
import { Attrs, Json, TemplateNode } from "./types.js";

export { escapeXml } from "./rich.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* the UNKNOWN treatment: a value the backend does not have is never invented */
export const UNKNOWN_TEXT = "--";

function attr(attrs: Attrs, key: string, cells: Cells): Json {
  return attrs && attrs[key] ? run(attrs[key], cells) : null;
}

/* aspect-lock a rect and centre the result inside it */
function fitAspect(rect: Rect, aspect: number): Rect {
  if (!(aspect > 0)) return rect;
  let w = rect.w;
  let h = w / aspect;
  if (h > rect.h) {
    h = rect.h;
    w = h * aspect;
  }
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

function inset(rect: Rect, by: number): Rect {
  const d = Math.min(by, Math.min(rect.w, rect.h) / 2 - 0.5);
  return d <= 0 ? rect : { x: rect.x + d, y: rect.y + d, w: rect.w - 2 * d, h: rect.h - 2 * d };
}

function n(value: number): string {
  return value.toFixed(2);
}

/* ---- transforms (spec 2.3) ----
 *
 * Any node may carry a local transform, and everything it paints — its own drawing AND
 * its children — rides it, because it is emitted as one `<g transform>`. This is what
 * makes the hierarchy REAL rather than a naming convention: a dot on a knob's face is a
 * CHILD of the face and orbits because the face turns, not because it recomputes the
 * same angle from the same slots.
 *
 * Everything is expressed in the node's own laid-out area, so nothing here is a pixel:
 *   zoom      scales the node about its own centre (0.09 = a dot in the middle of it)
 *   dx, dy    offset it, in fractions of its own width and height
 *   rotate    degrees clockwise about the pivot, applied LAST so an offset child orbits
 *   origin_x, origin_y   the pivot, in fractions of the area (default its centre) */
function transformOf(area: Rect, attrs: Attrs, cells: Cells): string {
  if (!attrs) return "";
  const zoom = attrs.zoom ? attrNum(attr(attrs, "zoom", cells), 1) : 1;
  const dx = attrs.dx ? attrNum(attr(attrs, "dx", cells), 0) : 0;
  const dy = attrs.dy ? attrNum(attr(attrs, "dy", cells), 0) : 0;
  const rotate = attrs.rotate ? attrNum(attr(attrs, "rotate", cells), 0) : 0;
  if (zoom === 1 && !dx && !dy && !rotate) return "";
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const px = area.x + (attrs.origin_x ? attrNum(attr(attrs, "origin_x", cells), 0.5) : 0.5) * area.w;
  const py = area.y + (attrs.origin_y ? attrNum(attr(attrs, "origin_y", cells), 0.5) : 0.5) * area.h;
  const list: string[] = [];
  if (rotate) list.push(`rotate(${n(rotate)} ${n(px)} ${n(py)})`);
  if (dx || dy) list.push(`translate(${n(dx * area.w)} ${n(dy * area.h)})`);
  if (zoom !== 1)
    list.push(`translate(${n(cx)} ${n(cy)}) scale(${n(zoom)}) translate(${n(-cx)} ${n(-cy)})`);
  return list.join(" ");
}

/* ---- clipping ----
 *
 * One generic mechanism: `clipTo` opens an SVG clipPath over a rounded rect and
 * returns the tag that closes it. Any template node may declare a `clip` attr (true =
 * its own rect, a number = its rect rounded by that radius) and everything the node
 * paints stays inside it; the bar part uses the same helper so its fill is ALWAYS
 * clipped by the track's shape. Ids only need to be unique within the current
 * document, so a forever-incrementing serial is enough (each render replaces the SVG
 * wholesale). */
let clipSerial = 0;

function clipTo(rect: Rect, radius: number, out: string[]): string {
  const id = "clip" + ++clipSerial;
  const r = Math.min(Math.max(0, radius), Math.min(rect.w, rect.h) / 2);
  out.push(
    `<clipPath id="${id}"><rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.w)}" ` +
      `height="${n(rect.h)}" rx="${n(r)}"/></clipPath><g clip-path="url(#${id})">`,
  );
  return `</g>`;
}

/* ---- draw parts ---- */

function drawRect(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const fill = attrColor(attr(attrs, "fill", cells));
  const stroke = attrColor(attr(attrs, "stroke", cells));
  const strokeW = attrNum(attr(attrs, "stroke_w", cells), 0);
  const radius = Math.min(attrNum(attr(attrs, "radius", cells), 0), Math.min(rect.w, rect.h) / 2);
  if (!fill && !stroke) return;
  out.push(
    `<rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.w)}" height="${n(rect.h)}" ` +
      `rx="${n(radius)}" fill="${fill ?? "none"}"` +
      (stroke && strokeW > 0 ? ` stroke="${stroke}" stroke-width="${n(strokeW)}"` : "") +
      `/>`,
  );
}

function drawBar(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const track = attrColor(attr(attrs, "track", cells));
  const fill = attrColor(attr(attrs, "fill", cells));
  const radius = Math.min(attrNum(attr(attrs, "radius", cells), 0), Math.min(rect.w, rect.h) / 2);
  const vertical = attrText(attr(attrs, "dir", cells)) === "v";
  const raw = attr(attrs, "value", cells);
  const value = raw === null ? null : Math.max(0, Math.min(1, attrNum(raw, 0)));
  if (track)
    out.push(
      `<rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.w)}" height="${n(rect.h)}" ` +
        `rx="${n(radius)}" fill="${track}"/>`,
    );
  if (fill && value !== null && value > 0) {
    const w = vertical ? rect.w : rect.w * value;
    const h = vertical ? rect.h * value : rect.h;
    const y = vertical ? rect.y + rect.h - h : rect.y;
    /* the fill is CLIPPED BY THE TRACK, never rounded on its own: its leading edge
       stays straight, and its outer corners follow the track's shape exactly */
    const close = clipTo(rect, radius, out);
    out.push(
      `<rect x="${n(rect.x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`,
    );
    out.push(close);
  }
}

function drawText(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const raw = attr(attrs, "text", cells);
  const unknown = raw === null;
  let text = unknown ? UNKNOWN_TEXT : attrText(raw) ?? UNKNOWN_TEXT;
  /* an EXPLICIT newline breaks the line; nothing ever auto-wraps. A part marked
     `oneline` (the dropdown's value) shows the break as a space instead: a picked
     value must stay one row however it was fed. */
  if (attrBool(attr(attrs, "oneline", cells), false)) text = text.replace(/\n/g, " ");
  if (!text.length) return;
  const lines = text.split("\n");
  /* inline markup (rich.ts): a parsed line sizes by its VISIBLE units (markers cost
     nothing, an icon costs its fixed width) and renders through richMarkup */
  const rich = lines.map(parseRich);
  const unitsOf = (i: number) => (rich[i] ? richUnits(rich[i]) : lines[i].length);
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#e7ecf5";
  /* either vocabulary: start/center/end, or the shared align slot's 9 positions
     (top-left .. bottom-right), which place the line on both axes */
  const align = attrText(attr(attrs, "align", cells)) ?? "center";
  const strong = attrBool(attr(attrs, "strong", cells), false);
  /* self-fitting text: size to the box, once, generically (no per-type sizing); the
     optional `scale` attr (the text_scale slot) multiplies the fitted size, so the
     knob biases autoscaling instead of replacing it */
  const scaleRaw = attrNum(attr(attrs, "scale", cells), 1);
  const scale = scaleRaw > 0 ? scaleRaw : 1;
  const longest = lines.reduce((len, _line, i) => Math.max(len, unitsOf(i)), 1);
  const byHeight = (rect.h * 0.66) / lines.length;
  const byWidth = rect.w / (0.58 * longest);
  const size = Math.max(6, Math.min(byHeight, byWidth) * scale);
  const step = size * 1.3;
  const left = align === "start" || align.includes("left");
  const right = align === "end" || align.includes("right");
  const anchor = left ? "start" : right ? "end" : "middle";
  const x = left ? rect.x : right ? rect.x + rect.w : rect.x + rect.w / 2;
  /* the vertical anchor places the whole BLOCK of lines, then each line steps down */
  const y = align.includes("top")
    ? rect.y + size * 0.55
    : align.includes("bottom")
      ? rect.y + rect.h - size * 0.55 - step * (lines.length - 1)
      : rect.y + rect.h / 2 - (step * (lines.length - 1)) / 2;
  lines.forEach((line, i) => {
    if (!line.length) return;
    if (rich[i]) {
      out.push(richMarkup(rich[i], x, y + step * i, size, anchor, fill,
                          strong ? 650 : 450, unknown ? ` opacity="0.45"` : ""));
      return;
    }
    out.push(
      `<text x="${n(x)}" y="${n(y + step * i)}" fill="${fill}" font-size="${n(size)}" ` +
        `text-anchor="${anchor}" dominant-baseline="central" ` +
        `font-weight="${strong ? 650 : 450}"` +
        (unknown ? ` opacity="0.45"` : "") +
        `>${escapeXml(line)}</text>`,
    );
  });
}

/* ---- the radial vocabulary ----
 *
 * One angle convention for every radial part and the drag_radial primitive: DEGREES,
 * 0 = straight up, clockwise positive. A part reads `start` and `sweep` (the registry
 * wires them to the shared start_angle / sweep_angle slots) and maps value fractions
 * onto that sweep. */

export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/* The unit-circle bounding box of what a sweep actually USES: the arc from `start`
 * over `sweep` degrees (its endpoints, and every cardinal the sweep crosses), plus the
 * disc of radius `core` around the center (0 = just the center point) for a control
 * whose middle is always present whatever the sweep: a knob's face. Extent-fitted
 * parts scale and place their circle so THIS box fills the rect, so a half-circle
 * control fills its tile instead of floating in the top half of an inscribed full
 * circle. Shared with the shell, whose radial drag pivots on the same circle center. */
export function radialExtent(start: number, sweep: number, core = 0): Rect {
  const xs = [-core, core];
  const ys = [-core, core];
  const add = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    xs.push(Math.sin(rad));
    ys.push(-Math.cos(rad));
  };
  add(start);
  add(start + sweep);
  for (let a = Math.ceil(start / 90) * 90; a <= start + sweep; a += 90) add(a);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

interface RadialFrame {
  cx: number;
  cy: number;
  radius: number;      /* the circle's outer radius */
  start: number;
  sweep: number;
}

/* Where a radial part's circle sits in its rect. Default `fit` "circle" inscribes the
 * full circle, centered: right for the round-bodied types (a Knob's face, a Selector's
 * body stay physically round whatever the sweep). `fit` "extent" scales and offsets the
 * circle so the swept extent fills the rect, so a partial-sweep arc uses all its space. */
function radialFrame(rect: Rect, attrs: Attrs, cells: Cells): RadialFrame {
  const start = attrNum(attr(attrs, "start", cells), -135);
  const sweep = Math.max(1, Math.min(360, attrNum(attr(attrs, "sweep", cells), 270)));
  if (attrText(attr(attrs, "fit", cells)) === "extent") {
    const core = Math.max(0, Math.min(1, attrNum(attr(attrs, "core", cells), 0)));
    /* `flare` (degrees) widens the extent past each sweep end: the room the ends'
       tick labels take, so a shown scale never spills out of the tile */
    const flare = Math.max(0, attrNum(attr(attrs, "flare", cells), 0));
    const b = radialExtent(start - flare, Math.min(360, sweep + 2 * flare), core);
    const scale = Math.min(rect.w / b.w, rect.h / b.h);
    return {
      cx: rect.x + (rect.w - scale * b.w) / 2 - scale * b.x,
      cy: rect.y + (rect.h - scale * b.h) / 2 - scale * b.y,
      radius: scale,
      start,
      sweep,
    };
  }
  return {
    cx: rect.x + rect.w / 2,
    cy: rect.y + rect.h / 2,
    radius: Math.min(rect.w, rect.h) / 2,
    start,
    sweep,
  };
}

/* a full annulus (sweep >= 360): two circles, punched out by the even-odd rule */
function ringPath(cx: number, cy: number, ro: number, ri: number): string {
  const circle = (r: number, sweep: number) =>
    `M${n(cx)} ${n(cy - r)} A${n(r)} ${n(r)} 0 1 ${sweep} ${n(cx)} ${n(cy + r)} ` +
    `A${n(r)} ${n(r)} 0 1 ${sweep} ${n(cx)} ${n(cy - r)} `;
  return circle(ro, 1) + circle(ri, 0);
}

/* a square-ended annular sector from a0 to a1 */
function sectorPath(cx: number, cy: number, ri: number, ro: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  const p = (r: number, a: number) => polar(cx, cy, r, a).map(n).join(" ");
  return `M${p(ro, a0)} A${n(ro)} ${n(ro)} 0 ${large} 1 ${p(ro, a1)} ` +
         `L${p(ri, a1)} A${n(ri)} ${n(ri)} 0 ${large} 0 ${p(ri, a0)} Z`;
}

/* the sector with its four corners rounded by rc (clamped to the stroke and to the
 * angular room the span leaves): the arc's analog of the bar's rounded track */
function roundedSectorPath(
  cx: number, cy: number, ri: number, ro: number, a0: number, a1: number, rc: number,
): string {
  const deg = 180 / Math.PI;
  const span = a1 - a0;
  const s = Math.sin(Math.min(90, span / 2) / deg);
  rc = Math.min(rc, (ro - ri) / 2, (ri * s) / (1 - s + 1e-9), (ro * s) / (1 + s));
  if (rc < 0.25) return sectorPath(cx, cy, ri, ro, a0, a1);
  /* each fillet circle is tangent to its main arc and to the radial end edge: its
     center rides at ro-rc (outer) / ri+rc (inner), pulled in from the edge by the
     angle that leaves exactly rc of clearance */
  const phiO = deg * Math.asin(Math.min(1, rc / (ro - rc)));
  const phiI = deg * Math.asin(Math.min(1, rc / (ri + rc)));
  const dO = Math.sqrt(Math.max(0, (ro - rc) * (ro - rc) - rc * rc));
  const dI = Math.sqrt(Math.max(0, (ri + rc) * (ri + rc) - rc * rc));
  const p = (r: number, a: number) => polar(cx, cy, r, a).map(n).join(" ");
  const corner = (r: number, a: number) => `A${n(rc)} ${n(rc)} 0 0 1 ${p(r, a)} `;
  const largeO = span - 2 * phiO > 180 ? 1 : 0;
  const largeI = span - 2 * phiI > 180 ? 1 : 0;
  return `M${p(ro, a0 + phiO)} ` +
    `A${n(ro)} ${n(ro)} 0 ${largeO} 1 ${p(ro, a1 - phiO)} ` +
    corner(dO, a1) + `L${p(dI, a1)} ` + corner(ri, a1 - phiI) +
    `A${n(ri)} ${n(ri)} 0 ${largeI} 0 ${p(ri, a0 + phiI)} ` +
    corner(dI, a0) + `L${p(dO, a0)} ` + corner(ro, a0 + phiO) + `Z`;
}

/* An annular arc, drawn EXACTLY like the bar: the track is the shape (a filled sector
 * whose end rounding is the `radius` attr; absent = fully round, the classic cap), and
 * the fill is a square-ended sector over `value`'s fraction of the sweep, CLIPPED by
 * the track. So the fill's start follows the track's rounding, its leading edge stays
 * straight, and it keeps shrinking all the way to nothing (a round stroke cap would
 * bottom out as a dot). `width` is the stroke as a fraction of the radius; `outer`
 * scales the whole arc inward (fraction of the radius) without moving its center; a
 * null value fills nothing (UNKNOWN is the bare track, never an invented zero). */
function drawArc(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const f = radialFrame(rect, attrs, cells);
  const track = attrColor(attr(attrs, "track", cells));
  const fill = attrColor(attr(attrs, "fill", cells));
  const ro = f.radius * Math.max(0.05, Math.min(1, attrNum(attr(attrs, "outer", cells), 1)));
  const stroke = Math.max(1, Math.min(ro - 0.5,
    f.radius * Math.max(0.02, attrNum(attr(attrs, "width", cells), 0.18))));
  const ri = Math.max(0, ro - stroke);
  const rawRadius = attrs && attrs.radius ? attr(attrs, "radius", cells) : null;
  const rc = Math.max(0, Math.min(rawRadius === null ? stroke / 2 : attrNum(rawRadius, 0),
                                  stroke / 2));
  const whole = f.sweep >= 360;
  const a1 = f.start + Math.min(f.sweep, 360);
  const shape = whole ? ringPath(f.cx, f.cy, ro, ri)
                      : roundedSectorPath(f.cx, f.cy, ri, ro, f.start, a1, rc);
  if (track) out.push(`<path d="${shape}" fill="${track}" fill-rule="evenodd"/>`);
  const raw = attr(attrs, "value", cells);
  const value = raw === null ? null : Math.max(0, Math.min(1, attrNum(raw, 0)));
  if (fill && value !== null && value > 0) {
    const id = "clip" + ++clipSerial;
    out.push(`<clipPath id="${id}"><path d="${shape}" clip-rule="evenodd"/></clipPath>` +
             `<g clip-path="url(#${id})">`);
    const filled = whole && value >= 1
      ? ringPath(f.cx, f.cy, ro, ri)
      : sectorPath(f.cx, f.cy, ri, ro, f.start,
                   f.start + Math.min(f.sweep, 359.9) * value);
    out.push(`<path d="${filled}" fill="${fill}" fill-rule="evenodd"/></g>`);
  }
}

/* a clockwise circle subpath (matches the capsule's winding, so a nonzero fill takes
 * the union of the two, never punches a hole) */
function circleSub(cx: number, cy: number, r: number): string {
  return `M${n(cx)} ${n(cy - r)} A${n(r)} ${n(r)} 0 1 1 ${n(cx)} ${n(cy + r)} ` +
         `A${n(r)} ${n(r)} 0 1 1 ${n(cx)} ${n(cy - r)} Z`;
}

/* the round-capped needle body as a filled clockwise capsule from p0 to p1 */
function capsuleSub(x0: number, y0: number, x1: number, y1: number, half: number): string {
  const len = Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0));
  const qx = ((y1 - y0) / len) * half;
  const qy = (-(x1 - x0) / len) * half;
  return `M${n(x0 + qx)} ${n(y0 + qy)} L${n(x1 + qx)} ${n(y1 + qy)} ` +
         `A${n(half)} ${n(half)} 0 0 1 ${n(x1 - qx)} ${n(y1 - qy)} ` +
         `L${n(x0 - qx)} ${n(y0 - qy)} ` +
         `A${n(half)} ${n(half)} 0 0 1 ${n(x0 + qx)} ${n(y0 + qy)} Z`;
}

/* a pointer from `inner` to `outer` (radius fractions of the node's own inscribed
 * circle), ALWAYS STRAIGHT UP: the container (`dial`) owns the fit and this part's own
 * `rotate` attr (spec 2.3) turns it to the value's angle, so the needle itself carries
 * no value-to-angle maths at all — the same rotate the face and its dot ride. `value`
 * still rides the attrs, read only to GATE the pointer (UNKNOWN draws the hub alone):
 * `rotate` degrades to 0 rather than vanishing when its expression goes Nil, so the
 * angle attr alone cannot tell an unknown value from a known one pointing at the top.
 * The hub and the needle body are ONE filled path, so a translucent handle color reads
 * as one object instead of darkening where the two pieces overlap. */
function drawNeedle(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const f = radialFrame(rect, attrs, cells);
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#ececec";
  const hub = f.radius * attrNum(attr(attrs, "hub", cells), 0);
  const parts: string[] = [];
  if (hub > 0) parts.push(circleSub(f.cx, f.cy, hub));
  if (attr(attrs, "value", cells) !== null) {
    const inner = f.radius * attrNum(attr(attrs, "inner", cells), 0);
    const outer = f.radius * attrNum(attr(attrs, "outer", cells), 0.78);
    const half = Math.max(0.5, (f.radius * attrNum(attr(attrs, "width", cells), 0.06)) / 2);
    /* straight up: angle 0 in the polar convention (0 = up, spec 2.3) */
    const [x0, y0] = polar(f.cx, f.cy, inner, 0);
    const [x1, y1] = polar(f.cx, f.cy, outer, 0);
    parts.push(capsuleSub(x0, y0, x1, y1, half));
  }
  if (parts.length) out.push(`<path d="${parts.join(" ")}" fill="${fill}"/>`);
}

/* a deterministic palette for multi-series plots: series 0 wears the fill color, later
 * ones rotate its hue so any series count stays distinguishable with one authored color */
function rotateHue(hex: string, index: number): string {
  if (!index || !/^#[0-9a-fA-F]{6,8}$/.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  h = (h + index * 67) % 360;
  const c = v * s, x2 = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [rr, gg, bb] =
    h < 60 ? [c, x2, 0] : h < 120 ? [x2, c, 0] : h < 180 ? [0, c, x2]
    : h < 240 ? [0, x2, c] : h < 300 ? [x2, 0, c] : [c, 0, x2];
  const to = (v2: number) => Math.round((v2 + m) * 255).toString(16).padStart(2, "0");
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}

/* Display-tier SMOOTHING over the history ring, recomputed per render so it holds no
 * state and needs no wire change: an optional 1D constant-velocity Kalman filter (the
 * `kalman` knob 0..1 sets how much the model outweighs the measurements, 0 = off)
 * followed by an exponential moving average (the `smoothing` knob 0..1 is its weight,
 * 0 = off). The two compose: Kalman rejects measurement noise with little lag,
 * the EMA adds plain temporal smoothing on top. A null sample resets both and still
 * breaks the line: a gap is a gap, never bridged by a filter's memory. */
interface SmoothState {
  started: boolean;
  x: number; v: number;
  p00: number; p01: number; p10: number; p11: number;
  ema: number;
}

function freshSmooth(): SmoothState {
  return { started: false, x: 0, v: 0, p00: 1, p01: 0, p10: 0, p11: 1, ema: 0 };
}

/* one sample through the filter pair; mutates the per-series state */
function smoothStep(
  st: SmoothState, z: number | null, kalman: number, smoothing: number,
): number | null {
  if (typeof z !== "number" || !isFinite(z)) {
    st.started = false; /* a gap resets both filters: never bridged by their memory */
    return null;
  }
  if (!st.started) {
    st.started = true;
    st.x = z; st.v = 0; st.p00 = 1; st.p01 = 0; st.p10 = 0; st.p11 = 1; st.ema = z;
    return z; /* the first sample of a run passes through unchanged */
  }
  let filtered = z;
  if (kalman > 0) {
    /* r fixed at 1, q from the knob: small q trusts the model, large q the data */
    const q = Math.pow(10, 1 - 5 * kalman);
    /* predict (constant velocity, dt = 1 sample) ... */
    st.x += st.v;
    const a00 = st.p00 + st.p10 + st.p01 + st.p11 + q / 4;
    const a01 = st.p01 + st.p11 + q / 2;
    const a10 = st.p10 + st.p11 + q / 2;
    const a11 = st.p11 + q;
    /* ... then update against the measurement */
    const gain = a00 + 1;
    const k0 = a00 / gain, k1 = a10 / gain;
    const resid = z - st.x;
    st.x += k0 * resid;
    st.v += k1 * resid;
    st.p00 = (1 - k0) * a00; st.p01 = (1 - k0) * a01;
    st.p10 = a10 - k1 * a00; st.p11 = a11 - k1 * a01;
    filtered = st.x;
  }
  st.ema += (1 - smoothing) * (filtered - st.ema);
  return smoothing > 0 ? st.ema : filtered;
}

export function smoothSamples(
  samples: (number | null)[][],
  series: number,
  kalman: number,
  smoothing: number,
): (number | null)[][] {
  const states: SmoothState[] = [];
  for (let s = 0; s < series; ++s) states.push(freshSmooth());
  return samples.map((row) => row.map((z, s) => smoothStep(states[s], z, kalman, smoothing)));
}

/* The filters are CAUSAL, seeded at the first sample they see: refiltered from
 * scratch each render, the seed would be whatever sample currently rides the
 * window's edge, and the whole left side would re-shape as the ring scrolls. So the
 * filter state PERSISTS on the history view and only ever ADVANCES, over newly
 * arrived samples; history scrolling off the end no longer affects anything drawn.
 * A knob change or a replaced ring refilters once, from the oldest sample held. */
interface SmoothCache {
  k: number;
  s: number;
  total: number; /* absolute sample count consumed (HistView.total) */
  states: SmoothState[];
  rows: (number | null)[][];
}

function smoothedView(
  view: { series: number; cap: number; samples: (number | null)[][] },
  kalman: number,
  smoothing: number,
): (number | null)[][] {
  const holder = view as unknown as { __smooth?: SmoothCache; total?: number };
  const total = Number(holder.total ?? view.samples.length);
  let c = holder.__smooth;
  const fresh = () => {
    const states: SmoothState[] = [];
    for (let s = 0; s < view.series; ++s) states.push(freshSmooth());
    return { k: kalman, s: smoothing, total: 0, states, rows: [] as (number | null)[][] };
  };
  const grown = c ? total - c.total : 0;
  if (!c || c.k !== kalman || c.s !== smoothing || c.states.length !== view.series ||
      grown < 0 || grown > view.samples.length) {
    c = fresh();
    holder.__smooth = c;
    c.rows = view.samples.map((row) =>
      row.map((z, s) => smoothStep(c!.states[s], z, kalman, smoothing)));
  } else {
    for (const row of view.samples.slice(view.samples.length - grown))
      c.rows.push(row.map((z, s) => smoothStep(c!.states[s], z, kalman, smoothing)));
    if (c.rows.length > view.samples.length)
      c.rows.splice(0, c.rows.length - view.samples.length);
  }
  c.total = total;
  return c.rows.length === view.samples.length ? c.rows : view.samples;
}

/* the TREND plot: polylines over the history view riding the `values` attr (a HistView:
 * rate/series/cap/samples, built by the shell from the wire's deltas). Newest at the
 * right edge; a ring that is not yet full starts partway in; a null sample breaks the
 * line (unknown is a gap, not a zero). Text: the hi/lo scale markers only. Smoothing
 * (and the autoscale over it) runs on the drawn copy; the ring keeps the truth. */
function drawPlot(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const raw = attr(attrs, "values", cells) as Json;
  let view = raw && typeof raw === "object" && Array.isArray((raw as Json).samples)
    ? (raw as { series: number; cap: number; samples: (number | null)[][] })
    : null;
  const kalman = Math.max(0, Math.min(1, attrNum(attr(attrs, "kalman", cells), 0)));
  const smoothing = Math.max(0, Math.min(0.98, attrNum(attr(attrs, "smoothing", cells), 0)));
  if (view && (kalman > 0 || smoothing > 0))
    view = { ...view, samples: smoothedView(view, kalman, smoothing) };
  const track = attrColor(attr(attrs, "track", cells));
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#4e8ef7";
  const labels = attrBool(attr(attrs, "labels", cells), true);
  const textFill = attrColor(attr(attrs, "text_fill", cells)) ?? "#8a8a8a";
  const decimals = Math.max(0, Math.min(6, attrNum(attr(attrs, "decimals", cells), 0)));

  /* the range: authored, or autoscaled over what is on screen (padded a tenth) */
  let lo = attrNum(attr(attrs, "min", cells), 0);
  let hi = attrNum(attr(attrs, "max", cells), 1);
  if (attrBool(attr(attrs, "autoscale", cells), false) && view) {
    let dataLo = Infinity, dataHi = -Infinity;
    for (const sample of view.samples)
      for (const v of sample)
        if (typeof v === "number" && isFinite(v)) {
          if (v < dataLo) dataLo = v;
          if (v > dataHi) dataHi = v;
        }
    if (dataLo <= dataHi) {
      const pad = (dataHi - dataLo) * 0.1 || Math.abs(dataHi) * 0.1 || 1;
      lo = dataLo - pad;
      hi = dataHi + pad;
    }
  }
  if (!(hi > lo)) hi = lo + 1;

  /* the grid: top, middle and bottom rules in the track color */
  if (track)
    for (const at of [0, 0.5, 1])
      out.push(`<path d="M${n(rect.x)} ${n(rect.y + rect.h * at)} h${n(rect.w)}" ` +
               `stroke="${track}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);

  if (view && view.samples.length > 1) {
    const cap = Math.max(2, view.cap);
    const xFor = (i: number) =>
      rect.x + (rect.w * (cap - view.samples.length + i)) / (cap - 1);
    const yFor = (v: number) =>
      rect.y + rect.h * (1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
    for (let s = 0; s < view.series; ++s) {
      const color = rotateHue(fill, s);
      let run: string[] = [];
      const flush = () => {
        if (run.length > 1)
          out.push(`<polyline points="${run.join(" ")}" fill="none" stroke="${color}" ` +
                   `stroke-width="1.4" vector-effect="non-scaling-stroke" ` +
                   `stroke-linejoin="round"/>`);
        run = [];
      };
      for (let i = 0; i < view.samples.length; ++i) {
        const v = view.samples[i][s];
        if (typeof v === "number" && isFinite(v)) run.push(`${n(xFor(i))},${n(yFor(v))}`);
        else flush();
      }
      flush();
    }
  }

  if (labels) {
    const size = Math.max(5, Math.min(rect.h * 0.14, rect.w * 0.08));
    const mark = (value: number, y: number, base: string) =>
      out.push(`<text x="${n(rect.x + size * 0.3)}" y="${n(y)}" fill="${textFill}" ` +
               `font-size="${n(size)}" text-anchor="start" dominant-baseline="${base}">` +
               `${escapeXml(value.toFixed(decimals))}</text>`);
    mark(hi, rect.y + size * 0.2, "hanging");
    mark(lo, rect.y + rect.h - size * 0.2, "auto");
  }
}

function drawIcon(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const name = attrText(attr(attrs, "name", cells)) ?? "";
  const markup = LUCIDE[name];
  if (!markup) return;
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#8b95a7";
  const box = fitAspect(rect, 1);
  const scale = box.w / 24;
  out.push(
    `<g transform="translate(${n(box.x)} ${n(box.y)}) scale(${n(scale)})" ` +
      `fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" ` +
      `stroke-linejoin="round">${markup}</g>`,
  );
}

/* An AUTHORED shape: `d` is raw SVG path data in a UNIT BOX, x and y running 0..1
 * across the node's own area, so a shape is composed with ordinary SVG path syntax
 * rather than a bespoke geometry language. The data is NEVER parsed — emitting it
 * inside a group scaled by the area's own width and height is what makes the unit
 * coordinates map onto the area for free, at zero per-vertex cost.
 *
 * That scale is generally NON-UNIFORM (the area's width and height differ), so a
 * stroke drawn at a uniform unit width skews: thicker along whichever axis the area is
 * narrower on. `stroke_w` is deliberately in the SAME unit terms as `d` rather than a
 * fixed size, so it scales WITH that distortion instead of fighting it; a square
 * `aspect` on the part is the fix for anyone who wants an undistorted stroke.
 * `vector-effect="non-scaling-stroke"` would remove exactly the scaling this part is
 * for — it pins a stroke to a constant SCREEN size regardless of the element's own
 * transform, which is the opposite of "stroke_w is unit terms so it scales with the
 * part" and would silently defeat the aspect-lock fix above, so it is not used here
 * (contrast the plot's grid lines, which use it to stay a constant 1px against the
 * CANVAS's outer zoom, a transform this part's own scale is not part of). Like `rect`,
 * a path with neither fill nor stroke draws nothing. */
function drawPath(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const d = attrText(attr(attrs, "d", cells));
  if (!d) return;
  const fill = attrColor(attr(attrs, "fill", cells));
  const stroke = attrColor(attr(attrs, "stroke", cells));
  const strokeW = attrNum(attr(attrs, "stroke_w", cells), 0);
  if (!fill && !stroke) return;
  out.push(
    `<g transform="translate(${n(rect.x)} ${n(rect.y)}) scale(${n(rect.w)} ${n(rect.h)})">` +
      `<path d="${escapeXml(d)}" fill="${fill ?? "none"}"` +
      (stroke && strokeW > 0 ? ` stroke="${stroke}" stroke-width="${n(strokeW)}"` : "") +
      `/></g>`,
  );
}

/* ---- code: a draw part whose body is user-authored JavaScript (spec 2.3) ----
 *
 * The escape hatch for generative drawing — the case that made it necessary is the tick
 * scale, whose real work is measuring label text and deciding which labels to drop, which
 * no amount of declarative geometry expresses. The user's own call: a drawing API would
 * be good, but every `draw.*` helper should RETURN an svg string rather than push into a
 * hidden buffer, so the body can build with helpers, concatenate its own markup, or return
 * a pasted static SVG — three styles, one mechanism.
 *
 * The body is compiled ONCE PER DISTINCT SOURCE TEXT with `new Function`, and cached (a
 * re-served registry with unchanged source must not recompile: `codeCache` below keys on
 * the source string itself, which survives a fresh registry object across reconnects). It
 * runs once per render of the part, and once PER COPY under `repeat` (the generic repeat
 * machinery above already calls this path once per copy, with that copy's own cells, so
 * nothing here needs to know repeat exists beyond reading `view.repeat` off them).
 *
 * WHAT THIS CANNOT CONTAIN: `new Function` runs synchronously on the view's own thread,
 * and nothing short of killing the tab preempts an infinite loop in a body — the
 * mitigation is that this code is authored by the HMI designer, and a hang shows up
 * immediately in Edit/Test, not in a shipped document nobody is watching run. A future CSP
 * on this app needs `unsafe-eval` (or an equivalent trusted-types carve-out) for this
 * feature to keep working; there is no way to compile arbitrary author-supplied source
 * under a stricter policy. */

/* one compiled body per distinct source string; a failed compile caches its Error too, so
   a body that never parses is not retried every render of every copy */
const codeCache = new Map<string, Function | Error>();

function compiledBody(source: string): Function | Error {
  const held = codeCache.get(source);
  if (held !== undefined) return held;
  let compiled: Function | Error;
  try {
    /* eslint-disable-next-line no-new-func -- the whole point: user-authored drawing code */
    compiled = new Function("props", "area", "draw", "view", source);
  } catch (err) {
    compiled = err instanceof Error ? err : new Error(String(err));
  }
  codeCache.set(source, compiled);
  return compiled;
}

/* draw.rect: the same shape drawRect paints, from plain values instead of attrs+cells */
function codeRect(opts: Json): string {
  const o = (opts ?? {}) as Json;
  const fill = typeof o.fill === "string" ? o.fill : null;
  const stroke = typeof o.stroke === "string" ? o.stroke : null;
  const strokeW = Number(o.stroke_w) || 0;
  if (!fill && !stroke) return "";
  const w = Number(o.w) || 0;
  const h = Number(o.h) || 0;
  const radius = Math.min(Math.max(0, Number(o.radius) || 0), Math.min(w, h) / 2);
  return `<rect x="${n(Number(o.x) || 0)}" y="${n(Number(o.y) || 0)}" width="${n(w)}" ` +
    `height="${n(h)}" rx="${n(radius)}" fill="${fill ?? "none"}"` +
    (stroke && strokeW > 0 ? ` stroke="${stroke}" stroke-width="${n(strokeW)}"` : "") + `/>`;
}

/* draw.path: `d` is already in ARTBOARD UNITS (unlike the `path` KIND's unit box, spec
   2.3), so it is emitted as-is with no scaling transform */
function codePath(d: unknown, opts: Json): string {
  const o = (opts ?? {}) as Json;
  const fill = typeof o.fill === "string" ? o.fill : null;
  const stroke = typeof o.stroke === "string" ? o.stroke : null;
  const strokeW = Number(o.stroke_w) || 0;
  if (!fill && !stroke) return "";
  return `<path d="${escapeXml(String(d ?? ""))}" fill="${fill ?? "none"}"` +
    (stroke && strokeW > 0 ? ` stroke="${stroke}" stroke-width="${n(strokeW)}"` : "") + `/>`;
}

function codeLine(x0: number, y0: number, x1: number, y1: number, opts: Json): string {
  const o = (opts ?? {}) as Json;
  const stroke = typeof o.stroke === "string" ? o.stroke : null;
  if (!stroke) return "";
  const strokeW = Number(o.stroke_w) || 1;
  const cap = typeof o.cap === "string" ? o.cap : "round";
  return `<path d="M${n(Number(x0) || 0)} ${n(Number(y0) || 0)} L${n(Number(x1) || 0)} ` +
    `${n(Number(y1) || 0)}" stroke="${stroke}" stroke-width="${n(strokeW)}" ` +
    `stroke-linecap="${cap}" fill="none"/>`;
}

function codeCircle(cx: number, cy: number, r: number, opts: Json): string {
  const o = (opts ?? {}) as Json;
  const fill = typeof o.fill === "string" ? o.fill : null;
  const stroke = typeof o.stroke === "string" ? o.stroke : null;
  const strokeW = Number(o.stroke_w) || 0;
  if (!fill && !stroke) return "";
  return `<circle cx="${n(Number(cx) || 0)}" cy="${n(Number(cy) || 0)}" r="${n(Number(r) || 0)}" ` +
    `fill="${fill ?? "none"}"` +
    (stroke && strokeW > 0 ? ` stroke="${stroke}" stroke-width="${n(strokeW)}"` : "") + `/>`;
}

/* draw.text: routed through the SAME rich-text path the `text` part uses (parseRich /
   richMarkup), so inline markup and escaping behave identically and nothing here ever
   emits a string unescaped. Unlike the `text` part it is not self-fitting: `size` is
   explicit, `x`/`y` a point rather than a box, and `align` is a horizontal anchor only. */
function codeText(text: unknown, opts: Json): string {
  const o = (opts ?? {}) as Json;
  const str = text === null || text === undefined ? "" : String(text);
  if (!str.length) return "";
  const size = Number(o.size) > 0 ? Number(o.size) : 12;
  const fill = typeof o.fill === "string" ? o.fill : "#e7ecf5";
  const align = typeof o.align === "string" ? o.align : "center";
  const anchor = align === "start" || align === "left" ? "start"
               : align === "end" || align === "right" ? "end" : "middle";
  const strong = Boolean(o.strong);
  const x = Number(o.x) || 0;
  const y = Number(o.y) || 0;
  const step = size * 1.3;
  const out: string[] = [];
  str.split("\n").forEach((line, i) => {
    if (!line.length) return;
    const ly = y + step * i;
    const rich = parseRich(line);
    if (rich) out.push(richMarkup(rich, x, ly, size, anchor, fill, strong ? 650 : 450));
    else
      out.push(
        `<text x="${n(x)}" y="${n(ly)}" fill="${fill}" font-size="${n(size)}" ` +
          `text-anchor="${anchor}" dominant-baseline="central" ` +
          `font-weight="${strong ? 650 : 450}">${escapeXml(line)}</text>`,
      );
  });
  return out.join("");
}

/* draw.icon: the same Lucide set drawIcon uses, at an explicit point + size rather than a
   fitted box */
function codeIcon(name: unknown, opts: Json): string {
  const o = (opts ?? {}) as Json;
  const markup = LUCIDE[String(name ?? "")];
  if (!markup) return "";
  const size = Number(o.size) > 0 ? Number(o.size) : 24;
  const fill = typeof o.fill === "string" ? o.fill : "#8b95a7";
  const strokeW = Number(o.stroke_w) > 0 ? Number(o.stroke_w) : 2;
  const scale = size / 24;
  return `<g transform="translate(${n(Number(o.x) || 0)} ${n(Number(o.y) || 0)}) ` +
    `scale(${n(scale)})" fill="none" stroke="${fill}" stroke-width="${n(strokeW)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${markup}</g>`;
}

/* draw.measure: THE POINT OF THE WHOLE FEATURE. The width the renderer would give a
   string at a size, using the exact estimator drawText/richUnits use (0.58 x size per
   average-char unit) — a declarative scale cannot measure its own labels; code can. */
function codeMeasure(text: unknown, size: unknown): number {
  const str = text === null || text === undefined ? "" : String(text);
  if (!str.length) return 0;
  const sz = Number(size) || 0;
  let longest = 0;
  for (const line of str.split("\n")) {
    const rich = parseRich(line);
    const units = rich ? richUnits(rich) : line.length;
    if (units > longest) longest = units;
  }
  return 0.58 * sz * longest;
}

/* draw.svg: fits pasted markup into the part's area. A whole `<svg>` with a `viewBox` maps
   that box onto `area`, preserving aspect and centering unless `opts.stretch`; anything
   else (a bare fragment, or an `<svg>` with no viewBox to map) is treated as already being
   in the area's own local space (0,0 at the area's own corner) and simply translated
   there. This is the "paste a static SVG" path the user asked for directly. */
function codeSvg(markup: unknown, area: Rect, opts: Json): string {
  const src = String(markup ?? "").trim();
  if (!src) return "";
  const outer = /^<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i.exec(src);
  if (!outer) return `<g transform="translate(${n(area.x)} ${n(area.y)})">${src}</g>`;
  const inner = outer[2];
  const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(outer[1]);
  const nums = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : null;
  if (!nums || nums.length !== 4 || nums.some((v) => !Number.isFinite(v)))
    return `<g transform="translate(${n(area.x)} ${n(area.y)})">${inner}</g>`;
  const [vx, vy, vw, vh] = nums;
  if (!(vw > 0) || !(vh > 0)) return "";
  let sx = area.w / vw;
  let sy = area.h / vh;
  let ox = area.x;
  let oy = area.y;
  if (!(opts ?? {}).stretch) {
    const s = Math.min(sx, sy);
    sx = sy = s;
    ox = area.x + (area.w - vw * s) / 2;
    oy = area.y + (area.h - vh * s) / 2;
  }
  return `<g transform="translate(${n(ox)} ${n(oy)}) scale(${n(sx)} ${n(sy)}) ` +
    `translate(${n(-vx)} ${n(-vy)})">${inner}</g>`;
}

/* A throwing part draws NOTHING and never takes the rest of the render with it: both the
 * compile (cached above) and the call are wrapped, and either failure reports through
 * `fault` (named by the part, so a broken body is visible exactly like a compile finding
 * — canvas.ts turns this into the widget's fault badge) rather than vanishing. */
function drawCode(
  node: TemplateNode,
  area: Rect,
  cells: Cells,
  out: string[],
  fault?: (part: string, err: unknown) => void,
): void {
  const source = (node as Json).code;
  if (!source) return;
  const name = String((node as Json).name || "?");
  const compiled = compiledBody(source);
  if (compiled instanceof Error) {
    fault?.(name, compiled);
    return;
  }
  try {
    /* `props` by BARE NAME: the served `scope` map (spec 2.3) is {name: slot address},
       resolved through the same cells every other attr reads through */
    const scopeMap = (node as Json).scope as Record<string, string> | undefined;
    const props: Json = {};
    if (scopeMap) for (const key of Object.keys(scopeMap)) props[key] = cells("slot:" + scopeMap[key]);
    /* `view.attrs`: this part's OWN attrs (spec 2.3), by name, resolved through the same
       cells every other draw part's attrs read through — the registry's COMPUTED inputs
       for this part (an outside scale's `outer`, a radial's `start`/`sweep`, ...), never
       merged into `props` because a prop and an attr may share a name. The generic
       layout attrs (`show`, `weight`, `zoom`, ...) land here too where a part happens to
       carry them; harmless, since nothing here is obligated to read them. */
    const nodeAttrs = ((node as Json).attrs ?? {}) as Attrs;
    const attrsOut: Json = {};
    for (const key of Object.keys(nodeAttrs)) attrsOut[key] = attr(nodeAttrs, key, cells);
    const view: Json = {
      tile: { w: cells("tile:w"), h: cells("tile:h"), aspect: cells("tile:aspect") },
      state: {
        pressed: Boolean(cells("state:pressed")), dragging: Boolean(cells("state:dragging")),
        open: Boolean(cells("state:open")), hover: Boolean(cells("state:hover")),
      },
      /* a part with no repeat gets the same shape a repeated one would, at copy 0 of 1
         (spec 2.3): the cells fall through to null off-repeat, so the defaults land here */
      repeat: {
        index: cells("repeat:index") ?? 0, count: cells("repeat:count") ?? 1,
        fraction: cells("repeat:fraction") ?? 0,
      },
      attrs: attrsOut,
      theme: (token: string) => cells("theme:" + token),
    };
    const draw = {
      rect: codeRect, path: codePath, line: codeLine, circle: codeCircle,
      text: codeText, icon: codeIcon, measure: codeMeasure,
      svg: (markup: unknown, opts?: Json) => codeSvg(markup, area, opts ?? {}),
      polar,
    };
    const result = compiled(props, area, draw, view);
    if (typeof result === "string") {
      if (result) out.push(result);
    } else if (Array.isArray(result)) {
      out.push(result.filter((s) => typeof s === "string").join(""));
    }
  } catch (err) {
    fault?.(name, err);
  }
}

/* ---- repeat: a node renders N times (spec 2.3) ----
 *
 * A node carrying a `repeat` attr (an expression resolving to a count) renders that
 * many copies instead of one. This is what turns "twelve tick marks around a dial" or
 * "eight segments in a bar" from generator code — the nine hard-coded draw kinds used
 * to own exactly this — into ordinary authored parts: the count and the placement are
 * both data, and nothing here knows what a tick or a segment IS.
 *
 * `repeat` is evaluated ONCE, against the cells the node was HANDED — never per copy,
 * since the count decides how many copies exist before there is a "per copy" to speak
 * of, and evaluating it once is what lets a NESTED repeat's own count read the outer
 * copy's index. The result is clamped to a defensive ceiling: the expression is
 * arbitrary authored text, and nothing else stands between a mistake ("count * count")
 * and a render that hangs building hundreds of thousands of SVG nodes, so 512 is a
 * hard cap chosen to be generous for any real dial or bar, not a design number. */
const REPEAT_CAP = 512;

function repeatCountOf(attrs: Attrs, cells: Cells): number {
  return Math.max(0, Math.min(REPEAT_CAP, Math.round(attrNum(attr(attrs, "repeat", cells), 0))));
}

/* The per-copy cell overlay: `repeat:index` / `repeat:count` / `repeat:fraction`
 * answer for this one copy, and every other cell falls through to the ENCLOSING
 * scope's cells unchanged — which is how the repeated node's own attrs (its transform
 * above all: that is how copies are PLACED) and everything under it end up seeing
 * these three cells beside whatever else was already in scope. Nesting composes for
 * free: a repeat inside a repeat wraps the outer overlay as its own fallback, so its
 * three cells SHADOW the outer one's for its own subtree (an inner tick reads its own
 * index, not its ring's) while anything else that subtree reads still resolves outward
 * exactly as it did before repeat existed. */
function repeatCells(base: Cells, index: number, count: number): Cells {
  const fraction = count > 1 ? index / (count - 1) : 0;
  return (cell: string): Json => {
    switch (cell) {
      case "repeat:index": return index;
      case "repeat:count": return count;
      case "repeat:fraction": return fraction;
      default: return base(cell);
    }
  };
}

/* N copies of a repeated node share ONE part path (spec 2.3: a name addresses the
 * template NODE, not one rendering of it), so its rect is recorded exactly once — the
 * plain rect it was HANDED, before its own aspect/pad/fit sizing and above all before
 * any PER-COPY transform, since the whole point of a repeat is that the transform
 * differs by copy and so no single copy's placement is "the" one. Recording per-copy
 * instead would leave the editor's selection ring on whichever copy happened to render
 * last; this is what lets it ring where the repetition LIVES instead. */
function recordRepeatRect(node: TemplateNode, rect: Rect, parts: PartHits | undefined): void {
  if (!parts || parts.depth === 0) return;
  const name = (node as Json).name;
  if (typeof name !== "string" || !name.length) return;
  const path = parts.path ? parts.path + "." + name : name;
  parts.rects.set(path, parts.transform ? { ...rect, transform: parts.transform } : { ...rect });
}

interface RepeatEntry {
  node: TemplateNode;
  cells: Cells;
  repeated: boolean; /* one copy of a repeat: its part rect is already recorded */
}

/* One template child becomes one entry, or — where it carries `repeat` — N of them,
 * each overlaid with that copy's own cells. This is the ONE place repeat expansion
 * happens, shared by a box's stack children, a box's row/col children (the layout pass
 * below then treats the N entries as ordinary siblings, which is how a segmented bar
 * or a strip of lamps gets laid out side by side) and a draw part's own children —
 * repeat works EVERYWHERE, not only in a stack. `show` is evaluated per COPY, against
 * that copy's own cells, exactly like `weight` and `aspect` further down: a copy the
 * expression hides is dropped here, before it ever reaches a layout slot or a render
 * call, same as an ordinary hidden child. */
function expandRepeats(
  children: TemplateNode[],
  area: Rect,
  cells: Cells,
  parts: PartHits | undefined,
): RepeatEntry[] {
  const out: RepeatEntry[] = [];
  for (const child of children) {
    const attrs: Attrs = (child as Json).attrs ?? {};
    const isShown = (c: Cells) => !attrs.show || attrBool(attr(attrs, "show", c), false);
    if (attrs.repeat) {
      const count = repeatCountOf(attrs, cells);
      recordRepeatRect(child, area, parts);
      for (let i = 0; i < count; ++i) {
        const copyCells = repeatCells(cells, i, count);
        if (isShown(copyCells)) out.push({ node: child, cells: copyCells, repeated: true });
      }
    } else if (isShown(cells)) {
      out.push({ node: child, cells, repeated: false });
    }
  }
  return out;
}

/* ---- layout ---- */

interface Child {
  node: TemplateNode;
  cells: Cells;
  repeated: boolean;
  weight: number;
  minPx: number;
  aspect: number;
  main: number;
}

/* Counts off the template's interact-carrying nodes in render order, so the DOM group a
 * pointer event lands in names its interact by ordinal (shell.ts interactions() walks
 * the same preorder). Consumed before the visibility check so a hidden interact keeps
 * later ordinals stable; the one drift case, an interact nested under a hidden box that
 * precedes another interact, exists in no type. */
export interface ActCounter {
  next: number;
}

/* Collects where each NAMED node landed, keyed by its part path (the names joined with
 * "." BELOW the template root, spec 2.3 — the root part is the widget itself and adds
 * no segment, which is why a widget-level property addresses bare), in the same
 * artboard units the renderer works in. `path` is the walk's own prefix threading, "" at
 * the root, like the
 * counter in ActCounter. A node hidden by `show` records nothing: it did not render.
 * When a collector rides along, every named node that renders is also wrapped in
 * `<g data-part="<path>">` (INSIDE any data-act group it carries), so the DOM knows
 * the same addresses; without one the output is exactly what it always was. */
/* where a part landed: its area in the parent's coordinates, plus the accumulated
   transform that carries it (its own and every ancestor's), so an overlay can ring a
   rotated part where it actually is */
export interface PartRect extends Rect {
  transform?: string;
}

export interface PartHits {
  rects: Map<string, PartRect>;
  path: string;
  depth: number; /* 0 at the template root, whose name is not part of any address */
  transform: string; /* the enclosing transform chain, "" at the root */
}

export function renderNode(
  node: TemplateNode,
  rect: Rect,
  cells: Cells,
  out: string[],
  acts?: ActCounter,
  parts?: PartHits,
  /* a `code` part's compile/call failure is reported here, named by the part (spec 2.3:
     "A throwing part draws NOTHING"); absent, a failure is simply swallowed (used where
     no caller wants to collect it) */
  fault?: (part: string, err: unknown) => void,
): void {
  if (!node) return;
  const attrs = (node as Json).attrs ?? {};
  if (attrs.repeat) {
    const count = repeatCountOf(attrs, cells);
    recordRepeatRect(node, rect, parts);
    for (let i = 0; i < count; ++i)
      renderOnce(node, rect, repeatCells(cells, i, count), out, acts, parts, true, fault);
    return;
  }
  renderOnce(node, rect, cells, out, acts, parts, false, fault);
}

/* One instance: a plain node, or one copy of a repeated one. `repeated` changes
 * exactly one thing here — whether this call may record the node's part rect
 * (renderBody): a repeat's is recorded once, up front, by whichever caller expanded it
 * (renderNode above, or expandRepeats for a box's or a draw part's children), never
 * per copy. Everything else — the node's own attrs, and everything under it — already
 * sees the per-copy cells the caller handed in, exactly like a plain node's. */
function renderOnce(
  node: TemplateNode,
  rect: Rect,
  cells: Cells,
  out: string[],
  acts: ActCounter | undefined,
  parts: PartHits | undefined,
  repeated: boolean,
  fault?: (part: string, err: unknown) => void,
): void {
  const act = (node as Json).interact && acts ? acts.next++ : -1;
  const attrs = (node as Json).attrs ?? {};
  if (attrs.show && !attrBool(attr(attrs, "show", cells), false)) return;

  const name = parts ? (node as Json).name : undefined;
  /* the ROOT node adds no segment: it is the widget, whose own address is "" */
  const path = typeof name === "string" && name.length && parts!.depth > 0
    ? (parts!.path ? parts!.path + "." + name : name)
    : "";

  /* the browser's own SVG hit test resolves gestures: everything this node PAINTS is
     the interactive element, whatever its shape, so the group carries the ordinal */
  if (act >= 0) out.push(`<g data-act="${act}">`);
  const above = parts ? parts.path : "";
  if (parts) parts.depth++;
  if (path) {
    out.push(`<g data-part="${path}">`);
    parts!.path = path;
    renderBody(node, rect, attrs, cells, out, acts, parts, path, repeated, fault);
    out.push(`</g>`);
  } else {
    renderBody(node, rect, attrs, cells, out, acts, parts, "", repeated, fault);
  }
  if (parts) {
    parts.path = above;
    parts.depth--;
  }
  if (act >= 0) out.push(`</g>`);
}

function renderBody(
  node: TemplateNode,
  rect: Rect,
  attrs: Attrs,
  cells: Cells,
  out: string[],
  acts?: ActCounter,
  parts?: PartHits,
  path = "",
  repeated = false,
  fault?: (part: string, err: unknown) => void,
): void {
  let area = rect;
  /* a node with `at: "center"` OR that carries a radial `fit` pins its area to the
     FITTED CIRCLE's bounding square, before aspect/pad apply. `fit` is the CONTAINER's
     job (spec 2.3): a box or part that owns it (the `dial`) computes ITS OWN area as
     that square, so its children need only `start`/`sweep` — radialFrame() with no
     `fit` attr returns the inscribed circle of whatever rect it is given, which is
     exactly right once the container has already done the fitting. `at: "center"` is
     for a part OUTSIDE the fit owner (a Gauge's tile label) that still needs to find
     the same circle from outside it. */
  if (attrs && ((attrs.at && attrText(attr(attrs, "at", cells)) === "center") || attrs.fit)) {
    const f = radialFrame(rect, attrs, cells);
    area = { x: f.cx - f.radius, y: f.cy - f.radius, w: 2 * f.radius, h: 2 * f.radius };
  }
  const aspect = attrNum(attr(attrs, "aspect", cells), 0);
  if (aspect > 0) area = fitAspect(area, aspect);
  const pad = attrNum(attr(attrs, "pad", cells), 0);
  if (pad > 0) area = inset(area, pad * Math.min(area.w, area.h));

  /* the node's own transform wraps everything it paints, ITS CHILDREN INCLUDED, so a
     hierarchy composes the way SVG already composes (spec 2.3) */
  const local = transformOf(area, attrs, cells);
  const above = parts ? parts.transform : "";
  const chain = local ? (above ? above + " " + local : local) : above;
  if (local) out.push(`<g transform="${local}">`);
  if (parts) parts.transform = chain;

  /* a named node records where it landed: the resolved area, after at/aspect/pad, and
     the transform chain that carries it there. A repeated node's own rect was already
     recorded once, before any copy's transform existed (recordRepeatRect above), so a
     copy never overwrites it with wherever this one particular copy landed. */
  if (parts && path && !repeated) parts.rects.set(path, chain ? { ...area, transform: chain } : { ...area });

  /* a drag_radial node needs its full LAYOUT AREA in the DOM bbox, not just what got
     painted: a partial sweep paints only part of its square, but the drag's pivot is
     the group's own bounding box (shell.ts). This rect contributes geometry without
     stealing the hit (pointer-events none) or changing appearance (fill none). Scoped
     to drag_radial alone: every other primitive already rides a node that paints its
     whole area (a Button's face, a Panel's tile, a Toggle's pill), so an extra rect
     there would only be noise, and unlike drag_radial they need no bbox correction. */
  if ((node as Json).interact?.primitive === "drag_radial")
    out.push(`<rect x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" ` +
             `height="${n(area.h)}" fill="none" pointer-events="none"/>`);

  /* generic clipping: a node with `clip` keeps everything it paints inside its own
     area (true = square, a number = that corner radius) */
  const clipRaw = attrs && attrs.clip ? attr(attrs, "clip", cells) : null;
  if (clipRaw !== null && clipRaw !== false) {
    const close = clipTo(area, clipRaw === true ? 0 : attrNum(clipRaw, 0), out);
    renderClipped(node, area, attrs, cells, out, acts, parts, fault);
    out.push(close);
  } else {
    renderClipped(node, area, attrs, cells, out, acts, parts, fault);
  }
  if (local) out.push(`</g>`);
  if (parts) parts.transform = above;
}

function renderClipped(
  node: TemplateNode,
  area: Rect,
  attrs: Attrs,
  cells: Cells,
  out: string[],
  acts?: ActCounter,
  parts?: PartHits,
  fault?: (part: string, err: unknown) => void,
): void {
  if (node.kind === "part") {
    switch (node.draw) {
      case "rect": drawRect(area, attrs, cells, out); break;
      case "bar": drawBar(area, attrs, cells, out); break;
      case "text": drawText(area, attrs, cells, out); break;
      case "icon": drawIcon(area, attrs, cells, out); break;
      case "arc": drawArc(area, attrs, cells, out); break;
      case "needle": drawNeedle(area, attrs, cells, out); break;
      case "plot": drawPlot(area, attrs, cells, out); break;
      case "path": drawPath(area, attrs, cells, out); break;
      case "code": drawCode(node, area, cells, out, fault); break;
    }
    /* a draw part paints its own shape, THEN renders whatever children it holds into
       the SAME area (stack semantics, spec 2.3): they paint over it and inherit its
       transform, which is what makes a dot a real CHILD of the face it rides rather
       than a sibling that happens to compute the same angle. No `dir` of its own —
       a leaf's children are never laid out beside it, only atop it. `repeat` reaches
       here too, via the same expansion a box's children go through below: it is not a
       stack-only trick. */
    for (const entry of expandRepeats(node.children ?? [], area, cells, parts))
      renderOnce(entry.node, area, entry.cells, out, acts, parts, entry.repeated, fault);
    return;
  }

  const dir = node.dir === "auto" ? (area.w >= area.h ? "row" : "col") : node.dir;
  const entries = expandRepeats(node.children ?? [], area, cells, parts);
  if (!entries.length) return;

  if (dir === "stack") {
    /* copies of a repeated stack child overlay the SAME area, one atop another, and
       place themselves apart by their own transform (a ring of detents): that is
       repeat's whole job in a stack, so there is nothing left to do here. */
    for (const entry of entries)
      renderOnce(entry.node, area, entry.cells, out, acts, parts, entry.repeated, fault);
    return;
  }

  const horizontal = dir === "row";
  const total = horizontal ? area.w : area.h;
  const cross = horizontal ? area.h : area.w;

  /* in a row/col box, repeat is a LAYOUT device rather than a placement one: each copy
     is a separate child evaluating its own weight/aspect/min_px against its own
     per-copy cells (a segmented bar's Nth segment can size differently from the
     rest), so the expanded entries are treated as ordinary siblings from here on — a
     repeated child is indistinguishable from N authored ones once expandRepeats has
     run, which is what lays out a segmented bar or a strip of lamps side by side. */
  let live: Child[] = entries.map((entry) => {
    const a = (entry.node as Json).attrs ?? {};
    const childAspect = attrNum(attr(a, "aspect", entry.cells), 0);
    return {
      node: entry.node,
      cells: entry.cells,
      repeated: entry.repeated,
      weight: Math.max(0, attrNum(attr(a, "weight", entry.cells), 1)),
      minPx: Math.max(0, attrNum(attr(a, "min_px", entry.cells), 0)),
      aspect: childAspect,
      main: childAspect > 0 ? (horizontal ? cross * childAspect : cross / childAspect) : 0,
    };
  });

  /* distribute, then shed anything whose min_px cannot be met and distribute again */
  for (let pass = 0; pass < 3; ++pass) {
    const fixed = live.reduce((sum, c) => sum + (c.aspect > 0 ? c.main : 0), 0);
    const weights = live.reduce((sum, c) => sum + (c.aspect > 0 ? 0 : c.weight), 0);
    const free = Math.max(0, total - fixed);
    for (const c of live) if (c.aspect <= 0) c.main = weights > 0 ? (free * c.weight) / weights : 0;
    const shed = live.filter((c) => c.minPx > 0 && c.main < c.minPx);
    if (!shed.length) break;
    live = live.filter((c) => shed.indexOf(c) < 0);
    if (!live.length) return;
  }

  let at = horizontal ? area.x : area.y;
  for (const c of live) {
    const childRect: Rect = horizontal
      ? { x: at, y: area.y, w: c.main, h: area.h }
      : { x: area.x, y: at, w: area.w, h: c.main };
    at += c.main;
    if (c.main > 0.5) renderOnce(c.node, childRect, c.cells, out, acts, parts, c.repeated, fault);
  }
}
