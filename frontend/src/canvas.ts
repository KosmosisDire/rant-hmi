/* The artboard: one SVG in canvas units, so scale-to-fit is the viewBox and nothing in
 * here ever deals in pixels. It draws, in order, the artboard, the edit grid, the fused
 * island surface, then each widget's frame (from the base slots, once, shared by every
 * type) and its template content, then the selection. */

import { dividerPath, gridPath, Tile, tracePath } from "./islands.js";
import { cellsFor, opaqueEnough, resolveSlot, fedSlots, typeOf } from "./slots.js";
import { escapeXml, Rect, renderNode } from "./template.js";
import { Canvas, Doc, Json, Live, Page, Registry, Widget } from "./types.js";

export type Mode = "edit" | "run" | "operate";

export interface ViewState {
  mode: Mode;
  selection: number[];
  state: Record<number, Record<string, Json>>; /* per-widget interaction state */
}

const ISLAND_RADIUS = 16;

export function cellSize(canvas: Canvas): number {
  return canvas.unit_w / Math.max(1, canvas.cols);
}

/* a widget joins the fused island only when it is snapped to the grid (spec 3.1) */
function tileOf(widget: Widget, cell: number): Tile | null {
  const { x, y, w, h } = widget.geom;
  const near = (v: number) => Math.abs(v - Math.round(v)) < 0.02;
  const c = x / cell;
  const r = y / cell;
  const cw = w / cell;
  const ch = h / cell;
  if (!near(c) || !near(r) || !near(cw) || !near(ch)) return null;
  if (cw < 1 || ch < 1) return null;
  return { c: Math.round(c), r: Math.round(r), cw: Math.round(cw), ch: Math.round(ch) };
}

function num(v: number): string {
  return v.toFixed(2);
}

/* the content box: tile, less the tile-to-panel and panel-to-content paddings, then
 * aspect-locked and placed by `justify` */
function contentRect(widget: Widget, panelPad: number, pad: number, aspect: string, justify: string): Rect {
  const g = widget.geom;
  const auto = Math.max(4, Math.min(g.w, g.h) * 0.08);
  const p1 = panelPad < 0 ? 5 : panelPad;
  const p2 = pad < 0 ? auto : pad;
  let rect: Rect = {
    x: g.x + p1 + p2,
    y: g.y + p1 + p2,
    w: Math.max(1, g.w - 2 * (p1 + p2)),
    h: Math.max(1, g.h - 2 * (p1 + p2)),
  };
  const ratio = parseAspect(aspect);
  if (ratio > 0) {
    let w = rect.w;
    let h = w / ratio;
    if (h > rect.h) {
      h = rect.h;
      w = h * ratio;
    }
    const [hx, vy] = justifyFactors(justify);
    rect = { x: rect.x + (rect.w - w) * hx, y: rect.y + (rect.h - h) * vy, w, h };
  }
  return rect;
}

function parseAspect(text: string): number {
  if (!text) return 0;
  const parts = text.split("/");
  const a = Number(parts[0]);
  const b = parts.length > 1 ? Number(parts[1]) : 1;
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 && a > 0 ? a / b : 0;
}

function justifyFactors(justify: string): [number, number] {
  const h = justify.includes("left") ? 0 : justify.includes("right") ? 1 : 0.5;
  const v = justify.includes("top") ? 0 : justify.includes("bottom") ? 1 : 0.5;
  return [h, v];
}

function panelRect(widget: Widget, panelPad: number): Rect {
  const g = widget.geom;
  const p = panelPad < 0 ? 5 : panelPad;
  return { x: g.x + p, y: g.y + p, w: Math.max(1, g.w - 2 * p), h: Math.max(1, g.h - 2 * p) };
}

