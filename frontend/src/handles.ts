/* THE SELECTION HANDLES over a child of a FREE frame: the old designer's box, brought
 * back over real DOM. One ring on the box's own line, four edge pills, and four corner
 * brackets whose L traces the ring's own corner arc — a grip never floats off the line it
 * belongs to. Everything visible ignores the pointer; only the invisible .sel-hit rects
 * take it, so the page under the overlay keeps its own hover and click.
 *
 * Ported from the deleted canvas.ts overlay (12880cf~1) at unit = 1: there is no camera
 * any more, so a CSS pixel is a screen pixel and nothing needs dividing by a view scale.
 * The geometry constants are the old designer's, which is the point. */

import { FREE_HANDLES, FreeHandle } from "./arrange.js";

/* how far the overlay extends past the box it rings: room for the grips' own bodies and
   for the 12px hit strips centred on the edges */
export const HANDLE_MARGIN = 12;

const CURSOR: Record<string, string> = {
  L: "ew-resize", R: "ew-resize", T: "ns-resize", B: "ns-resize",
  TL: "nwse-resize", BR: "nwse-resize", TR: "nesw-resize", BL: "nesw-resize",
};

export function handleCursor(handle: FreeHandle): string {
  return CURSOR[handle] ?? "move";
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/* the ring radius: the old fused-island rounding, capped so a tiny selection rounds fully */
function ringRadius(w: number, h: number): number {
  return Math.min(16, w / 2, h / 2);
}

function hitRect(x: number, y: number, w: number, h: number,
                 handle: string, cursor: string): string {
  return (
    `<rect class="sel-hit" data-handle="${handle}" x="${num(x)}" y="${num(y)}" ` +
    `width="${num(w)}" height="${num(h)}" fill="rgba(0,0,0,0)" style="cursor:${cursor}"/>`
  );
}

/* The whole overlay for a w-by-h box, drawn inside a viewport inset by HANDLE_MARGIN on
 * every side. A handle in `off` is still DRAWN — the affordance says "there is a handle
 * here" — but dimmed and without a hit rect: its field holds authored logic, and direct
 * manipulation writes constants, never over an expression. */
export function handleMarkup(w: number, h: number, off: Set<FreeHandle>): string {
  const box = { x: HANDLE_MARGIN, y: HANDLE_MARGIN, w, h };
  const radius = ringRadius(w, h);
  const out: string[] = [];

  out.push(
    `<rect class="sel-ring" stroke-width="2" x="${num(box.x)}" y="${num(box.y)}" ` +
    `width="${num(box.w)}" height="${num(box.h)}" rx="${num(radius)}"/>`,
  );

  /* edge pills and corner brackets, straddling the ring's centreline exactly as the old
     designer did: line 2, so the centreline sits half a line outside the box edge */
  const line = 2;
  const offset = line / 2;
  const pill = 4;
  const grab = 12;
  const vlen = Math.min(28, Math.max(8, box.h - 2 * radius - 6));
  const hlen = Math.min(28, Math.max(8, box.w - 2 * radius - 6));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const bar = (handle: FreeHandle, x: number, y: number, bw: number, bh: number) => {
    const disabled = off.has(handle);
    out.push(
      `<rect class="sel-grip${disabled ? " off" : ""}" x="${num(x)}" y="${num(y)}" ` +
      `width="${num(bw)}" height="${num(bh)}" rx="${num(Math.min(bw, bh) / 2)}"/>`,
    );
    if (disabled) return;
    const hw = Math.max(bw, grab);
    const hh = Math.max(bh, grab);
    out.push(hitRect(x + bw / 2 - hw / 2, y + bh / 2 - hh / 2, hw, hh, handle, CURSOR[handle]));
  };
  bar("L", box.x - offset - pill / 2, cy - vlen / 2, pill, vlen);
  bar("R", box.x + box.w - offset - pill / 2 + line, cy - vlen / 2, pill, vlen);
  bar("T", cx - hlen / 2, box.y - offset - pill / 2, hlen, pill);
  bar("B", cx - hlen / 2, box.y + box.h - offset - pill / 2 + line, hlen, pill);

  /* corner brackets: an L that follows the ring's arc, then a short straight arm */
  const arm = 5;
  const rc = radius + offset;
  const corner = (handle: FreeHandle, sx: number, sy: number, dx: number, dy: number) => {
    /* start on the horizontal run, arc through the corner, end on the vertical run */
    const hx = sx + dx * (radius + arm);
    const hy = sy - dy * offset;
    const ax = sx + dx * radius;
    const ay = sy - dy * offset;
    const bx = sx - dx * offset;
    const by = sy + dy * radius;
    const vx = sx - dx * offset;
    const vy = sy + dy * (radius + arm);
    const sweep = dx * dy > 0 ? 0 : 1;
    const disabled = off.has(handle);
    out.push(
      `<path class="sel-arc${disabled ? " off" : ""}" stroke-width="4" ` +
      `d="M${num(hx)} ${num(hy)} L${num(ax)} ${num(ay)} ` +
      `A${num(rc)} ${num(rc)} 0 0 ${sweep} ${num(bx)} ${num(by)} L${num(vx)} ${num(vy)}"/>`,
    );
    if (disabled) return;
    out.push(hitRect(
      Math.min(hx, vx, sx) - grab / 2,
      Math.min(hy, vy, sy) - grab / 2,
      Math.abs(hx - vx) + grab,
      Math.abs(hy - vy) + grab,
      handle,
      CURSOR[handle],
    ));
  };
  corner("TL", box.x, box.y, 1, 1);
  corner("TR", box.x + box.w, box.y, -1, 1);
  corner("BL", box.x, box.y + box.h, 1, -1);
  corner("BR", box.x + box.w, box.y + box.h, -1, -1);

  return out.join("");
}

/* the disabled set, straight off the per-handle legality the arithmetic decides */
export function handlesOff(allowed: (handle: FreeHandle) => boolean): Set<FreeHandle> {
  return new Set(FREE_HANDLES.filter((handle) => !allowed(handle)));
}
