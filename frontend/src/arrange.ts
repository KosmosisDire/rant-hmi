/* WHERE A DRAGGED ROW WOULD LAND: all of the tree's drop arithmetic, and none of its DOM.
 *
 * The Layers tree drag reads geometry (which row the pointer is over, how far down it) and
 * hands the numbers here; everything from there — which parent, which index, and whether the
 * drop is legal at all — is decided by this file against the document alone. That split is
 * deliberate: layout is the browser's and cannot be asserted headlessly, while these rules are
 * exactly the ones that make tree drag-and-drop feel right or maddening, so they belong where
 * a test can reach them (test/view_test.mjs). */

import { Frame, Page, Widget } from "./types.js";

export type Zone = "before" | "after" | "into";

/* the parent to insert into and the index to insert AT, in the op's own terms */
export interface DropPlan {
  parent: number;
  index: number;
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

type Node = Frame | Widget;

interface Seat {
  node: Node;
  parent: number;
  siblings: Node[];
  index: number;
}

/* where one id sits on the page: its parent's id (the page's, at the top level), the list it
 * is in and its position in it */
function seatOf(page: Page, id: number): Seat | null {
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
  return plan(page, dragId, { parent: page.id, index: (page.children ?? []).length });
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
  const kids = target.node.kind === "frame" ? target.node.children ?? [] : null;

  if (zone === "into") {
    if (!kids) return null;
    return plan(page, dragId, { parent: targetId, index: kids.length });
  }
  /* the gap under an OPEN frame row is the gap ABOVE its first child: that is the one the
     eye sees between those two rows, and pointing it past the whole subtree instead is what
     makes tree dragging feel like it is fighting you */
  if (zone === "after" && kids && kids.length && open)
    return plan(page, dragId, { parent: targetId, index: 0 });
  return plan(page, dragId, {
    parent: target.parent,
    index: target.index + (zone === "after" ? 1 : 0),
  });
}

/* The two rules that turn a raw position into an op: the legality walk, and the shift the
 * server's own erase-then-insert order imposes. */
function plan(page: Page, dragId: number, raw: DropPlan): DropPlan | null {
  const drag = seatOf(page, dragId);
  if (!drag) return null;
  /* into itself, or into anything it holds */
  if (within(page, raw.parent, dragId)) return null;

  /* THE SERVER ERASES FIRST: by the time it inserts, the list it is inserting into is the
     list without the dragged node. So a move further down its OWN list lands one short of
     where it was pointed — children [A,B,C] with A dropped after B is index 1, because the
     list being inserted into is [B,C]. */
  let index = raw.index;
  if (raw.parent === drag.parent && drag.index < index) index -= 1;

  if (raw.parent === drag.parent && index === drag.index) return null;   /* it is already there */
  return { parent: raw.parent, index };
}
