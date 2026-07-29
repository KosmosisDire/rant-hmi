/* The template renderer: one engine for every widget type, driven entirely by the
 * registry's data (spec 2.3). Layout is proportional, so a widget fills its tile at any
 * size and no template carries a pixel position: boxes split their rect by `dir` and
 * per-child weight, an aspect-locked child takes its size from the cross axis, and a
 * child that cannot meet its min_px is dropped so a template sheds parts as space
 * shrinks. Every attribute is a program (program.ts), including the layout ones. */

import { attrBool, attrColor, attrNum, attrText, Cells, run } from "./program.js";
import { Attrs, Json, TemplateNode } from "./types.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ICONS: Record<string, string> = {
  /* 24x24 viewBox paths (Lucide geometry), scaled into the part's rect */
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-right": "M9 6l6 6-6 6",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
};

/* the UNKNOWN treatment: a value the backend does not have is never invented */
export const UNKNOWN_TEXT = "--";

export function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

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
  const longest = lines.reduce((len, line) => Math.max(len, line.length), 1);
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

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
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

/* a pointer from `inner` to `outer` (radius fractions) at value's angle, with an
 * optional center hub. The hub and the needle body are ONE filled path, so a
 * translucent handle color reads as one object instead of darkening where the two
 * pieces overlap; no needle when the value is UNKNOWN (the hub alone, if any). */
function drawNeedle(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const f = radialFrame(rect, attrs, cells);
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#ececec";
  const hub = f.radius * attrNum(attr(attrs, "hub", cells), 0);
  const parts: string[] = [];
  if (hub > 0) parts.push(circleSub(f.cx, f.cy, hub));
  const raw = attr(attrs, "value", cells);
  if (raw !== null) {
    const value = Math.max(0, Math.min(1, attrNum(raw, 0)));
    const angle = f.start + f.sweep * value;
    const inner = f.radius * attrNum(attr(attrs, "inner", cells), 0);
    const outer = f.radius * attrNum(attr(attrs, "outer", cells), 0.78);
    const half = Math.max(0.5, (f.radius * attrNum(attr(attrs, "width", cells), 0.06)) / 2);
    const [x0, y0] = polar(f.cx, f.cy, inner, angle);
    const [x1, y1] = polar(f.cx, f.cy, outer, angle);
    parts.push(capsuleSub(x0, y0, x1, y1, half));
  }
  if (parts.length) out.push(`<path d="${parts.join(" ")}" fill="${fill}"/>`);
}

/* the grabbable dot at value's angle, riding radius fraction `at`; nothing when UNKNOWN */
function drawMarkPart(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  const f = radialFrame(rect, attrs, cells);
  const raw = attr(attrs, "value", cells);
  if (raw === null) return;
  const value = Math.max(0, Math.min(1, attrNum(raw, 0)));
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#ececec";
  const at = f.radius * attrNum(attr(attrs, "at", cells), 0.78);
  const size = Math.max(1, f.radius * attrNum(attr(attrs, "size", cells), 0.12));
  const [x, y] = polar(f.cx, f.cy, at, f.start + f.sweep * value);
  out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(size)}" fill="${fill}"/>`);
}

/* the SCALE MARKERS: `count` marks spread over the sweep (or, with dir "h", along the
 * rect's width), with optional numeric labels (min..max interpolated). The one text a
 * control renders besides its own `text` slot: a value readout is always the user's
 * own Label or Readout, never built in. */
