/* WHERE A DRAGGED NODE WOULD LAND, AND WHAT DRAGGING A BOUNDARY MOVES: all of direct
 * manipulation's arithmetic, and none of its DOM.
 *
 * The Layers tree drag reads geometry (which row the pointer is over, how far down it) and
 * hands the numbers here; the stage drag reads its own (where the children's midpoints are,
 * which gap the pointer has passed) and hands them to the same rules. Everything from there —
 * which parent, which index, and whether the drop is legal at all — is decided by this file
 * against the document alone, so both drags land a node the same way. That split is
 * deliberate: layout is the browser's and cannot be asserted headlessly, while these rules are
 * exactly the ones that make dragging feel right or maddening, so they belong where a test can
 * reach them (test/view_test.mjs). */

import { isInstance, Node, Page } from "./types.js";

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
 * constant NOW. `12` is a number a boundary can push around; `value.pick(2, 1)` is authored
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
 * means INSIDE; a widget row has no inside, so its whole height splits at the halfway mark
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
     widget a perfectly good target. */
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

/* ---- the stage's own geometry: which gap, which boundary ---- */

/* THE MIDPOINT RULE, which is the whole of where a stage drop lands: the insertion index is
 * the number of children the pointer has already passed the middle of. Before the first
 * midpoint is 0, past the last is the length, and an empty container is 0 — every case that
 * a set of before/after/between zones would need a constant for, out of one comparison. The
 * caller measures along the container's MAIN axis (a row's x centres, a column's y centres);
 * a stack has no main axis and never asks. */
export function gapIndex(midpoints: number[], at: number): number {
  let passed = 0;
  for (const mid of midpoints) if (mid < at) passed++;
  return passed;
}

/* The same index read against a list that ALREADY HOLDS the dragged node — which is what
 * the page always is during a drag, because nothing moves until the drop. `held` is where
 * the node sits in that list (-1 when it is somewhere else entirely): every slot past it is
 * one too far. An op's index counts the list the server will insert into, which is the list
 * without the node; a caret is drawn between the children that are actually on screen. */
export function withoutHeld(raw: number, held: number): number {
  return held >= 0 && held < raw ? raw - 1 : raw;
}

/* WHERE THE CARET GOES, which is the inverse: an op's index counted against the list minus
 * the dragged node, turned back into the gap between the children now on screen. Drawing at
 * the op's own index would put the line one slot early whenever the node is being moved
 * further down its own list.
 *
 * Pure, and separate from the drawing, because this is the arithmetic that decides whether a
 * drop lands where the line promised — the tree drag and the stage drag both come through
 * here, so one line means one answer. */
export function caretIndex(page: Page, dragId: number, plan: DropPlan): number {
  const seat = seatOf(page, dragId);
  const inPlace = seat && seat.parent === plan.parent;
  return inPlace && seat.index <= plan.index ? plan.index + 1 : plan.index;
}

/* one child's extent on both axes, in whatever units the caller measured: client pixels from
 * the DOM, plain numbers from a test */
export interface Extent {
  start: number;    /* the container's MAIN axis */
  end: number;
  from: number;     /* and its cross axis */
  to: number;
}

/* WHICH BOUNDARY the pointer is on. A container with n children has n-1 of them, each the
 * gap-line between two adjacent siblings, and the strip that grabs one is `tolerance` either
 * side of that line across the cross extent the two children actually share — a pointer past
 * the end of the shorter one is over the container, not over their shared edge. A stack has
 * no main axis and no boundaries, which falls out of asking for fewer than two extents. */
export function boundaryAt(
  kids: Extent[],
  main: number,
  cross: number,
  tolerance: number,
): number | null {
  for (let i = 0; i + 1 < kids.length; i++) {
    const line = (kids[i].end + kids[i + 1].start) / 2;
    if (Math.abs(main - line) > tolerance) continue;
    if (cross < Math.max(kids[i].from, kids[i + 1].from)) continue;
    if (cross > Math.min(kids[i].to, kids[i + 1].to)) continue;
    return i;
  }
  return null;
}

/* ---- dragging a boundary: what it does to grow and min ----
 *
 * THE SPLITTER MODEL: a boundary belongs to the two children either side of it, and moving it
 * grows one by exactly what it takes from the other. Nothing else on the page moves, which is
 * what makes it a boundary rather than a size field with a mouse on it.
 *
 * A side is measured, never guessed: its outer size along the container's main axis and the
 * padding+border inside that, plus the two props the document holds for it.
 *
 * An aspect-locked child never reaches this arithmetic: its main size is DERIVED from its
 * cross (stage.ts), so a boundary against it has nothing to write, and manipulate.ts does
 * not offer one. */

