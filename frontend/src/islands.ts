/* Merged islands: touching widgets fuse into one rounded surface, traced as a single path
 * by marching squares, with hairline dividers on the edges they share. Ported from the
 * browser-only prototype (its segment and loop assembly kept intact).
 *
 * The prototype walked the CELL grid, so only grid-snapped tiles could fuse. Here the grid
 * is the widgets' own edges instead (coordinate compression: every distinct x and y edge
 * becomes a line, and a cell is occupied when its centre falls inside some widget), so the
 * union is exact for arbitrary rectangles and a free-placed widget merges like any other.
 * The grid stays small: at most (2n+1) lines per axis for n widgets. */

import { Rect } from "./template.js";

const EDGE_EPS = 0.25;

type Occupied = (r: number, c: number) => boolean;
type Axis = (index: number) => number;

function edges(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted)
    if (!out.length || value - out[out.length - 1] > EDGE_EPS) out.push(value);
  return out;
}

/* one rounded path around every occupied region */
function trace(occupied: Occupied, rows: number, cols: number, px: Axis, py: Axis, radius: number): string {
  const segments = new Map<string, number[][]>();
  const key = (x: number, y: number) => x + "," + y;
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    const k = key(x1, y1);
    if (!segments.has(k)) segments.set(k, []);
    (segments.get(k) as number[][]).push([x2, y2]);
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!occupied(r, c)) continue;
      if (!occupied(r - 1, c)) addEdge(c, r, c + 1, r);
      if (!occupied(r, c + 1)) addEdge(c + 1, r, c + 1, r + 1);
      if (!occupied(r + 1, c)) addEdge(c + 1, r + 1, c, r + 1);
      if (!occupied(r, c - 1)) addEdge(c, r + 1, c, r);
    }

  const takeEdge = (x: number, y: number, dir: number[]): number[] | null => {
    const list = segments.get(key(x, y));
    if (!list || !list.length) return null;
    if (list.length === 1) return list.shift() as number[];
    const preferred = [
      [-dir[1], dir[0]],
      [dir[0], dir[1]],
      [dir[1], -dir[0]],
    ];
    for (const p of preferred) {
      const i = list.findIndex((t) => t[0] - x === p[0] && t[1] - y === p[1]);
      if (i >= 0) return list.splice(i, 1)[0];
    }
    return list.shift() as number[];
  };

  const loops: number[][][] = [];
  segments.forEach((list, k) => {
    while (list.length) {
      const start = k.split(",").map(Number);
      const first = list.shift() as number[];
      let dir = [first[0] - start[0], first[1] - start[1]];
      let cur = first;
      const loop = [start, first];
      let guard = 0;
      while (!(cur[0] === start[0] && cur[1] === start[1]) && guard++ < 5000) {
        const next = takeEdge(cur[0], cur[1], dir);
        if (!next) break;
        dir = [next[0] - cur[0], next[1] - cur[1]];
        loop.push(next);
        cur = next;
      }
      if (cur[0] === start[0] && cur[1] === start[1]) loop.pop();
      loops.push(loop);
    }
  });

  let path = "";
  for (const loop of loops) {
    const n = loop.length;
    if (n < 4) continue;
    /* keep only the corners (where direction changes), in real coordinates */
    const corners: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n];
      const b = loop[i];
      const c = loop[(i + 1) % n];
      if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1])
        corners.push([px(b[0]), py(b[1])]);
    }
    const m = corners.length;
    if (m < 3) continue;
    let d = "";
    for (let i = 0; i < m; i++) {
      const p0 = corners[(i - 1 + m) % m];
      const p1 = corners[i];
      const p2 = corners[(i + 1) % m];
      const v1x = p1[0] - p0[0];
      const v1y = p1[1] - p0[1];
      const v2x = p2[0] - p1[0];
      const v2y = p2[1] - p1[1];
      const l1 = Math.hypot(v1x, v1y) || 1;
      const l2 = Math.hypot(v2x, v2y) || 1;
      const rr = Math.min(radius, l1 / 2, l2 / 2);
      const ax = p1[0] - (v1x / l1) * rr;
      const ay = p1[1] - (v1y / l1) * rr;
      const bx = p1[0] + (v2x / l2) * rr;
      const by = p1[1] + (v2y / l2) * rr;
      d +=
        (i === 0 ? `M${ax.toFixed(1)} ${ay.toFixed(1)}` : `L${ax.toFixed(1)} ${ay.toFixed(1)}`) +
        ` Q${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)} `;
    }
    path += d + "Z ";
  }
  return path;
}

/* the fused outline of these rectangles, wherever they sit */
export function unionPath(rects: Rect[], radius: number): string {
  if (!rects.length) return "";
  const xs = edges(rects.flatMap((r) => [r.x, r.x + r.w]));
  const ys = edges(rects.flatMap((r) => [r.y, r.y + r.h]));
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  if (cols < 1 || rows < 1) return "";

  const grid: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (let r = 0; r < rows; r++) {
    const cy = (ys[r] + ys[r + 1]) / 2;
    for (let c = 0; c < cols; c++) {
      const cx = (xs[c] + xs[c + 1]) / 2;
      grid[r][c] = rects.some(
        (rect) => cx > rect.x && cx < rect.x + rect.w && cy > rect.y && cy < rect.y + rect.h,
      );
    }
  }
  const occupied = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < rows && c < cols && grid[r][c];
  return trace(occupied, rows, cols, (i) => xs[i], (i) => ys[i], radius);
}

/* hairlines on the edges two fused widgets share */
export function dividerPath(rects: Rect[]): string {
  const touching = (a: number, b: number) => Math.abs(a - b) <= EDGE_EPS;
  const inset = 6;
  let d = "";
  for (const a of rects)
    for (const b of rects) {
      if (a === b) continue;
      if (touching(b.x, a.x + a.w)) {
        const top = Math.max(a.y, b.y) + inset;
        const bottom = Math.min(a.y + a.h, b.y + b.h) - inset;
        if (bottom > top) d += `M${b.x.toFixed(1)} ${top.toFixed(1)}V${bottom.toFixed(1)}`;
      }
      if (touching(b.y, a.y + a.h)) {
        const left = Math.max(a.x, b.x) + inset;
        const right = Math.min(a.x + a.w, b.x + b.w) - inset;
        if (right > left) d += `M${left.toFixed(1)} ${b.y.toFixed(1)}H${right.toFixed(1)}`;
      }
    }
  return d;
}

/* the faint edit-mode grid: a cross at every cell intersection */
export function gridPath(rows: number, cols: number, cell: number): string {
  let d = "";
  for (let c = 1; c < cols; c++)
    for (let r = 1; r < rows; r++) {
      const x = c * cell;
      const y = r * cell;
      d += `M${x - 3} ${y}h6M${x} ${y - 3}v6`;
    }
  return d;
}
