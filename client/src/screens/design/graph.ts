// Where each page sits on the board: a tree down from the start page, each page under the first
// page that leads to it, and each page the start cannot reach heading a tree of its own to the
// right, in the pages' order.

import type { Page } from "../../protocol/Page";
import type { Link } from "../../state/links";

export interface Spot {
  x: number;
  y: number;
}

/** Each page's corner on the board, in units: `gap` apart in a row, `rows` between rows, twice `gap` between trees. */
export function layOut(pages: Page[], links: Link[], start: string | undefined, gap: number, rows: number): Record<string, Spot> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const next = new Map<string, string[]>();
  for (const l of links) if (byId.has(l.from) && byId.has(l.to)) next.set(l.from, [...new Set([...(next.get(l.from) ?? []), l.to])]);
  const placed = new Set<string>();
  const at: Record<string, Spot> = {};
  let left = 0;
  for (const root of [...(start && byId.has(start) ? [start] : []), ...pages.map((p) => p.id)]) {
    if (placed.has(root)) continue;
    // the tree a breadth first walk from the root makes, each page under the first to reach it
    const under = new Map<string, string[]>();
    const depth = new Map([[root, 0]]);
    placed.add(root);
    for (const queue = [root]; queue.length > 0; ) {
      const id = queue.shift()!;
      const kids = (next.get(id) ?? []).filter((k) => !placed.has(k));
      kids.forEach((k) => (placed.add(k), depth.set(k, depth.get(id)! + 1), queue.push(k)));
      under.set(id, kids);
    }
    // each row as tall as its tallest page
    const tall: number[] = [];
    for (const [id, d] of depth) tall[d] = Math.max(tall[d] ?? 0, byId.get(id)!.height);
    const top = tall.map((_, d) => tall.slice(0, d).reduce((a, h) => a + h + rows, 0));
    const width = new Map<string, number>();
    const span = (id: string): number => {
      const kids = under.get(id) ?? [];
      const w = Math.max(byId.get(id)!.width, kids.reduce((a, k) => a + span(k), 0) + gap * Math.max(0, kids.length - 1));
      width.set(id, w);
      return w;
    };
    // a page sits in the middle of the room its tree takes, what it leads to spread under it
    const place = (id: string, from: number) => {
      const w = width.get(id)!;
      at[id] = { x: Math.round(from + (w - byId.get(id)!.width) / 2), y: top[depth.get(id)!] };
      const kids = under.get(id) ?? [];
      let x = from + (w - (kids.reduce((a, k) => a + width.get(k)!, 0) + gap * Math.max(0, kids.length - 1))) / 2;
      for (const k of kids) {
        place(k, x);
        x += width.get(k)! + gap;
      }
    };
    span(root);
    place(root, left);
    left += width.get(root)! + gap * 2;
  }
  return at;
}