export interface ResizeSide {
  grow: number;
  min: number;
  outer: number;
  /* padding + border on the main axis: the part of `outer` that is not the flex share */
  chrome: number;
}

/* what to write on one side of the boundary; a prop the drag does not touch is absent, and a
   whole side that takes no write at all is null */
export interface SideWrite {
  grow?: number;
  min?: number;
}

export interface ResizeMove {
  a: SideWrite | null;
  b: SideWrite | null;
}

export interface ResizePlan {
  /* live, per pointer move: raw values, straight into the two inline styles the browser
     re-solves the layout from */
  apply(delta: number): ResizeMove;
  /* on release: the same move, rounded to what a document is willing to carry */
  commit(delta: number): ResizeMove;
}

/* the smallest a drag may leave a child: a graspable sliver rather than nothing at all. The
   inspector can still type an extreme; a gesture may not produce one by accident. */
const MIN_PX = 24;
/* a grow of 0 silently turns a flexible child into a fixed one, which is a different layout
   model, not a smaller share — so a drag never writes one */
const MIN_GROW = 0.05;

/* nothing legal to move: the two floors leave no room in either direction, so the boundary
   holds still rather than snapping to one of them */
function held(delta: number, lo: number, hi: number): number {
  return lo > hi ? 0 : Math.min(Math.max(delta, lo), hi);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* `delta` is the pointer's movement along the main axis, so a positive one always grows the
 * side BEFORE the boundary and shrinks the side after it. Which props that becomes depends on
 * how the two sides are laid out, not on which one was grabbed. */
export function resizeAt(a: ResizeSide, b: ResizeSide): ResizePlan | null {
  const flexA = a.grow > 0;
  const flexB = b.grow > 0;

  /* BOTH FLEXIBLE: the drag transfers weight from one to the other. Flex basis is 0, so a
     side's outer size is its own padding and border plus grow.u for a container-wide px-per-
     grow-unit u; the pair of measurements solves for u exactly. The sum of the two grows is
     conserved, which is why no other sibling's share moves. */
  if (flexA && flexB) {
    const unit = (a.outer + b.outer - a.chrome - b.chrome) / (a.grow + b.grow);
    if (!(unit > 0) || !Number.isFinite(unit)) return null;   /* nothing to share: inert */
    const lo = Math.max(MIN_GROW, (Math.max(a.min, MIN_PX) - a.chrome) / unit) - a.grow;
    const hi = b.grow - Math.max(MIN_GROW, (Math.max(b.min, MIN_PX) - b.chrome) / unit);
    const shift = (delta: number) => held(delta / unit, lo, hi);
    return {
      apply: (delta) => ({
        a: { grow: a.grow + shift(delta) },
        b: { grow: b.grow - shift(delta) },
      }),
      commit: (delta) => ({
        a: { grow: round2(a.grow + shift(delta)) },
        b: { grow: round2(b.grow - shift(delta)) },
      }),
    };
  }

  /* ONE FIXED SIDE: a child with grow 0 IS its min, so that is the number the drag edits —
     and the flexible side absorbs the difference on its own, which is why it takes no write.
     This is the ordinary case of a header band against the body below it. */
  if (flexB) {
    const at = (delta: number) => Math.max(0, a.min + held(delta, MIN_PX - a.min, b.outer - MIN_PX));
    return {
      apply: (delta) => ({ a: { min: at(delta) }, b: null }),
      commit: (delta) => ({ a: { min: Math.round(at(delta)) }, b: null }),
    };
  }
  if (flexA) {
    const at = (delta: number) => Math.max(0, b.min - held(delta, MIN_PX - a.outer, b.min - MIN_PX));
    return {
      apply: (delta) => ({ a: null, b: { min: at(delta) } }),
      commit: (delta) => ({ a: null, b: { min: Math.round(at(delta)) } }),
    };
  }

  /* NEITHER FLEXES: the boundary is the pair of mins, one taking what the other gives */
  const both = (delta: number) => {
    const move = held(delta, MIN_PX - a.min, b.min - MIN_PX);
    return [Math.max(0, a.min + move), Math.max(0, b.min - move)];
  };
  return {
    apply: (delta) => {
      const [minA, minB] = both(delta);
      return { a: { min: minA }, b: { min: minB } };
    },
    commit: (delta) => {
      const [minA, minB] = both(delta);
      return { a: { min: Math.round(minA) }, b: { min: Math.round(minB) } };
    },
  };
}
