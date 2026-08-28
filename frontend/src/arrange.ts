/* WHERE A DRAGGED NODE WOULD LAND, AND WHAT MOVING OR RESIZING ONE WRITES: all of direct
 * manipulation's arithmetic, and none of its DOM.
 *
 * The Layers tree drag reads geometry (which row the pointer is over, how far down it) and
 * hands the numbers here; the stage gestures read their own (where a box stands, how far
 * the pointer travelled in canvas px) and hand them to the same rules. Everything from
 * there — which parent, which index, which constants a release writes, and whether any of
 * it is legal — is decided by this file against the document alone. That split is
 * deliberate: layout is the browser's and cannot be asserted headlessly, while these rules
 * are exactly the ones that make dragging feel right or maddening, so they belong where a
 * test can reach them (test/view_test.mjs). */

import { CELL, isInstance, Node, Page } from "./types.js";

export type Zone = "before" | "after" | "into";

/* Can this node hold a child at all? A frame can, and an INSTANCE cannot: what is inside
 * one belongs to the component it names. One question, asked by the drop arithmetic, by
 * the tree's zone split and by the stage's container search, so a drag can never be shown
 * a target the document would refuse. */
export function holds(node: Node | null | undefined): boolean {
  return !!node && node.kind === "frame" && !isInstance(node);
}

/* the parent to insert into and the index to insert AT, in the op's own terms */
export interface DropPlan {
  parent: number;
  index: number;
}

/* A FIELD A GESTURE MAY MOVE. Every field is expression text, and direct manipulation is
 * the act of writing a CONSTANT into one — so a drag may only move a field that holds a
 * constant NOW. `12` is a number a boundary can push around; `value.Pick(2, 1)` is authored
 * logic, and a drag that overwrote it would be destroying work to save a keystroke. An
 * absent field reads as its default, which is a constant too.
 *
 * Returns null for "there is an expression here": the caller's cue to leave the handle out
 * rather than to write anyway. */
