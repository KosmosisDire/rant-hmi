// Finding elements and their boxes in a page's tree.

import { send } from "../../net/connection";
import type { Box, Overrides } from "../../page/PageView";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { isNumber, number } from "../../state/bind";

/** The element and every frame around it, outermost first. */
export function chain(elements: Element[], id: string): Element[] | undefined {
  for (const e of elements) {
    if (e.id === id) return [e];
    const inner = chain(e.children, id);
    if (inner) return [e, ...inner];
  }
  return undefined;
}

export function find(elements: Element[], id: string): Element | undefined {
  return chain(elements, id)?.at(-1);
}

/** The selected elements no other selected one holds, in page order, so a move or a removal
 *  takes each once. */
export function tops(page: Page, ids: string[]): Element[] {
  const out: Element[] = [];
  const walk = (elements: Element[]) => {
    for (const e of elements) {
      if (ids.includes(e.id)) out.push(e);
      else walk(e.children);
    }
  };
  walk(page.children);
  return out;
}

/** The frame an element sits in, null for the page. */
export function parentOf(page: Page, id: string): string | null {
  const path = chain(page.children, id);
  return path && path.length > 1 ? path[path.length - 2].id : null;
}

/** What a frame holds, or the page for null, back to front. */
export function childrenOf(page: Page, parent: string | null): Element[] {
  return parent ? (find(page.children, parent)?.children ?? []) : page.children;
}

export function boxOf(e: Element, overrides?: Overrides): Box {
  return overrides?.(e.id) ?? { x: number(e.props.x), y: number(e.props.y), w: number(e.props.w), h: number(e.props.h) };
}

/** An element's box on the page, its frames' offsets added. */
export function absolute(page: Page, id: string, overrides?: Overrides): Box | undefined {
  const path = chain(page.children, id);
  if (!path) return undefined;
  const own = boxOf(path[path.length - 1], overrides);
  const offset = path.slice(0, -1).reduce((at, e) => {
    const b = boxOf(e, overrides);
    return { x: at.x + b.x, y: at.y + b.y };
  }, { x: 0, y: 0 });
  return { x: own.x + offset.x, y: own.y + offset.y, w: own.w, h: own.h };
}

/** True when each of `keys` is a plain number or unset, so a drag may write them. */
export function literal(e: Element, keys: (keyof Box)[]): boolean {
  return keys.every((k) => e.props[k] === undefined || isNumber(e.props[k]));
}

/** Moves an element to `index` of `parent`, counted without it. Into another frame it keeps
 *  its place on the page when its x and y are plain numbers. One undo takes it all back. */
export function moveTo(page: Page, id: string, parent: string | null, index: number) {
  const e = find(page.children, id);
  if (!e) return;
  const from = parentOf(page, id);
  if (from === parent && childrenOf(page, from).findIndex((c) => c.id === id) === index) return;
  const edits: Edit[] = [{ kind: "move_element", page: page.id, id, parent, index }];
  if (from !== parent && literal(e, ["x", "y"])) {
    const origin = (f: string | null) => (f ? absolute(page, f) : undefined) ?? { x: 0, y: 0 };
    const [a, b] = [origin(from), origin(parent)];
    edits.push({ kind: "set_props", page: page.id, id, props: { x: String(number(e.props.x) + a.x - b.x), y: String(number(e.props.y) + a.y - b.y) } });
  }
  sendEdits(edits);
}

/** Sends edits as one, so one undo takes them all back. */
export function sendEdits(edits: Edit[]) {
  if (edits.length > 0) send({ type: "edit", edit: edits.length === 1 ? edits[0] : { kind: "batch", edits } });
}

export function setProps(page: string, id: string, props: Record<string, string | null>) {
  send({ type: "edit", edit: { kind: "set_props", page, id, props } });
}