function drawTicks(rect: Rect, attrs: Attrs, cells: Cells, out: string[]): void {
  /* a declared-but-unresolvable count (a Selector with no options yet) draws nothing */
  const rawCount = attr(attrs, "count", cells);
  if (attrs && attrs.count && rawCount === null) return;
  const count = Math.max(2, Math.min(51, Math.round(attrNum(rawCount, 5))));
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#5a5a5a";
  const labels = attrBool(attr(attrs, "labels", cells), false);
  const lo = attrNum(attr(attrs, "min", cells), 0);
  const hi = attrNum(attr(attrs, "max", cells), 1);
  const decimals = Math.max(0, Math.min(6, attrNum(attr(attrs, "decimals", cells), 0)));
  const textFill = attrColor(attr(attrs, "text_fill", cells)) ?? "#8a8a8a";
  /* `names` labels each tick with its own text (a Selector's options) instead of the
     numeric min..max interpolation */
  const rawNames = attrs && attrs.names ? attr(attrs, "names", cells) : null;
  const names = Array.isArray(rawNames) ? rawNames.map(String) : null;
  const label = (i: number) =>
    names ? names[i] ?? "" : (lo + ((hi - lo) * i) / (count - 1)).toFixed(decimals);

  const texts: string[] = [];
  for (let i = 0; i < count; ++i) texts.push(label(i));
  const chars = Math.max(1, ...texts.map((t) => t.length));

  /* the END ticks sit fully INSIDE the ends: past the control's own end rounding
     (`cap_radius` = the control_radius slot, clamped exactly as the arc/bar clamps
     it) plus half the tick's own stroke. At radius 0 that is just the stroke; as
     the radius grows the end tick starts where the rounding stops. Deliberately a
     hair inside the true endpoint: the end labels read as the endpoints' marks
     either way, and a tick riding the cap's curve looks broken. */
  const capOf = (stroke: number) => {
    const raw = attrs && attrs.cap_radius ? attr(attrs, "cap_radius", cells) : null;
    return Math.max(0, Math.min(raw === null ? stroke / 2 : attrNum(raw, 0), stroke / 2));
  };

  if (attrText(attr(attrs, "dir", cells)) === "h") {
    /* linear: marks along the top of this rect (the row under a slider's bar),
       labels set beneath them, under the same rules as the radial scale */
    const mark = rect.h * (labels ? 0.4 : 0.8);
    const width = Math.max(0.75, rect.h * 0.07);
    /* the bar is roughly the row above this one; its stroke for the cap clamp */
    const inset = Math.min(rect.w / 4, capOf(rect.h * 2.2) + width / 2);
    /* the marks are round-capped strokes: their paint reaches half the width past
       the endpoint, so the bar-facing end drops by that half plus a whisker of
       gap, never touching the bar above (same clearance as the radial scales) */
    const clear = width / 2 + rect.h * 0.06;
    /* true value positions, only the end marks slid inward: as on the radial scale */
    const spacing = rect.w / (count - 1);
    const xOf = (i: number) =>
      Math.min(rect.x + rect.w - inset, Math.max(rect.x + inset, rect.x + spacing * i));
    for (let i = 0; i < count; ++i) {
      out.push(`<path d="M${n(xOf(i))} ${n(rect.y + clear)} v${n(mark)}" stroke="${fill}" ` +
               `stroke-width="${n(width)}" stroke-linecap="round"/>`);
    }
    if (!labels) return;
    /* same label rules as below: sized against the spacing, thinned past the floor,
       each centered on its tick (slid inward only if the tile would cut it) */
    let size = Math.max(5, Math.min(rect.h * 0.55, (spacing * 0.9) / (0.58 * chars)));
    if (size < 6) size = 6;
    const every = Math.max(1, Math.ceil((0.58 * size * chars) / Math.max(1, spacing * 0.95)));
    for (let i = 0; i < count; ++i) {
      if (every > 1 && i % every !== 0 && i !== count - 1) continue;
      const half = (0.58 * size * texts[i].length) / 2;
      const x = Math.max(rect.x + half, Math.min(rect.x + rect.w - half, xOf(i)));
      out.push(`<text x="${n(x)}" y="${n(rect.y + clear + mark + size * 0.65)}" ` +
               `fill="${textFill}" font-size="${n(size)}" text-anchor="middle" ` +
               `dominant-baseline="central">${escapeXml(texts[i])}</text>`);
    }
    return;
  }

  const f = radialFrame(rect, attrs, cells);
  const outer = f.radius * attrNum(attr(attrs, "outer", cells), 1);
  const len = f.radius * attrNum(attr(attrs, "len", cells), 0.1);
  /* mark width first (from the un-inset pitch: the inset is a few degrees and must
     not feed back into it), then the end inset it contributes to */
  const pitch0 = (f.sweep / (count - 1)) * (Math.PI / 180);
  const width = Math.max(0.75, Math.min(f.radius * 0.018,
    (2 * outer * Math.sin(Math.min(Math.PI / 2, pitch0 / 2))) / 3));
  /* the arc's end fillet, in the ticks' own angular terms: rc from cap_radius
     clamped to the arc's stroke (`cap_width`, the thickness fraction), converted
     to the angle it subtends at the marks' radius */
  const capW = f.radius * Math.max(0, attrNum(attr(attrs, "cap_width", cells), 0));
  const rc = capW > 0 ? capOf(capW) : 0;
  const deg = 180 / Math.PI;
  const inset = outer > 0
    ? Math.min(f.sweep / 4,
        deg * (Math.asin(Math.min(1, rc / outer)) + Math.asin(Math.min(1, width / 2 / outer))))
    : 0;
  /* every tick sits at its TRUE value position, so a click on a tick lands exactly
     on that tick's value; only the ticks the end rounding would swallow (the
     endpoints) shift inward by the inset. The end marks lie by a couple degrees;
     the ends clamp to min/max under the finger anyway, so nothing else does. */
  const angleOf = (i: number) =>
    Math.min(f.start + f.sweep - inset,
      Math.max(f.start + inset, f.start + (f.sweep * i) / (count - 1)));
  /* the angular pitch between marks, and the tangential room it leaves at a radius:
     the one crowding measure marks and labels both size against */
  const pitch = pitch0;
  const roomAt = (r: number) => 2 * r * Math.sin(Math.min(Math.PI / 2, pitch / 2));
  /* `outer` names the edge the marks HUG (the arc's inner edge for an inside scale),
     but a mark is a round-capped STROKE: its paint reaches half its width past its
     endpoint, so the arc-facing end pulls back by that half plus a whisker of gap,
     never touching the arc it hugs. An inside scale's whole mark shifts in; an
     outside scale's mark keeps its far end and shortens instead. */
  const outSide = attrBool(attr(attrs, "labels_out", cells), false);
  const clear = width / 2 + f.radius * 0.015;
  const rOut = outSide ? outer : outer - clear;
  const rIn = outSide ? Math.min(rOut - 1, outer - len + clear) : rOut - len;
  for (let i = 0; i < count; ++i) {
    const angle = angleOf(i);
    const [x0, y0] = polar(f.cx, f.cy, rIn, angle);
    const [x1, y1] = polar(f.cx, f.cy, rOut, angle);
    out.push(`<path d="M${n(x0)} ${n(y0)} L${n(x1)} ${n(y1)}" stroke="${fill}" ` +
             `stroke-width="${n(width)}" stroke-linecap="round"/>`);
  }
  if (!labels) return;

  /* ---- the label rules, shared by every tick-bearing control ----
     1. a label never overlaps its mark: it anchors a small gap past the mark's end,
        and its box is pushed AWAY along the tick's own direction, so the edge that
        faces the tick is centered ON the tick (a top label sits above its tick,
        horizontally centered; a side label sits beside it, vertically centered);
     2. turning labels on shrinks the control (its `outer` reserves the rim), and
        the labels repay it: the size shrinks until the longest label fits between
        the marks and the rim, so a label never spills out of the tile;
     3. neighboring labels never collide: the size shrinks toward a readable floor
        first, and past the floor labels are THINNED (every k-th drawn, the last
        always) rather than made illegible. */
  /* option names run longer than numbers, so they start a little smaller */
  let size = Math.max(5, f.radius * (names ? 0.11 : 0.16));
  if (outSide)
    size = Math.min(size, Math.max(6, (f.radius - outer) / (0.35 + 0.58 * chars)));
  const room = roomAt(outSide ? rOut : Math.max(1, rIn)) * 0.9;
  if (0.58 * size * chars > room) size = Math.max(6, room / (0.58 * chars));
  const every = Math.max(1, Math.ceil((0.58 * size * chars) / Math.max(1, room)));
  /* labels anchor off the marks' ACTUAL far end, wherever the clearance put it */
  const anchorR = outSide ? rOut + size * 0.35 : rIn - size * 0.35;
  for (let i = 0; i < count; ++i) {
    if (every > 1 && i % every !== 0 && i !== count - 1) continue;
    const angle = angleOf(i);
    const rad = angle * (Math.PI / 180);
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const push = outSide ? 1 : -1;
    const [px, py] = polar(f.cx, f.cy, anchorR, angle);
    const cx = px + push * dx * ((0.58 * size * texts[i].length) / 2);
    const cy = py + push * dy * (size * 0.6);
    out.push(`<text x="${n(cx)}" y="${n(cy)}" fill="${textFill}" font-size="${n(size)}" ` +
             `text-anchor="middle" dominant-baseline="central">` +
             `${escapeXml(texts[i])}</text>`);
  }
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
  const path = ICONS[name];
  if (!path) return;
  const fill = attrColor(attr(attrs, "fill", cells)) ?? "#8b95a7";
  const box = fitAspect(rect, 1);
  const scale = box.w / 24;
  out.push(
    `<g transform="translate(${n(box.x)} ${n(box.y)}) scale(${n(scale)})" ` +
      `fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" ` +
      `stroke-linejoin="round"><path d="${path}"/></g>`,
  );
}

