/* The artboard: one SVG in canvas units, so scale-to-fit is the viewBox and nothing here
 * deals in pixels. Draw order is artboard, edit grid, fused island surface, then each
 * widget's frame (from the base slots, once, shared by every type) and its template
 * content, then the editing overlay.
 *
 * The overlay is the old designer's: a hover ring, one selection box over the whole
 * selection bbox (solid for one widget, dashed for a group) at the island's corner radius,
 * carrying four edge pills and four corner brackets that trace the ring's centreline.
 * Everything in it is divided by the view scale, so grips stay the same size on screen at
 * any zoom. */

import { dividerPath, unionPath } from "./islands.js";
import { cellsFor, opaqueEnough, resolveSlot, fedSlots, typeOf } from "./slots.js";
import { escapeXml, Rect, renderNode } from "./template.js";
import { Canvas, Doc, HistView, Json, Live, Mesh, Page, Registry, Widget, WidgetType } from "./types.js";

export type Mode = "edit" | "test" | "operate";

export interface ViewState {
  mode: Mode;
  selection: number[];
  hover: number;
  scale: number;                                /* px per canvas unit */
  ghost: Rect | null;                           /* drag/resize preview */
  state: Record<number, Record<string, Json>>;  /* per-widget interaction state */
  faults: Record<number, string>;               /* worst compile grade, per widget */
}

const ISLAND_RADIUS = 16;

export function cellSize(canvas: Canvas): number {
  return canvas.unit_w / Math.max(1, canvas.cols);
}

function num(v: number): string {
  return v.toFixed(2);
}

function parseAspect(text: string): number {
  if (!text) return 0;
  const parts = text.split("/");
  const a = Number(parts[0]);
  const b = parts.length > 1 ? Number(parts[1]) : 1;
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 && a > 0 ? a / b : 0;
}

function alignFactors(align: string): [number, number] {
  const h = align.includes("left") ? 0 : align.includes("right") ? 1 : 0.5;
  const v = align.includes("top") ? 0 : align.includes("bottom") ? 1 : 0.5;
  return [h, v];
}

/* The FRAME: the widget's styleable box. Tile less the tile-to-panel padding, then
 * aspect-locked and placed by `align`, so aspect visibly shapes the thing surface and
 * border paint (a Panel's card, a Button's face), not just an invisible content box. */
function frameRect(widget: Widget, panelPad: number, aspect: string, align: string): Rect {
  const g = widget.geom;
  const p = panelPad < 0 ? 5 : panelPad;
  let rect: Rect = { x: g.x + p, y: g.y + p, w: Math.max(1, g.w - 2 * p), h: Math.max(1, g.h - 2 * p) };
  const ratio = parseAspect(aspect);
  if (ratio > 0) {
    let w = rect.w;
    let h = w / ratio;
    if (h > rect.h) {
      h = rect.h;
      w = h * ratio;
    }
    const [hx, vy] = alignFactors(align);
    rect = { x: rect.x + (rect.w - w) * hx, y: rect.y + (rect.h - h) * vy, w, h };
  }
  return rect;
}

/* the content box: the frame less the panel-to-content padding */
function contentRect(frame: Rect, pad: number): Rect {
  const auto = Math.max(4, Math.min(frame.w, frame.h) * 0.08);
  const p = pad < 0 ? auto : pad;
  return {
    x: frame.x + p,
    y: frame.y + p,
    w: Math.max(1, frame.w - 2 * p),
    h: Math.max(1, frame.h - 2 * p),
  };
}

/* Does this widget's face DO anything when touched? An event-triggered flow of its
 * own counts; so does a type default (behavior) that writes a slot the author left
 * unfed. A FED slot makes the default write moot: the feed owns the value, so a
 * value-owning control whose value is fed is read-only. An inert widget is made
 * pointer-transparent in test/operate, so a read-only progress slider laid over other
 * controls lets the clicks through to them instead of swallowing them. */
function widgetInteractive(widget: Widget, type: WidgetType | null, fed: Set<string>): boolean {
  const byEvent = (flow: Json) =>
    Array.isArray(flow?.when) && flow.when.some((t: Json) => t?.kind === "event");
  if ((widget.flows ?? []).some(byEvent)) return true;
  for (const flow of (type?.behavior ?? []) as Json[]) {
    if (!byEvent(flow)) continue;
    for (const step of flow?.do ?? [])
      if (step?.kind === "move" && typeof step.to?.slot === "string" && !fed.has(step.to.slot))
        return true;
  }
  return false;
}

