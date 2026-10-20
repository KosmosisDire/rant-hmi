// Finding elements and their boxes in a page's tree.

import { send } from "../../net/connection";
import type { Box, Overrides } from "../../page/PageView";
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

export function setProps(page: string, id: string, props: Record<string, string | null>) {
  send({ type: "edit", edit: { kind: "set_props", page, id, props } });
}
