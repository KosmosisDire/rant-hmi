// Finding elements and their boxes in a page's tree.

import { send } from "../../net/connection";
import { type Box, type Overrides, type Room, SHAPES } from "../../page/PageView";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { produce } from "solid-js/store";
import { docScope, isNumber, isPercent, pageScope, placement, repeatScope, resolve, type Scope } from "../../state/bind";
import { setState } from "../../state/store";

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

/** An element's box within what holds it, `room`, in pixels. */
export function boxOf(e: Element, room: Room, overrides?: Overrides, scope: Scope = pageScope): Box {
  const at = (k: keyof Box) => placement(e.props[k], k === "x" || k === "w" ? room.w : room.h, scope);
  return overrides?.(e.id) ?? { x: at("x"), y: at("y"), w: at("w"), h: at("h") };
}

/** The room an element sits in: its frame's size, or the page's. */
export function roomOf(page: Page, id: string): Room {
  const parent = parentOf(page, id);
  const b = parent ? absolute(page, parent) : undefined;
  return b ? { w: b.w, h: b.h } : { w: page.width, h: page.height };
}

/** How to write `px` into a placement value that was `old`: a percent of `room` stays one. */
export function placementText(old: string | undefined, key: keyof Box, px: number, room: Room): string {
  const whole = key === "x" || key === "w" ? room.w : room.h;
  return isPercent(old) && whole > 0 ? `${Number(((px / whole) * 100).toFixed(2))}%` : String(px);
}

/** What each element along a path reads in the editor, outermost first: the page's or
 *  component's names, and inside a repeat its first copy, as the editor draws it. */
function scopes(page: Page, path: Element[]): Scope[] {
  let scope = docScope(page);
  return path.map((e) => {
    if (e.props.repeat?.trim()) {
      const r = resolve(e.props.repeat, scope);
      const first = r.ok && Array.isArray(r.value) ? r.value[0] : 0;
      scope = repeatScope(scope, 0, () => first);
    }
    return scope;
  });
}

/** What an element's own values read in the editor. */
export function scopeOf(page: Page, id: string): Scope {
  const path = chain(page.children, id);
  return path ? scopes(page, path).at(-1)! : docScope(page);
}

/** An element's box on the page, its frames' offsets added, each read where it is drawn. */
export function absolute(page: Page, id: string, overrides?: Overrides): Box | undefined {
  const path = chain(page.children, id);
  if (!path) return undefined;
  const reads = scopes(page, path);
  let room: Room = { w: page.width, h: page.height };
  const boxes = path.map((e, i) => {
    const b = boxOf(e, room, overrides, reads[i]);
    room = { w: b.w, h: b.h };
    return b;
  });
  const own = boxes[boxes.length - 1];
  const offset = boxes.slice(0, -1).reduce((at, b) => ({ x: at.x + b.x, y: at.y + b.y }), { x: 0, y: 0 });
  return { x: own.x + offset.x, y: own.y + offset.y, w: own.w, h: own.h };
}

/** True when each of `keys` is a plain number, a plain percent or unset, so a drag may write
 *  them. A shape has no box of ours to drag: its attributes place it. */
export function literal(e: Element, keys: (keyof Box)[]): boolean {
  return !SHAPES.has(e.tag) && keys.every((k) => e.props[k] === undefined || isNumber(e.props[k]) || isPercent(e.props[k]));
}

/** Whether `parent`, or the page for null, may hold a `child`: a frame holds elements, a
 *  drawing or a group shapes, as the backend allows. */
export function holds(parent: Tag | null, child: Tag): boolean {
  const shape = SHAPES.has(child);
  if (parent === null || parent === "div") return !shape;
  return (parent === "svg" || parent === "g") && shape;
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
    const origin = (f: string | null) => (f ? absolute(page, f) : undefined) ?? { x: 0, y: 0, w: page.width, h: page.height };
    const [a, b] = [origin(from), origin(parent)];
    const own = boxOf(e, a);
    const props = { x: placementText(e.props.x, "x", own.x + a.x - b.x, b), y: placementText(e.props.y, "y", own.y + a.y - b.y, b) };
    edits.push({ kind: "set_props", page: page.id, id, props });
  }
  sendEdits(edits);
}

/** Where an element goes among what shares its frame: one step or all the way, to the front
 *  or the back. */
export type Restack = "forward" | "backward" | "front" | "back";

export function restack(page: Page, id: string, how: Restack) {
  const parent = parentOf(page, id);
  const siblings = childrenOf(page, parent);
  const [at, last] = [siblings.findIndex((c) => c.id === id), siblings.length - 1];
  const to = { forward: Math.min(last, at + 1), backward: Math.max(0, at - 1), front: last, back: 0 }[how];
  moveTo(page, id, parent, to);
}