export function bboxOf(widgets: Widget[]): Rect {
  const x = Math.min(...widgets.map((w) => w.geom.x));
  const y = Math.min(...widgets.map((w) => w.geom.y));
  const right = Math.max(...widgets.map((w) => w.geom.x + w.geom.w));
  const bottom = Math.max(...widgets.map((w) => w.geom.y + w.geom.h));
  return { x, y, w: right - x, h: bottom - y };
}

/* ---- the editing overlay ---- */

/* the ring radius: the island's rounding, capped so a tiny selection rounds fully */
function ringRadius(rect: Rect): number {
  return Math.min(ISLAND_RADIUS, rect.w / 2, rect.h / 2);
}

function hitRect(rect: Rect, handle: string, cursor: string): string {
  return (
    `<rect class="sel-hit" data-handle="${handle}" x="${num(rect.x)}" y="${num(rect.y)}" ` +
    `width="${num(rect.w)}" height="${num(rect.h)}" fill="rgba(0,0,0,0)" ` +
    `style="cursor:${cursor}"/>`
  );
}

/* Edge pills and corner brackets, generated to straddle the ring's centreline exactly as
 * the old designer did: the bracket path traces the ring, so a grip never floats. */
function grips(box: Rect, radius: number, unit: number): string {
  const out: string[] = [];
  const line = 2 * unit;
  const off = line / 2;
  const pill = 4 * unit;
  const grab = 12 * unit;
  const vlen = Math.min(28 * unit, Math.max(8 * unit, box.h - 2 * radius - 6 * unit));
  const hlen = Math.min(28 * unit, Math.max(8 * unit, box.w - 2 * radius - 6 * unit));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const bar = (handle: string, cursor: string, x: number, y: number, w: number, h: number) => {
    const hw = Math.max(w, grab);
    const hh = Math.max(h, grab);
    out.push(
      `<rect class="sel-grip" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ` +
        `rx="${num(Math.min(w, h) / 2)}"/>`,
    );
    out.push(
      hitRect({ x: x + w / 2 - hw / 2, y: y + h / 2 - hh / 2, w: hw, h: hh }, handle, cursor),
    );
  };
  bar("L", "ew-resize", box.x - off - pill / 2, cy - vlen / 2, pill, vlen);
  bar("R", "ew-resize", box.x + box.w - off - pill / 2 + line, cy - vlen / 2, pill, vlen);
  bar("T", "ns-resize", cx - hlen / 2, box.y - off - pill / 2, hlen, pill);
  bar("B", "ns-resize", cx - hlen / 2, box.y + box.h - off - pill / 2 + line, hlen, pill);

  /* corner brackets: an L that follows the ring's arc, then a short straight arm */
  const arm = 5 * unit;
  const rc = radius + off;
  const corner = (handle: string, cursor: string, sx: number, sy: number, dx: number, dy: number) => {
    /* start on the horizontal run, arc through the corner, end on the vertical run */
    const hx = sx + dx * (radius + arm);
    const hy = sy - dy * off;
    const ax = sx + dx * radius;
    const ay = sy - dy * off;
    const bx = sx - dx * off;
    const by = sy + dy * radius;
    const vx = sx - dx * off;
    const vy = sy + dy * (radius + arm);
    const sweep = dx * dy > 0 ? 0 : 1;
    out.push(
      `<path class="sel-arc" stroke-width="${num(4 * unit)}" d="M${num(hx)} ${num(hy)} ` +
        `L${num(ax)} ${num(ay)} A${num(rc)} ${num(rc)} 0 0 ${sweep} ${num(bx)} ${num(by)} ` +
        `L${num(vx)} ${num(vy)}"/>`,
    );
    out.push(
      hitRect(
        {
          x: Math.min(hx, vx, sx) - grab / 2,
          y: Math.min(hy, vy, sy) - grab / 2,
          w: Math.abs(hx - vx) + grab,
          h: Math.abs(hy - vy) + grab,
        },
        handle,
        cursor,
      ),
    );
  };
  corner("TL", "nwse-resize", box.x, box.y, 1, 1);
  corner("TR", "nesw-resize", box.x + box.w, box.y, -1, 1);
  corner("BL", "nesw-resize", box.x, box.y + box.h, 1, -1);
  corner("BR", "nwse-resize", box.x + box.w, box.y + box.h, -1, -1);
  return out.join("");
}

