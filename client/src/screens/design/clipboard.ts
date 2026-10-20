// Copy, cut, paste and duplicate through the browser's clipboard events, since the async API
// needs https. An element travels as JSON marked as ours. What this window copied last is
// kept too, for a menu's paste, which no paste event comes with.

import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { SHAPES } from "../../page/PageView";
import { GRID } from "./Artboard";
import { moving, reshape } from "./geometry";
import { boxOf, childrenOf, find, holds, literal, parentOf, placementText, roomOf, sendEdits } from "./tree";

const MARK = "rant-hmi elements";

let kept = "";

interface Clip {
  mark: typeof MARK;
  /** Where the elements came from, so pasting onto the original puts the copy beside it. */
  page: string;
  elements: Element[];
}

export function copy(e: ClipboardEvent, page: Page, elements: Element[]) {
  if (elements.length === 0 || !e.clipboardData) return;
  const clip: Clip = { mark: MARK, page: page.id, elements };
  kept = JSON.stringify(clip, null, 2);
  e.clipboardData.setData("text/plain", kept);
  e.preventDefault();
}

export function paste(e: ClipboardEvent, page: Page, selected: string | null) {
  if (pasteText(e.clipboardData?.getData("text/plain") ?? "", page, selected)) e.preventDefault();
}

/** Pastes from a menu: the system clipboard where the browser lets a page read it, else
 *  what this window copied last. On the page, `at` is where its top left corner goes. */
export async function pasteHere(page: Page, selected: string | null, at?: { x: number; y: number }) {
  let text = kept;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // plain http has no clipboard to read, and a person may refuse it
  }
  pasteText(text, page, selected, at);
}

/** Pastes into the selected frame, beside any other selected element, else onto the page,
 *  in front of what is there. False when the text holds no elements of ours. */
function pasteText(text: string, page: Page, selected: string | null, spot?: { x: number; y: number }): boolean {
  let clip: Clip;
  try {
    clip = JSON.parse(text);
  } catch {
    return false;
  }
  if (clip?.mark !== MARK || !Array.isArray(clip.elements)) return false;
  const at = selected ? find(page.children, selected) : undefined;
  const own = clip.page === page.id && clip.elements.some((c) => c.id === selected);
  let parent: string | null = null;
  let index: number | null = null;
  if (at && clip.elements.length > 0 && holds(at.tag, clip.elements[0].tag) && !own) {
    parent = at.id;
  } else if (at) {
    parent = parentOf(page, at.id);
    index = childrenOf(page, parent).findIndex((c) => c.id === at.id) + 1;
  } else if (spot) {
    moveCorner(page, clip.elements, spot);
  }
  add(page, parent, index, clip.elements);
  return true;
}

/** Moves elements bound for the page so the corner of the box around them lands at `spot`,
 *  on the grid. Each keeps the unit its place is written in. */
function moveCorner(page: Page, elements: Element[], spot: { x: number; y: number }) {
  const room = { w: page.width, h: page.height };
  const movable = elements.filter((e) => literal(e, ["x", "y"]));
  if (movable.length === 0) return;
  const boxes = movable.map((e) => boxOf(e, room));
  const [dx, dy] = [Math.round(spot.x / GRID) * GRID - Math.min(...boxes.map((b) => b.x)), Math.round(spot.y / GRID) * GRID - Math.min(...boxes.map((b) => b.y))];
  movable.forEach((e, i) => Object.assign(e.props, { x: placementText(e.props.x, "x", boxes[i].x + dx, room), y: placementText(e.props.y, "y", boxes[i].y + dy, room) }));
}

/** A copy of each element just in front of it, one grid step down and right. */
export function duplicate(page: Page, elements: Element[]) {
  // each copy before this one in the same frame moves the places after it on by one
  const before = new Map<string | null, number>();
  const edits: Edit[] = elements.map((element) => {
    const parent = parentOf(page, element.id);
    const copy: Element = JSON.parse(JSON.stringify(element));
    // a shape steps by its own attributes, a frame by its place, in the unit it is written in
    if (SHAPES.has(copy.tag)) Object.assign(copy.props, reshape(copy, moving(GRID, GRID)) ?? {});
    else if (literal(copy, ["x", "y"])) {
      const room = roomOf(page, element.id);
      const b = boxOf(element, room);
      Object.assign(copy.props, { x: placementText(copy.props.x, "x", b.x + GRID, room), y: placementText(copy.props.y, "y", b.y + GRID, room) });
    }
    const shift = before.get(parent) ?? 0;
    before.set(parent, shift + 1);
    const index = childrenOf(page, parent).findIndex((c) => c.id === element.id) + 1 + shift;
    return { kind: "add_element", page: page.id, parent, index, element: copy };
  });
  sendEdits(edits);
}

function add(page: Page, parent: string | null, index: number | null, elements: Element[]) {
  sendEdits(elements.map((element, n) => ({ kind: "add_element", page: page.id, parent, index: index === null ? null : index + n, element })));
}