/* ---- layout ---- */

interface Child {
  node: TemplateNode;
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

export function renderNode(
  node: TemplateNode,
  rect: Rect,
  cells: Cells,
  out: string[],
  acts?: ActCounter,
): void {
  if (!node) return;
  const act = (node as Json).interact && acts ? acts.next++ : -1;
  const attrs = (node as Json).attrs ?? {};
  if (attrs.show && !attrBool(attr(attrs, "show", cells), false)) return;

  /* the browser's own SVG hit test resolves gestures: everything this node PAINTS is
     the interactive element, whatever its shape, so the group carries the ordinal */
  if (act >= 0) out.push(`<g data-act="${act}">`);
  renderBody(node, rect, attrs, cells, out, acts);
  if (act >= 0) out.push(`</g>`);
}

function renderBody(
  node: TemplateNode,
  rect: Rect,
  attrs: Attrs,
  cells: Cells,
  out: string[],
  acts?: ActCounter,
): void {
  let area = rect;
  /* a node with `at: "center"` pins its area to the FITTED CIRCLE (the square around
     it), before aspect/pad apply: with `fit` fill the circle sits off the widget
     center, and a control's own label belongs on the circle, not the tile */
  if (attrs && attrs.at && attrText(attr(attrs, "at", cells)) === "center") {
    const f = radialFrame(rect, attrs, cells);
    area = { x: f.cx - f.radius, y: f.cy - f.radius, w: 2 * f.radius, h: 2 * f.radius };
  }
  const aspect = attrNum(attr(attrs, "aspect", cells), 0);
  if (aspect > 0) area = fitAspect(area, aspect);
  const pad = attrNum(attr(attrs, "pad", cells), 0);
  if (pad > 0) area = inset(area, pad * Math.min(area.w, area.h));

  /* generic clipping: a node with `clip` keeps everything it paints inside its own
     area (true = square, a number = that corner radius) */
  const clipRaw = attrs && attrs.clip ? attr(attrs, "clip", cells) : null;
  if (clipRaw !== null && clipRaw !== false) {
    const close = clipTo(area, clipRaw === true ? 0 : attrNum(clipRaw, 0), out);
    renderClipped(node, area, attrs, cells, out, acts);
    out.push(close);
    return;
  }
  renderClipped(node, area, attrs, cells, out, acts);
}

function renderClipped(
  node: TemplateNode,
  area: Rect,
  attrs: Attrs,
  cells: Cells,
  out: string[],
  acts?: ActCounter,
): void {
  if (node.kind === "part") {
    switch (node.draw) {
      case "rect": drawRect(area, attrs, cells, out); return;
      case "bar": drawBar(area, attrs, cells, out); return;
      case "text": drawText(area, attrs, cells, out); return;
      case "icon": drawIcon(area, attrs, cells, out); return;
      case "arc": drawArc(area, attrs, cells, out); return;
      case "needle": drawNeedle(area, attrs, cells, out); return;
      case "mark": drawMarkPart(area, attrs, cells, out); return;
      case "ticks": drawTicks(area, attrs, cells, out); return;
      case "plot": drawPlot(area, attrs, cells, out); return;
    }
    return;
  }

  const dir = node.dir === "auto" ? (area.w >= area.h ? "row" : "col") : node.dir;
  const children = (node.children ?? []).filter(
    (child) => !(child as Json).attrs?.show || attrBool(attr((child as Json).attrs, "show", cells), false),
  );
  if (!children.length) return;

  if (dir === "stack") {
    for (const child of children) renderNode(child, area, cells, out, acts);
    return;
  }

  const horizontal = dir === "row";
  const total = horizontal ? area.w : area.h;
  const cross = horizontal ? area.h : area.w;

  let live: Child[] = children.map((child) => {
    const a = (child as Json).attrs ?? {};
    const childAspect = attrNum(attr(a, "aspect", cells), 0);
    return {
      node: child,
      weight: Math.max(0, attrNum(attr(a, "weight", cells), 1)),
      minPx: Math.max(0, attrNum(attr(a, "min_px", cells), 0)),
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
    if (c.main > 0.5) renderNode(c.node, childRect, cells, out, acts);
  }
}