function overlay(page: Page, view: ViewState): string {
  const unit = 1 / Math.max(0.05, view.scale);   /* one screen pixel, in canvas units */
  const out: string[] = [];

  if (view.hover && view.selection.indexOf(view.hover) < 0) {
    const widget = (page.widgets ?? []).find((w) => w.id === view.hover);
    if (widget) {
      const g = widget.geom;
      const inset = -2 * unit;
      out.push(
        `<rect class="hover-ring" stroke-width="${num(unit)}" x="${num(g.x + inset)}" ` +
          `y="${num(g.y + inset)}" width="${num(g.w - 2 * inset)}" height="${num(g.h - 2 * inset)}" ` +
          `rx="${num(ringRadius(g))}"/>`,
      );
    }
  }

  const selected = (page.widgets ?? []).filter((w) => view.selection.indexOf(w.id) >= 0);
  if (selected.length) {
    const box = bboxOf(selected);
    const radius = ringRadius(box);
    const dash = selected.length > 1 ? ` stroke-dasharray="${num(6 * unit)} ${num(4 * unit)}"` : "";
    out.push(
      `<rect class="sel-ring" stroke-width="${num(2 * unit)}"${dash} x="${num(box.x)}" ` +
        `y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="${num(radius)}"/>`,
    );
    out.push(grips(box, radius, unit));
  }

  if (view.ghost) {
    const g = view.ghost;
    out.push(
      `<rect class="ghost" stroke-width="${num(2 * unit)}" ` +
        `stroke-dasharray="${num(7 * unit)} ${num(5 * unit)}" x="${num(g.x)}" y="${num(g.y)}" ` +
        `width="${num(g.w)}" height="${num(g.h)}" rx="${num(ringRadius(g))}"/>`,
    );
  }
  return out.join("");
}

/* a corner badge on a widget with a compile finding: a filled dot with a bang, sized off
 * the tile so it stays legible without depending on the view scale */
function faultMark(geom: Rect, grade: string): string {
  const r = Math.max(5, Math.min(9, Math.min(geom.w, geom.h) / 8));
  const cx = geom.x + geom.w - r - 3;
  const cy = geom.y + r + 3;
  return (
    `<g class="fault ${grade}"><circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}"/>` +
    `<path d="M${num(cx)} ${num(cy - r * 0.45)}v${num(r * 0.6)}" stroke-width="${num(r * 0.28)}"/>` +
    `<circle class="dot" cx="${num(cx)}" cy="${num(cy + r * 0.45)}" r="${num(r * 0.14)}"/></g>`
  );
}

/* ---- the page ---- */