export function literalNumber(text: string | undefined, fallback: number): number | null {
  if (text === undefined || text === null || text === "") return fallback;
  const trimmed = String(text).trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

/* The zone the pointer names, from the row's own proportions. A frame row has a middle that
 * means INSIDE; an instance row has no inside, so its whole height splits at the halfway mark
 * and every position names a gap. `ratio` is 0 at the row's top edge and 1 at its bottom. */
export function dropZone(isFrame: boolean, ratio: number): Zone {
  if (!isFrame) return ratio < 0.5 ? "before" : "after";
  if (ratio < 0.3) return "before";
  if (ratio > 0.7) return "after";
  return "into";
}


export interface Seat {
  node: Node;
  parent: number;
  siblings: Node[];
  index: number;
}

/* where one id sits on the page: its parent's id (the page's, at the top level), the list it
 * is in and its position in it. The list is the LIVE array, which is what lets the stage's
 * preview splice a cloned page with the same lookup the plans are made from. */
export function seatOf(page: Page, id: number): Seat | null {
  const walk = (parent: number, siblings: Node[]): Seat | null => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      if (node.id === id) return { node, parent, siblings, index: i };
      if (node.kind === "frame") {
        const found = walk(node.id, node.children ?? []);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(page.id, page.children ?? []);
}

/* is `id` the node itself or anything under it? The drop parent is walked up to the page, so
 * one frame can never be dropped inside its own subtree — the branch would leave with it. */
function within(page: Page, id: number, ancestor: number): boolean {
  for (let at = id; at !== page.id; ) {
    if (at === ancestor) return true;
    const seat = seatOf(page, at);
    if (!seat) return false;
    at = seat.parent;
  }
  return ancestor === page.id;
}

/* Append to the very end of the page: what the empty space under the last row means. */
export function dropAtPageEnd(page: Page, dragId: number): DropPlan | null {
  return settle(page, dragId, { parent: page.id, index: (page.children ?? []).length });
}

/* Where `dragId` lands if it is released over `targetId` in `zone`, or null when that drop is
 * not one the document allows (or would not move anything). `open` says the target row is an
 * EXPANDED frame, which is a fact about the view rather than the document and so has to be
 * told: it decides what the gap under that row means. */
export function dropPlan(
  page: Page,
  dragId: number,
  targetId: number,
  zone: Zone,
  open = false,
): DropPlan | null {
  if (dragId === targetId) return null;
  if (!seatOf(page, dragId)) return null;

  if (targetId === page.id) return dropAtPageEnd(page, dragId);
  const target = seatOf(page, targetId);
  if (!target) return null;
  /* WHAT CAN HOLD A CHILD: a frame, and not an instance. An instance's subtree belongs to
     the component it names — dropping into one would put a node somewhere no editor shows
     — which is the same refusal the backend's move op makes, said here so the drag can
     show it rather than discovering it on release. */
  const kids = holds(target.node) ? target.node.children ?? [] : null;

  if (zone === "into") {
    if (!kids) return null;
    return settle(page, dragId, { parent: targetId, index: kids.length });
  }
  /* the gap under an OPEN frame row is the gap ABOVE its first child: that is the one the
     eye sees between those two rows, and pointing it past the whole subtree instead is what
     makes tree dragging feel like it is fighting you */
  if (zone === "after" && kids && kids.length && open)
    return settle(page, dragId, { parent: targetId, index: 0 });
  return settle(page, dragId, {
    parent: target.parent,
    index: target.index + (zone === "after" ? 1 : 0),
  });
}

/* The two rules that turn a raw position into an op: the legality walk, and the shift the
 * server's own erase-then-insert order imposes. Every drag ends here — the tree's rows and
 * the stage's gaps both — so there is one answer to what a drop means and one place it is
 * refused. */
export function settle(page: Page, dragId: number, raw: DropPlan): DropPlan | null {
  const drag = seatOf(page, dragId);
  if (!drag) return null;
  /* into itself, or into anything it holds */
  if (within(page, raw.parent, dragId)) return null;
  /* into something that cannot hold a child: a leaf, or an INSTANCE, whose subtree belongs
     to the component it names. Asked HERE, where every drop passes, rather than only where
     the tree asks it — the stage aims by pointer and would otherwise find the inside of a
     instance a perfectly good target. */
  if (raw.parent !== page.id && !holds(seatOf(page, raw.parent)?.node)) return null;

  /* THE SERVER ERASES FIRST: by the time it inserts, the list it is inserting into is the
     list without the dragged node. So a move further down its OWN list lands one short of
     where it was pointed — children [A,B,C] with A dropped after B is index 1, because the
     list being inserted into is [B,C]. */
  let index = raw.index;
  if (raw.parent === drag.parent && drag.index < index) index -= 1;

  if (raw.parent === drag.parent && index === drag.index) return null;   /* it is already there */
  return { parent: raw.parent, index };
}

/* ---- moving and resizing on the artboard: canvas px, snapped to the one grid ----
 *
 * Everything on a page is in MEASUREMENT space: x/y/w/h are canvas px relative to the
 * parent's origin, and `originX`/`originY` name the point x/y places (fractions of the
 * node's own box). The gestures are the old designer's — grab the body to move, grab an
 * edge pill or a corner bracket to resize — and their whole output is a handful of
 * constants written back into those fields, exactly what the inspector would have
 * written by hand.
 *
 * THE GRID IS GLOBAL: one 22px cell everywhere on the artboard, so what snaps together
 * stays together whatever group either box happens to live in — which is why the snap
 * runs in ARTBOARD coordinates (`base` is the parent's own artboard origin) and only
 * then comes back to the parent-relative number the document stores. The edge being
 * dragged is what lands on a line, and Alt suspends the snap for the length of the
 * press. */

export function snapPx(value: number): number {
  return Math.round(value / CELL) * CELL;
}

/* the TEXT a gesture writes: whole px — the grid is 22s, and sub-pixel positions are
   noise no one authored */
export function fmtPx(value: number): string {
  return String(Math.round(value));
}

/* the TEXT a gesture writes INSIDE A COMPONENT: a fraction of the parent's box, at most
   4 decimals — a ten-thousandth of the box is below anything a pointer said, and the
   rounding keeps float tails out of the document */
export function fmtFraction(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

/* one of the box fields, resolved for a gesture */
export interface FreeField {
  value: number;      /* the canvas px actually showing */
  literal: boolean;   /* the doc holds a constant (or nothing): a gesture may write it */
  present: boolean;   /* the doc says anything at all: an axis with neither field is
                         STRETCHED, and a write on it must pin what the stretch was giving */
}

export interface FreeBox {
  /* the doc's `left`/`top`: the ORIGIN POINT while the far edge is free, the plain near
     edge once `right`/`bottom` pins it (place() applies no origin shift on such an axis) */
  left: FreeField;
  top: FreeField;
  /* the far edges, as px INSETS from the parent's far edges — present means the axis is
     sized or anchored by them */
  right: FreeField;
  bottom: FreeField;
  w: FreeField;
  h: FreeField;
  ox: number;
  oy: number;
  /* the parent's own box in px: what an inset measures from, and what a write to one
     converts back through */
  span: { w: number; h: number };
  /* the size `aspect` derives — authored on the other axis only — which no resize may
     write; null when aspect is absent or inert (both sizes authored, or neither) */
  derived: "w" | "h" | null;
  /* a rotated node's screen box is an axis-aligned reading of a tilted thing: it still
     MOVES point-for-point with the pointer, but a resize written through it would lie */
  rotated: boolean;
}

/* the box as it stands on screen, in canvas px relative to the parent's origin: VISUAL
   edges, which are the only truth for a field the document holds no number for */
export interface MeasuredBox {
  left: number;
  top: number;
  w: number;
  h: number;
}

/* The document's box fields against the measured picture. SIZE resolves before POSITION
 * — `left` places the origin point, so reading it off the screen goes through w — the
 * same order the renderer solves in. Null when `originX`/`originY` hold expressions:
 * the origin converts between the box's edges and the doc's left/top, and an expression
 * there leaves nothing a gesture can safely write through.
 *
 * `scale` converts a FRACTION-space document (a component's internals) into the px the
 * plan's arithmetic runs in: a doc literal is multiplied by the parent's rendered size on
 * its axis, so the whole gesture thinks in artboard px and only the commit divides back.
 * On a page the scale is 1 and a literal is already the px it says. `span` is the
 * parent's own px box, which is what an authored `right`/`bottom` inset measures from. */
export function freeBoxOf(node: Node | null | undefined, measured: MeasuredBox,
                          scale: { x: number; y: number } = { x: 1, y: 1 },
                          span: { w: number; h: number } = { w: 0, h: 0 }): FreeBox | null {
  if (!node) return null;
  const attrs = node.attrs ?? {};
  const field = (key: string, fallback: number, k: number): FreeField => {
    const text = attrs[key];
    const present = text !== undefined && text !== null && String(text).trim() !== "";
    const lit = literalNumber(text, fallback);
    return { value: lit !== null ? (present ? lit * k : fallback) : fallback,
             literal: lit !== null, present };
  };
  const ox = literalNumber(attrs.originX, 0);
  const oy = literalNumber(attrs.originY, 0);
  if (ox === null || oy === null) return null;
  const w = field("w", measured.w, scale.x);
  const h = field("h", measured.h, scale.y);
  const right = field("right", span.w - (measured.left + measured.w), scale.x);
  const bottom = field("bottom", span.h - (measured.top + measured.h), scale.y);
  /* with BOTH edges authored the size is theirs and a written `w` is inert — the screen
     is the truth of what the axis spans, whatever dead number the doc still carries */
  if (attrs.left !== undefined && String(attrs.left).trim() !== "" && right.present)
    w.value = measured.w;
  if (attrs.top !== undefined && String(attrs.top).trim() !== "" && bottom.present)
    h.value = measured.h;
  /* a pinned far edge takes the origin point with it: the doc's `left` is then the plain
     near edge, so the measured edge IS its fallback */
  const left = field("left", measured.left + (right.present ? 0 : ox * w.value), scale.x);
  const top = field("top", measured.top + (bottom.present ? 0 : oy * h.value), scale.y);
  /* aspect pins one size to the other. Only the one-authored-size case DERIVES: with both
     written aspect is inert, and with neither the axis insets win. An expression counts —
     whatever it evaluates to is still a lock. (When the derived axis is ALSO stretched by
     absent position the insets win over the ratio; the gesture stays conservative and
     offers nothing there rather than writing through an ambiguity.) */
  const aspect = attrs.aspect !== undefined && String(attrs.aspect ?? "").trim() !== "";
  const derived = aspect && w.present !== h.present ? (w.present ? "h" : "w") : null;
  const rotate = literalNumber(attrs.rotate, 0);
  return { left, top, right, bottom, w, h, ox, oy, span, derived,
           rotated: rotate === null || rotate !== 0 };
}

export type FreeHandle = "move" | "L" | "R" | "T" | "B" | "TL" | "TR" | "BL" | "BR";

export const FREE_HANDLES: FreeHandle[] = ["L", "R", "T", "B", "TL", "TR", "BL", "BR"];

/* May this handle be offered at all? A handle is a promise to write constants into the
 * fields its drag moves, so a field holding an EXPRESSION takes the handle away — drawn
 * disabled rather than silently overwriting authored logic. Which fields an edge moves
 * depends on how the axis is authored: with a far edge pinned, the R grip writes `right`
 * (and `w` where the box anchors right) and the L grip writes `left` (or `w` where only
 * the far edge is authored); with the far edge free the grips write left/w through the
 * origin exactly as before — asked exactly, so a plain box (origin 0) keeps its right
 * and bottom grips even when its position is authored logic. */
export function freeAllowed(box: FreeBox | null, handle: FreeHandle): boolean {
  if (!box) return false;
  /* a move slides every present position field on an axis together, so each must be a
     constant (an absent one reads as its default, which is constant too) */
  if (handle === "move")
    return (box.left.literal && box.right.literal) ||
           (box.top.literal && box.bottom.literal);
  if (box.rotated) return false;
  const xOk = (edge: "L" | "R") => {
    if (box.derived === "w") return false;
    if (box.right.present) {
      if (edge === "R") return box.right.literal && (box.left.present || box.w.literal);
      return box.left.present ? box.left.literal : box.w.literal;
    }
    return box.w.literal && ((edge === "L" ? box.ox === 1 : box.ox === 0) || box.left.literal);
  };
  const yOk = (edge: "T" | "B") => {
    if (box.derived === "h") return false;
    if (box.bottom.present) {
      if (edge === "B") return box.bottom.literal && (box.top.present || box.h.literal);
      return box.top.present ? box.top.literal : box.h.literal;
    }
    return box.h.literal && ((edge === "T" ? box.oy === 1 : box.oy === 0) || box.top.literal);
  };
  const horizontal = handle.includes("L") ? xOk("L") : handle.includes("R") ? xOk("R") : null;
  const vertical = handle.includes("T") ? yOk("T") : handle.includes("B") ? yOk("B") : null;
  /* a corner on an aspect-locked box still resizes: it drags the authored axis and the
     ratio brings the other, so the derived axis drops out of the requirement */
  if (horizontal !== null && vertical !== null) {
    if (box.derived === "h") return horizontal;
    if (box.derived === "w") return vertical;
    return horizontal && vertical;
  }
  return horizontal ?? vertical ?? false;
}

/* what a free gesture is showing or writing, in ATTR space: the same numbers place()
   turns into the element's left/top/right/bottom/width/height */
export interface FreeWrite {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  w?: number;
  h?: number;
}

export interface FreePlan {
  /* live, per pointer move: every field the picture needs, unchanged values included */
  apply(dx: number, dy: number, snap: boolean): FreeWrite;
  /* on release: only the fields the document must now carry */
  commit(dx: number, dy: number, snap: boolean): FreeWrite;
}

/* the smallest box a resize may leave, in canvas px: graspable rather than gone. The
   inspector can still type an extreme; a gesture may not produce one by accident. */
const MIN_FREE_PX = 8;
/* two positions this close are the same number: a commit never writes noise */
const FREE_EPS = 1e-3;

/* `dx`/`dy` are the pointer's travel in CANVAS px (the caller has already divided the
 * screen by the camera); `base` is the parent's own origin on the artboard, which is what
 * lets a parent-relative number snap to the GLOBAL grid. Everything is derived from ONE
 * measurement at the press, so the gesture never chases its own output. */
export function freePlan(handle: FreeHandle, box: FreeBox | null,
                         base: { x: number; y: number }): FreePlan | null {
  if (!box || !freeAllowed(box, handle)) return null;
  /* the near edge in px: with the far edge pinned the doc's left/top IS the edge (no
     origin shift rides such an axis), otherwise the origin algebra converts */
  const oxEff = box.right.present ? 0 : box.ox;
  const oyEff = box.bottom.present ? 0 : box.oy;
  const left = box.left.value - oxEff * box.w.value;
  const top = box.top.value - oyEff * box.h.value;
  const snapX = (value: number, on: boolean) => (on ? snapPx(base.x + value) - base.x : value);
  const snapY = (value: number, on: boolean) => (on ? snapPx(base.y + value) - base.y : value);
  /* a write is only a write when the number moved */
  const changed = (next: number, was: number) => Math.abs(next - was) > FREE_EPS;

  if (handle === "move") {
    /* an axis whose position is authored logic simply does not move: the gesture is
       locked to the writable one rather than refused outright */
    const xMove = box.left.literal && box.right.literal;
    const yMove = box.top.literal && box.bottom.literal;
    /* the edge that carries the AUTHORED number is the one that lands on the grid: the
       near edge normally, the far one on a box anchored only by it */
    const at = (dx: number, dy: number, snap: boolean) => ({
      left: !xMove ? left
        : box.left.present || !box.right.present ? snapX(left + dx, snap)
        : snapX(left + box.w.value + dx, snap) - box.w.value,
      top: !yMove ? top
        : box.top.present || !box.bottom.present ? snapY(top + dy, snap)
        : snapY(top + box.h.value + dy, snap) - box.h.value,
    });
    /* moving a STRETCHED axis pins its size: the doc held nothing on it, the box was both
       insets, and writing left alone would trade the stretch for content-sizing — so the
       size the stretch was giving is written down with the position */
    const pinW = !box.left.present && !box.w.present && !box.right.present;
    const pinH = !box.top.present && !box.h.present && !box.bottom.present;
    /* every field the axis carries moves together, so the box keeps its size: a pinned
       far edge slides by the same distance as the near one */
    const xOut = (out: FreeWrite, lo: number) => {
      if (box.left.present || !box.right.present) out.left = lo + oxEff * box.w.value;
      if (box.right.present) out.right = box.span.w - (lo + box.w.value);
      if (pinW) out.w = box.w.value;
    };
    const yOut = (out: FreeWrite, lo: number) => {
      if (box.top.present || !box.bottom.present) out.top = lo + oyEff * box.h.value;
      if (box.bottom.present) out.bottom = box.span.h - (lo + box.h.value);
      if (pinH) out.h = box.h.value;
    };
    return {
      apply(dx, dy, snap) {
        const to = at(dx, dy, snap);
        const out: FreeWrite = {};
        if (xMove) xOut(out, to.left);
        if (yMove) yOut(out, to.top);
        return out;
      },
      commit(dx, dy, snap) {
        const to = at(dx, dy, snap);
        const out: FreeWrite = {};
        if (xMove && changed(to.left, left)) xOut(out, to.left);
        if (yMove && changed(to.top, top)) yOut(out, to.top);
        return out;
      },
    };
  }

  /* a resize: the grabbed edge moves — snapped, then floored so the box stays graspable —
     the opposite edge stands, and the axis's own authored fields are read back off the
     pair: left/w through the origin where the far edge is free; the pinned far edge's
     inset (and, on a box anchored only by it, the width) where it is not */
  const xAxis = (dx: number, snap: boolean): { lo: number; hi: number } | null => {
    if (!handle.includes("L") && !handle.includes("R")) return null;
    let lo = left;
    let hi = left + box.w.value;
    if (handle.includes("L")) lo = Math.min(snapX(lo + dx, snap), hi - MIN_FREE_PX);
    else hi = Math.max(snapX(hi + dx, snap), lo + MIN_FREE_PX);
    return { lo, hi };
  };
  const yAxis = (dy: number, snap: boolean): { lo: number; hi: number } | null => {
    if (!handle.includes("T") && !handle.includes("B")) return null;
    if (box.derived === "h") return null;   /* the ratio owns this size; w carries the drag */
    let lo = top;
    let hi = top + box.h.value;
    if (handle.includes("T")) lo = Math.min(snapY(lo + dy, snap), hi - MIN_FREE_PX);
    else hi = Math.max(snapY(hi + dy, snap), lo + MIN_FREE_PX);
    return { lo, hi };
  };
  const xPlan = (dx: number, snap: boolean) => (box.derived === "w" ? null : xAxis(dx, snap));
  /* gate: which values the resize would write, each against the doc's own number when
     committing (null skips the gate — the live picture writes everything) */
  const xWrites = (out: FreeWrite, to: { lo: number; hi: number },
                   gate: ((next: number, was: number) => boolean) | null) => {
    if (box.right.present) {
      if (handle.includes("R")) {
        const inset = box.span.w - to.hi;
        if (!gate || gate(inset, box.right.value)) out.right = inset;
        if (!box.left.present && (!gate || gate(to.hi - to.lo, box.w.value)))
          out.w = to.hi - to.lo;
      } else if (box.left.present) {
        if (!gate || gate(to.lo, box.left.value)) out.left = to.lo;
      } else if (!gate || gate(to.hi - to.lo, box.w.value)) {
        out.w = to.hi - to.lo;
      }
    } else {
      const at = to.lo + box.ox * (to.hi - to.lo);
      if (!gate || gate(at, box.left.value)) out.left = at;
      if (!gate || gate(to.hi - to.lo, box.w.value)) out.w = to.hi - to.lo;
    }
  };
  const yWrites = (out: FreeWrite, to: { lo: number; hi: number },
                   gate: ((next: number, was: number) => boolean) | null) => {
    if (box.bottom.present) {
      if (handle.includes("B")) {
        const inset = box.span.h - to.hi;
        if (!gate || gate(inset, box.bottom.value)) out.bottom = inset;
        if (!box.top.present && (!gate || gate(to.hi - to.lo, box.h.value)))
          out.h = to.hi - to.lo;
      } else if (box.top.present) {
        if (!gate || gate(to.lo, box.top.value)) out.top = to.lo;
      } else if (!gate || gate(to.hi - to.lo, box.h.value)) {
        out.h = to.hi - to.lo;
      }
    } else {
      const at = to.lo + box.oy * (to.hi - to.lo);
      if (!gate || gate(at, box.top.value)) out.top = at;
      if (!gate || gate(to.hi - to.lo, box.h.value)) out.h = to.hi - to.lo;
    }
  };
  return {
    apply(dx, dy, snap) {
      const out: FreeWrite = {};
      const hx = xPlan(dx, snap);
      if (hx) xWrites(out, hx, null);
      const vy = yAxis(dy, snap);
      if (vy) yWrites(out, vy, null);
      return out;
    },
    commit(dx, dy, snap) {
      const out: FreeWrite = {};
      const hx = xPlan(dx, snap);
      if (hx) xWrites(out, hx, changed);
      const vy = yAxis(dy, snap);
      if (vy) yWrites(out, vy, changed);
      return out;
    },
  };
}
