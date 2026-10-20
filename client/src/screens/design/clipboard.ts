// Copy, cut, paste and duplicate through the browser's clipboard events, since the async API
// needs https. An element travels as JSON marked as ours.

import { send } from "../../net/connection";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { isNumber } from "../../state/bind";
import { GRID } from "./Artboard";
import { childrenOf, find, parentOf } from "./tree";

const MARK = "rant-hmi elements";

interface Clip {
  mark: typeof MARK;
  /** Where the elements came from, so pasting onto the original puts the copy beside it. */
  page: string;
  elements: Element[];
}

export function copy(e: ClipboardEvent, page: Page, id: string) {
  const element = find(page.children, id);
  if (!element || !e.clipboardData) return;
  const clip: Clip = { mark: MARK, page: page.id, elements: [element] };
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
  if (at && at.tag === "div" && !own) {
    parent = at.id;
  } else if (at) {
    parent = parentOf(page, at.id);
    index = childrenOf(page, parent).findIndex((c) => c.id === at.id) + 1;
  }
  add(page, parent, index, clip.elements);
}

/** A copy of the element just in front of it, one grid step down and right. */
export function duplicate(page: Page, id: string) {
  const element = find(page.children, id);
  if (!element) return;
  const parent = parentOf(page, id);
  const copy: Element = JSON.parse(JSON.stringify(element));
  for (const k of ["x", "y"]) {
    if (isNumber(copy.props[k])) copy.props[k] = String(Number(copy.props[k]) + GRID);
  }
  add(page, parent, childrenOf(page, parent).findIndex((c) => c.id === id) + 1, [copy]);
}

function add(page: Page, parent: string | null, index: number | null, elements: Element[]) {
  const edits: Edit[] = elements.map((element, n) => ({ kind: "add_element", page: page.id, parent, index: index === null ? null : index + n, element }));
  send({ type: "edit", edit: edits.length === 1 ? edits[0] : { kind: "batch", edits } });
}
