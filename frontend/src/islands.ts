/* Merged islands: touching grid-snapped tiles fuse into one rounded surface, traced as a
 * single path by marching squares over the cell grid, with hairline dividers on shared
 * edges. Ported from the browser-only prototype (its segment and loop assembly kept
 * intact); the only change is that geometry now comes from canvas units, not a CSS grid. */

export interface Tile {
  c: number;
  r: number;
  cw: number;
  ch: number;
}

type Occupied = (r: number, c: number) => boolean;

/* one rounded path around every occupied region; `cell` is the cell size in units */
export function tracePath(
  occupied: Occupied,
  rows: number,
  cols: number,
  cell: number,
  radius: number,
): string {
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
    const edges = segments.get(key(x, y));
    if (!edges || !edges.length) return null;
    if (edges.length === 1) return edges.shift() as number[];
    const preferred = [
      [-dir[1], dir[0]],
      [dir[0], dir[1]],
      [dir[1], -dir[0]],
    ];
    for (const p of preferred) {
      const i = edges.findIndex((t) => t[0] - x === p[0] && t[1] - y === p[1]);
      if (i >= 0) return edges.splice(i, 1)[0];
    }
    return edges.shift() as number[];
  };

  const loops: number[][][] = [];
  segments.forEach((edges, k) => {
    while (edges.length) {
      const start = k.split(",").map(Number);
      const first = edges.shift() as number[];
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
    /* keep only the corners (where direction changes) */
    const corners: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n];
      const b = loop[i];
      const c = loop[(i + 1) % n];
      if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1])
        corners.push([b[0] * cell, b[1] * cell]);
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

/* hairlines on the edges two fused tiles share */
export function dividerPath(tiles: Tile[], cell: number): string {
  let d = "";
  for (const a of tiles)
    for (const b of tiles) {
      if (a === b) continue;
      if (b.c === a.c + a.cw) {
        const r0 = Math.max(a.r, b.r);
        const r1 = Math.min(a.r + a.ch, b.r + b.ch);
        if (r1 > r0) {
          const x = (a.c + a.cw) * cell;
          d += `M${x} ${r0 * cell + 6}V${r1 * cell - 6}`;
        }
      }
      if (b.r === a.r + a.ch) {
        const c0 = Math.max(a.c, b.c);
        const c1 = Math.min(a.c + a.cw, b.c + b.cw);
        if (c1 > c0) {
          const y = (a.r + a.ch) * cell;
          d += `M${c0 * cell + 6} ${y}H${c1 * cell - 6}`;
        }
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
