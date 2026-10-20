// Copy, cut, paste and duplicate through the browser's clipboard events, since the async API
// needs https. An element travels as JSON marked as ours.

import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { isNumber } from "../../state/bind";
import { GRID } from "./Artboard";
import { childrenOf, find, holds, parentOf, sendEdits } from "./tree";

const MARK = "rant-hmi elements";

interface Clip {
  mark: typeof MARK;
  /** Where the elements came from, so pasting onto the original puts the copy beside it. */
  page: string;
  elements: Element[];
}

export function copy(e: ClipboardEvent, page: Page, elements: Element[]) {
  if (elements.length === 0 || !e.clipboardData) return;
  const clip: Clip = { mark: MARK, page: page.id, elements };
  e.clipboardData.setData("text/plain", JSON.stringify(clip, null, 2));
  e.preventDefault();
}

/** Pastes into the selected frame, beside any other selected element, else onto the page,
 *  in front of what is there. */
export function paste(e: ClipboardEvent, page: Page, selected: string | null) {
  let clip: Clip;
  try {
    clip = JSON.parse(e.clipboardData?.getData("text/plain") ?? "");
  } catch {
    return;
  }
  if (clip?.mark !== MARK || !Array.isArray(clip.elements)) return;
  e.preventDefault();
  const at = selected ? find(page.children, selected) : undefined;
  const own = clip.page === page.id && clip.elements.some((c) => c.id === selected);
  let parent: string | null = null;
  let index: number | null = null;
  if (at && clip.elements.length > 0 && holds(at.tag, clip.elements[0].tag) && !own) {
    parent = at.id;
  } else if (at) {
    parent = parentOf(page, at.id);
    index = childrenOf(page, parent).findIndex((c) => c.id === at.id) + 1;
  }
  add(page, parent, index, clip.elements);
}

/** A copy of each element just in front of it, one grid step down and right. */
export function duplicate(page: Page, elements: Element[]) {
  // each copy before this one in the same frame moves the places after it on by one
  const before = new Map<string | null, number>();
  const edits: Edit[] = elements.map((element) => {
    const parent = parentOf(page, element.id);
    const copy: Element = JSON.parse(JSON.stringify(element));
    for (const k of ["x", "y"]) {
      if (isNumber(copy.props[k])) copy.props[k] = String(Number(copy.props[k]) + GRID);
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