export function renderArtboard(
  doc: Doc,
  page: Page,
  registry: Registry | null,
  live: Live | null,
  view: ViewState,
): string {
  const canvas = doc.canvas;
  const cell = cellSize(canvas);
  const out: string[] = [];
  const editing = view.mode === "edit";

  out.push(
    `<rect x="0" y="0" width="${canvas.unit_w}" height="${canvas.unit_h}" ` +
      `rx="10" class="artboard-bg"/>`,
  );

  if (editing) out.push(`<path d="${gridPath(canvas.rows, canvas.cols, cell)}" class="grid"/>`);

  /* the fused surface: every visible, mergeable, snapped tile */
  const tiles: Tile[] = [];
  const visible: Widget[] = [];
  for (const widget of page.widgets ?? []) {
    const type = typeOf(registry, widget.type);
    const fed = fedSlots(widget);
    const shown = resolveSlot(widget, type, live, fed, "visible");
    if (shown === false || shown === null) continue;
    visible.push(widget);
    if (resolveSlot(widget, type, live, fed, "merge") === false) continue;
    const tile = tileOf(widget, cell);
    if (tile) tiles.push(tile);
  }
  if (tiles.length) {
    const grid: boolean[][] = Array.from({ length: canvas.rows }, () =>
      new Array(canvas.cols).fill(false),
    );
    for (const tile of tiles)
      for (let r = tile.r; r < tile.r + tile.ch && r < canvas.rows; r++)
        for (let c = tile.c; c < tile.c + tile.cw && c < canvas.cols; c++)
          if (r >= 0 && c >= 0) grid[r][c] = true;
    const occupied = (r: number, c: number) =>
      r >= 0 && c >= 0 && r < canvas.rows && c < canvas.cols && grid[r][c];
    const path = tracePath(occupied, canvas.rows, canvas.cols, cell, ISLAND_RADIUS);
    if (path) out.push(`<path d="${path}" class="island"/>`);
    const dividers = dividerPath(tiles, cell);
    if (dividers) out.push(`<path d="${dividers}" class="divider"/>`);
  }

  for (const widget of visible) {
    const type = typeOf(registry, widget.type);
    const fed = fedSlots(widget);
    const slot = (name: string) => resolveSlot(widget, type, live, fed, name);
    const enabled = slot("enabled") !== false && slot("enabled") !== null;
    const panelPad = Number(slot("panel_pad") ?? -1);
    const pad = Number(slot("pad") ?? -1);
    const radius = Number(slot("radius") ?? 8);

    out.push(`<g class="widget${enabled ? "" : " disabled"}" data-id="${widget.id}">`);
    const frame = panelRect(widget, panelPad);
    const surface = opaqueEnough(slot("surface"));
    const border = opaqueEnough(slot("border"));
    if (surface || border)
      out.push(
        `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.w)}" ` +
          `height="${num(frame.h)}" rx="${num(radius)}" fill="${surface ?? "none"}"` +
          (border ? ` stroke="${border}" stroke-width="1.5"` : "") +
          `/>`,
      );

    if (type) {
      const rect = contentRect(
        widget,
        panelPad,
        pad,
        String(slot("aspect") ?? ""),
        String(slot("justify") ?? "center"),
      );
      renderNode(type.template, rect, cellsFor(widget, type, live, view.state[widget.id] ?? {}), out);
    } else {
      out.push(
        `<text x="${num(widget.geom.x + widget.geom.w / 2)}" ` +
          `y="${num(widget.geom.y + widget.geom.h / 2)}" class="missing-type" ` +
          `text-anchor="middle" dominant-baseline="central">${escapeXml(widget.type)}?</text>`,
      );
    }
    out.push(`</g>`);
  }

  if (editing)
    for (const id of view.selection) {
      const widget = (page.widgets ?? []).find((w) => w.id === id);
      if (!widget) continue;
      const g = widget.geom;
      out.push(
        `<rect class="selection" x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" ` +
          `height="${num(g.h)}" rx="4"/>` +
          `<rect class="handle" data-handle="se" data-id="${id}" x="${num(g.x + g.w - 9)}" ` +
          `y="${num(g.y + g.h - 9)}" width="18" height="18" rx="4"/>`,
      );
    }

  return out.join("");
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
