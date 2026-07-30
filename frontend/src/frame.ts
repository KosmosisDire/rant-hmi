/* The frame/layout placement resolver (spec 2.8): a pure function of a frame (or a page,
 * which behaves like an implicit `layout:"none"` frame the size of the canvas) and its
 * own resolved rect, returning where each child lands in ABSOLUTE canvas units.
 *
 * This is deliberately its own module, not a few lines inlined into canvas.ts, because
 * docs/proto/procedural-ui.md's node model (2.2 `frame`, 2.4 auto-layout) puts the SAME
 * rule one level down, inside a component's own template tree, once that phase lands.
 * Sharing this module then costs nothing but an import; duplicating the maths would
 * mean two placement rules quietly drifting apart. To stay reusable it knows nothing
 * about pages, the document store, selection or any other editor state — only the
 * shape of a node that can hold children and lay them out.
 *
 * The placement rule itself (spec 2.8 "Layout"):
 *   - `layout: "none"` (a page, or a plain group): every child keeps its AUTHORED geom,
 *     translated into the parent's absolute origin (a child's geom is in its PARENT's
 *     coordinates — moving a frame moves its children for free, no op written to them).
 *   - `layout: "row" | "col"`: children flow in document order along the main axis,
 *     starting at `pad`, separated by `gap`, inside the frame's `pad` on all four
 *     sides. The child's authored MAIN-axis size is kept (no weights — weights are
 *     exactly what this design replaces). The cross axis is set by `align`: start/
 *     center/end keep the child's authored cross size and position it in the padded
 *     box; `stretch` fills the padded box on that axis.
 * Layout is resolved HERE, at render time, and never writes an op: the authored geom
 * stays whatever the user set, a laid-out child simply paints where the flow puts it. */

import { Rect } from "./template.js";
import { Frame, Widget } from "./types.js";

export interface Placed {
  node: Frame | Widget;
  rect: Rect;               /* ABSOLUTE canvas units */
}

/* A page and a frame both hold ordered (Frame | Widget) children, but a page carries no
 * layout fields at all (it is always an implicit "none" group the size of the canvas).
 * Structural rather than nominal so a Page value needs no adapting to call resolveTree. */
export interface LayoutHost {
  children: (Frame | Widget)[];
  layout?: "none" | "row" | "col";
  gap?: number;
  pad?: number;
  align?: "start" | "center" | "end" | "stretch";
}

export function isFrame(node: Frame | Widget): node is Frame {
  return node.kind === "frame";
}

/* One level: `host`'s own children, placed inside `rect` (host's own resolved ABSOLUTE
 * rect — the caller already knows it: a page IS the canvas rect, a frame's rect came
 * from its own parent's placeChildren). */
export function placeChildren(host: LayoutHost, rect: Rect): Placed[] {
  const children = host.children ?? [];
  const layout = host.layout ?? "none";
  if (layout === "none")
    return children.map((node) => ({
      node,
      rect: { x: rect.x + node.geom.x, y: rect.y + node.geom.y, w: node.geom.w, h: node.geom.h },
    }));

  const row = layout === "row";
  const pad = host.pad ?? 0;
  const gap = host.gap ?? 0;
  const align = host.align ?? "start";
  const boxX = rect.x + pad;
  const boxY = rect.y + pad;
  const boxW = Math.max(0, rect.w - 2 * pad);
  const boxH = Math.max(0, rect.h - 2 * pad);
  const crossBox = row ? boxH : boxW;

  let main = row ? boxX : boxY;
  const out: Placed[] = [];
  for (const node of children) {
    const mainSize = row ? node.geom.w : node.geom.h;
    const crossSize = row ? node.geom.h : node.geom.w;
    let crossOut: number;
    let crossAt: number;
    if (align === "stretch") {
      crossOut = crossBox;
      crossAt = row ? boxY : boxX;
    } else {
      crossOut = crossSize;
      const free = crossBox - crossSize;
      const at = align === "center" ? free / 2 : align === "end" ? free : 0;
      crossAt = (row ? boxY : boxX) + at;
    }
    out.push({
      node,
      rect: row
        ? { x: main, y: crossAt, w: mainSize, h: crossOut }
        : { x: crossAt, y: main, w: crossOut, h: mainSize },
    });
    main += mainSize + gap;
  }
  return out;
}

/* The whole subtree under `host`, flattened to absolute rects in PAINT order: each child
 * is emitted, then its own descendants immediately after it, so a frame is followed by
 * everything inside it and later siblings paint over earlier ones. A frame paints nothing
 * itself, so this pre-order walk IS draw order. `host` is never in the result: only its
 * descendants, which is what a page's paint pass and the selection overlay both want. */
export function resolveTree(host: LayoutHost, rect: Rect): Placed[] {
  const out: Placed[] = [];
  const walk = (at: LayoutHost, atRect: Rect) => {
    for (const placed of placeChildren(at, atRect)) {
      out.push(placed);
      if (isFrame(placed.node)) walk(placed.node, placed.rect);
    }
  };
  walk(host, rect);
  return out;
}