/** Removes elements as one undo. */
export function remove(page: Page, elements: Element[]) {
  sendEdits(elements.map((e) => ({ kind: "remove_element", page: page.id, id: e.id })));
}

/** An edge or centre several elements line up on. */
export type Align = "left" | "centre" | "right" | "top" | "middle" | "bottom";

/** The selected elements that can move, each with its box on the page and where its frame
 *  starts there. */
function placed(page: Page, ids: string[]) {
  return tops(page, ids)
    .filter((e) => literal(e, ["x", "y"]))
    .flatMap((e) => {
      const b = absolute(page, e.id);
      const room = roomOf(page, e.id);
      const own = boxOf(e, room);
      return b ? [{ e, b, room, origin: { x: b.x - own.x, y: b.y - own.y } }] : [];
    });
}

/** Lines elements up on one edge or centre of the box around them, as one undo. */
export function align(page: Page, ids: string[], how: Align) {
  const all = placed(page, ids);
  const across = how === "left" || how === "centre" || how === "right";
  const start = Math.min(...all.map(({ b }) => (across ? b.x : b.y)));
  const end = Math.max(...all.map(({ b }) => (across ? b.x + b.w : b.y + b.h)));
  sendEdits(
    all.flatMap(({ e, b, room, origin }) => {
      const size = across ? b.w : b.h;
      const at = how === "left" || how === "top" ? start : how === "right" || how === "bottom" ? end - size : Math.round((start + end - size) / 2);
      const key = across ? "x" : "y";
      const local = at - (across ? origin.x : origin.y);
      return local === (across ? b.x - origin.x : b.y - origin.y) ? [] : [{ kind: "set_props", page: page.id, id: e.id, props: { [key]: placementText(e.props[key], key, local, room) } } as Edit];
    }),
  );
}

/** Spreads three or more elements so the gaps between them are equal, across or down, the
 *  first and last staying put. */
export function spread(page: Page, ids: string[], across: boolean) {
  const all = placed(page, ids).sort((p, q) => (across ? p.b.x - q.b.x : p.b.y - q.b.y));
  if (all.length < 3) return;
  const size = (b: Box) => (across ? b.w : b.h);
  const first = across ? all[0].b.x : all[0].b.y;
  const last = all.at(-1)!;
  const gap = ((across ? last.b.x : last.b.y) + size(last.b) - first - all.reduce((n, { b }) => n + size(b), 0)) / (all.length - 1);
  let at = first;
  sendEdits(
    all.flatMap(({ e, b, room, origin }) => {
      const key = across ? "x" : "y";
      const local = Math.round(at) - (across ? origin.x : origin.y);
      at += size(b) + gap;
      return local === (across ? b.x - origin.x : b.y - origin.y) ? [] : [{ kind: "set_props", page: page.id, id: e.id, props: { [key]: placementText(e.props[key], key, local, room) } } as Edit];
    }),
  );
}

/** Sends edits as one, so one undo takes them all back. */
export function sendEdits(edits: Edit[]) {
  if (edits.length > 0) send({ type: "edit", edit: edits.length === 1 ? edits[0] : { kind: "batch", edits } });
}

/** Sets props, here at once too, so a gesture right after reads what was just typed. */
export function setProps(page: string, id: string, props: Record<string, string | null>) {
  if (send({ type: "edit", edit: { kind: "set_props", page, id, props } })) showProps(page, id, props);
}

/** Sets one event's handler, here at once too, so a change right after builds on this one
 *  and never sends back the code it replaced. A null code takes the handler away. */
export function setHandler(page: string, id: string, event: string, code: string | null, ms?: string) {
  if (!send({ type: "edit", edit: { kind: "set_handler", page, id, event, code, ms } })) return;
  setState(
    "pages",
    (pg) => pg.id === page,
    produce((pg) => {
      const e = find(pg.children, id);
      const at = e?.handlers.findIndex((h) => h.event === event) ?? -1;
      if (!e) return;
      if (code === null) {
        if (at >= 0) e.handlers.splice(at, 1);
      } else if (at >= 0) {
        Object.assign(e.handlers[at], { code, ms: ms ?? e.handlers[at].ms });
      } else {
        e.handlers.push({ event, code, ms: ms ?? "" });
      }
    }),
  );
}

/** Shows props here only, as a gesture does before it lets go and keeps them with setProps.
 *  An empty or null value takes the prop away. */
export function showProps(page: string, id: string, props: Record<string, string | null>) {
  setState(
    "pages",
    (pg) => pg.id === page,
    produce((pg) => {
      const e = find(pg.children, id);
      for (const [k, v] of Object.entries(props)) {
        if (!e) return;
        if (!v) delete e.props[k];
        else e.props[k] = v;
      }
    }),
  );
}
