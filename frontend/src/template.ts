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
    out.push(
      `<rect x="${n(rect.x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ` +
        `rx="${n(Math.min(radius, Math.min(w, h) / 2))}" fill="${fill}"/>`,
    );
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
  const aspect = attrNum(attr(attrs, "aspect", cells), 0);
  if (aspect > 0) area = fitAspect(area, aspect);
  const pad = attrNum(attr(attrs, "pad", cells), 0);
  if (pad > 0) area = inset(area, pad * Math.min(area.w, area.h));

  if (node.kind === "part") {
    switch (node.draw) {
      case "rect": drawRect(area, attrs, cells, out); return;
      case "bar": drawBar(area, attrs, cells, out); return;
      case "text": drawText(area, attrs, cells, out); return;
      case "icon": drawIcon(area, attrs, cells, out); return;
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