export function renderContent(
  doc: Doc,
  page: Page,
  registry: Registry | null,
  live: Live | null,
  view: ViewState,
  mesh: Mesh | null = null,
  hists: Record<string, HistView> | null = null,
): string {
  const canvas = doc.canvas;
  const cell = cellSize(canvas);
  const out: string[] = [];
  const editing = view.mode !== "operate";

  /* The artboard's depth cue rides on its own background rect: a CSS filter on the whole
     SVG would re-introduce the clipping this deliberately avoids. The grid is one tiled
     pattern, so it costs one rect however many cells the canvas has. */
  const half = cell / 2;
  out.push(
    `<defs><filter id="artboard-shadow" x="-10%" y="-10%" width="120%" height="130%">` +
      `<feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.5"/>` +
      `</filter>` +
      `<pattern id="cell-grid" x="${num(-half)}" y="${num(-half)}" width="${num(cell)}" ` +
      `height="${num(cell)}" patternUnits="userSpaceOnUse">` +
      `<path class="grid" d="M${num(half - 3)} ${num(half)}h6M${num(half)} ${num(half - 3)}v6"/>` +
      `</pattern></defs>`,
  );
  out.push(
    `<rect x="0" y="0" width="${canvas.unit_w}" height="${canvas.unit_h}" rx="4" ` +
      `class="artboard-bg" filter="url(#artboard-shadow)"/>`,
  );
  if (view.mode === "edit")
    out.push(
      `<rect x="${num(half)}" y="${num(half)}" width="${num(canvas.unit_w - cell)}" ` +
        `height="${num(canvas.unit_h - cell)}" fill="url(#cell-grid)"/>`,
    );

  /* The fused surface: every visible widget whose `merge` slot is on, wherever it sits.
     Grid snapping is a placement aid, not a condition for merging: the outline is the exact
     union of the widgets' own rectangles. */
  const merged: Rect[] = [];
  const visible: Widget[] = [];
  for (const widget of page.widgets ?? []) {
    const type = typeOf(registry, widget.type);
    const fed = fedSlots(widget);
    const shown = resolveSlot(widget, type, live, fed, "visible");
    if (shown === false || shown === null) continue;
    visible.push(widget);
    if (resolveSlot(widget, type, live, fed, "merge") === false) continue;
    /* the tile itself, not the inset panel: adjacent tiles touch, so they fuse */
    merged.push({ ...widget.geom });
  }
  if (merged.length) {
    const path = unionPath(merged, ISLAND_RADIUS);
    if (path) out.push(`<path d="${path}" class="island"/>`);
    const dividers = dividerPath(merged);
    if (dividers) out.push(`<path d="${dividers}" class="divider"/>`);
  }

  for (const widget of visible) {
    const type = typeOf(registry, widget.type);
    const fed = fedSlots(widget);
    const slot = (name: string) => resolveSlot(widget, type, live, fed, name);
    const enabled = slot("enabled") !== false && slot("enabled") !== null;
    const panelPad = Number(slot("panel_pad") ?? -1);
    const pad = Number(slot("pad") ?? -1);
    /* radius < 0 = auto: nest concentrically inside the island's corner at this inset */
    const rawRadius = Number(slot("radius") ?? -1);
    const uncapped =
      rawRadius < 0 ? Math.max(0, ISLAND_RADIUS - (panelPad < 0 ? 5 : panelPad)) : rawRadius;

    /* outside edit mode an inert widget never captures the pointer: the browser's
       hit test skips its whole group, so whatever sits behind it gets the event */
    const inert = view.mode !== "edit" && !widgetInteractive(widget, type, fed);
    out.push(`<g class="widget${enabled ? "" : " disabled"}" data-id="${widget.id}"` +
             `${inert ? ` pointer-events="none"` : ""}>`);
    if (editing) {
      const g = widget.geom;
      out.push(
        `<rect class="widget-hit" x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" ` +
          `height="${num(g.h)}" fill="rgba(0,0,0,0)"/>`,
      );
    }
    const frame = frameRect(
      widget,
      panelPad,
      String(slot("aspect") ?? ""),
      String(slot("align") ?? "center"),
    );
    /* the radius caps at half the SHORT side, so a big value makes a pill: an uncapped
       rx would let SVG clamp rx and ry separately and round the frame into an oval */
    const radius = Math.min(uncapped, Math.min(frame.w, frame.h) / 2);
    const surface = opaqueEnough(slot("surface"));
    const border = opaqueEnough(slot("border"));
    /* an interact on the template ROOT owns the widget's whole face, so the generic
       frame paint joins its element (a Panel's card, a Button's face are the thing the
       operator presses); a nested interact leaves the frame inert (a Toggle's pill) */
    const rootAct = Boolean(type && (type.template as Json)?.interact);
    if (surface || border) {
      if (rootAct) out.push(`<g data-act="0">`);
      out.push(
        `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.w)}" ` +
          `height="${num(frame.h)}" rx="${num(radius)}" fill="${surface ?? "none"}"` +
          (border ? ` stroke="${border}" stroke-width="1.5"` : "") +
          `/>`,
      );
      if (rootAct) out.push(`</g>`);
    }

    if (type) {
      const rect = contentRect(frame, pad);
      renderNode(type.template, rect,
                 cellsFor(widget, type, live, view.state[widget.id] ?? {}, mesh, hists), out,
                 { next: 0 });
    } else {
      out.push(
        `<text x="${num(widget.geom.x + widget.geom.w / 2)}" ` +
          `y="${num(widget.geom.y + widget.geom.h / 2)}" class="missing-type" ` +
          `text-anchor="middle" dominant-baseline="central">${escapeXml(widget.type)}?</text>`,
      );
    }
    /* A widget the compiler complained about is marked HERE, on the thing itself. A feed
       that did not compile leaves its slot UNKNOWN forever, which on its own looks exactly
       like a value that has not arrived yet; without this the mistake is invisible. */
    const fault = editing ? view.faults?.[widget.id] : undefined;
    if (fault === "error" || fault === "warning") out.push(faultMark(widget.geom, fault));
    out.push(`</g>`);
  }

  return out.join("");
}

/* The editing overlay is its own layer: it is the only thing that depends on the view
 * scale, so a pan or a zoom redraws these few shapes instead of the whole artboard. */
export function renderOverlay(page: Page, view: ViewState): string {
  return view.mode === "operate" ? "" : overlay(page, view);
}

/* the topmost widget under an artboard point, or 0 */
export function hitTest(page: Page, x: number, y: number): number {
  const widgets = page.widgets ?? [];
  for (let i = widgets.length - 1; i >= 0; i--) {
    const g = widgets[i].geom;
    if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) return widgets[i].id;
  }
  return 0;
}
