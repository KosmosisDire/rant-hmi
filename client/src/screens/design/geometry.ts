// Moving and scaling a diagram's shapes by hand: each shape's own attributes, rewritten while
// they are plain numbers or plain text, as a frame's x and y are.

import type { Element } from "../../protocol/Element";
import { isNumber } from "../../state/bind";

/** Where a point goes: scaled by sx and sy about (ax, ay), then moved by (dx, dy), in the
 *  diagram's units. */
export interface Reshape {
  sx: number;
  sy: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
}

export const moving = (dx: number, dy: number): Reshape => ({ sx: 1, sy: 1, ax: 0, ay: 0, dx, dy });

/** Short numbers, as a hand would write them. */
const fmt = (n: number) => String(Number(n.toFixed(2)));

/** The shape's attributes the reshape rewrites, or null when one of them is an expression,
 *  which only its author may change. A group moves by its transform and does not scale. */
export function reshape(e: Element, r: Reshape): Record<string, string> | null {
  const X = (x: number) => r.ax + (x - r.ax) * r.sx + r.dx;
  const Y = (y: number) => r.ay + (y - r.ay) * r.sy + r.dy;
  const num = (key: string, fallback = "0") => (isNumber(e.props[key] ?? fallback) ? Number(e.props[key] ?? fallback) : null);
  const text = (key: string) => {
    try {
      const v = JSON.parse(e.props[key] ?? "");
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const all = (pairs: [string, number | null][]) => (pairs.every(([, v]) => v !== null) ? Object.fromEntries(pairs.map(([k, v]) => [k, fmt(v!)])) : null);
  switch (e.tag) {
    case "circle": {
      const [cx, cy, radius] = [num("cx"), num("cy"), num("r")];
      return all([["cx", cx === null ? null : X(cx)], ["cy", cy === null ? null : Y(cy)], ["r", radius === null ? null : (radius * (Math.abs(r.sx) + Math.abs(r.sy))) / 2]]);
    }
    case "ellipse": {
      const [cx, cy, rx, ry] = [num("cx"), num("cy"), num("rx"), num("ry")];
      return all([["cx", cx === null ? null : X(cx)], ["cy", cy === null ? null : Y(cy)], ["rx", rx === null ? null : rx * Math.abs(r.sx)], ["ry", ry === null ? null : ry * Math.abs(r.sy)]]);
    }
    case "rect": {
      const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
      if (x === null || y === null || w === null || h === null) return null;
      const [x0, x1, y0, y1] = [X(x), X(x + w), Y(y), Y(y + h)];
      return all([["x", Math.min(x0, x1)], ["y", Math.min(y0, y1)], ["width", Math.abs(x1 - x0)], ["height", Math.abs(y1 - y0)]]);
    }
    case "line": {
      const [x1, y1, x2, y2] = [num("x1"), num("y1"), num("x2"), num("y2")];
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return all([["x1", X(x1)], ["y1", Y(y1)], ["x2", X(x2)], ["y2", Y(y2)]]);
    }
    case "text": {
      const [x, y, size] = [num("x"), num("y"), num("font-size", "16")];
      if (x === null || y === null || size === null) return null;
      const out = all([["x", X(x)], ["y", Y(y)]])!;
      if (r.sy !== 1 && e.props["font-size"] !== undefined) out["font-size"] = fmt(size * Math.abs(r.sy));
      return out;
    }
    case "polyline":
    case "polygon": {
      const points = text("points");
      const numbers = points?.trim().split(/[\s,]+/).map(Number);
      if (!numbers || numbers.length % 2 !== 0 || numbers.some((n) => !Number.isFinite(n))) return null;
      const moved: string[] = [];
      for (let i = 0; i < numbers.length; i += 2) moved.push(`${fmt(X(numbers[i]))},${fmt(Y(numbers[i + 1]))}`);
      return { points: JSON.stringify(moved.join(" ")) };
    }
    case "path": {
      const d = text("d");
      const out = d === null ? null : mapPath(d, r);
      return out === null ? null : { d: JSON.stringify(out) };
    }
    case "g": {
      const t = e.props.transform === undefined ? "" : text("transform");
      if (t === null || r.sx !== 1 || r.sy !== 1) return null;
      // the move goes first, so it shifts whatever the transform already does
      const lead = /^translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)\s*/.exec(t);
      const [tx, ty] = lead ? [Number(lead[1]), Number(lead[2])] : [0, 0];
      const rest = lead ? t.slice(lead[0].length) : t;
      return { transform: JSON.stringify(`translate(${fmt(tx + r.dx)} ${fmt(ty + r.dy)})${rest ? ` ${rest}` : ""}`) };
    }
    default:
      return null;
  }
}

/** How many numbers each path command takes. */
const TAKES: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Path data with every point reshaped: an absolute point maps, a relative one only scales,
 *  an arc's radii scale. Null for data it cannot read. */
function mapPath(d: string, r: Reshape): string | null {
  const X = (x: number) => r.ax + (x - r.ax) * r.sx + r.dx;
  const Y = (y: number) => r.ay + (y - r.ay) * r.sy + r.dy;
  const tokens = d.match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (!tokens) return null;
  const out: string[] = [];
  let command = "";
  let i = 0;
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) {
      command = tokens[i++];
      out.push(command);
      if (command.toLowerCase() === "z") continue;
    }
    const kind = command.toLowerCase();
    const n = TAKES[kind];
    if (!n) return null;
    const args = tokens.slice(i, i + n).map(Number);
    if (args.length < n || args.some((a) => !Number.isFinite(a))) return null;
    i += n;
    // a path's first move is from the origin, so even a relative one is a place
    const relative = command === kind && out.length > 1;
    const x = (v: number) => (relative ? v * r.sx : X(v));
    const y = (v: number) => (relative ? v * r.sy : Y(v));
    if (kind === "h") args[0] = x(args[0]);
    else if (kind === "v") args[0] = y(args[0]);
    else if (kind === "a") {
      // flags written together, as 0110, read as one number here, so leave such data be
      if (![0, 1].includes(args[3]) || ![0, 1].includes(args[4])) return null;
      [args[0], args[1]] = [args[0] * Math.abs(r.sx), args[1] * Math.abs(r.sy)];
      [args[5], args[6]] = [x(args[5]), y(args[6])];
    } else {
      for (let k = 0; k < n; k += 2) [args[k], args[k + 1]] = [x(args[k]), y(args[k + 1])];
    }
    out.push(args.map(fmt).join(" "));
    // numbers after a move without a new command are lines
    if (kind === "m") command = command === "m" ? "l" : "L";
  }
  return out.join(" ");
}
