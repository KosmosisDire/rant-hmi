// Finding elements and their boxes in a page's tree.

import { send } from "../../net/connection";
import { type Box, leaves, type Overrides, type Room, SHAPES, union } from "../../page/PageView";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { produce } from "solid-js/store";
import { docScope, isNumber, isPercent, originAt, pageScope, placement, repeatScope, resolve, type Scope } from "../../state/bind";
import { notify, setState } from "../../state/store";

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

/** Whether an element is a group, of elements or of a drawing's shapes, picked whole first. */
export const isGroup = (e: Element | undefined) => e?.tag === "group" || e?.tag === "g";

/** What a click on `hit` picks: the outermost group around it the selection has not entered,
 *  so a group is picked whole before what it holds. */
export function pickAt(page: Page, hit: string, selected: string[]): string {
  for (const e of chain(page.children, hit) ?? []) {
    if (e.id !== hit && isGroup(e) && !selected.some((id) => id === e.id || find(e.children, id))) return e.id;
  }
  return hit;
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

/** Where an element's origin sits in its own box of `w` by `h`, from the box's corner. */
function originOf(e: Element, w: number, h: number, scope: Scope = pageScope) {
  const r = e.props.origin === undefined ? undefined : resolve(e.props.origin, scope);
  return originAt(r?.ok ? r.value : undefined, w, h);
}

/** An element's box within what holds it, `room`, in pixels from the room's corner. Its x and
 *  y place its origin, counted from the room's. */
export function boxOf(e: Element, room: Room, overrides?: Overrides, scope: Scope = pageScope): Box {
  const kept = overrides?.(e.id);
  if (kept) return kept;
  // a group's box is the one around what it holds, which shares its room
  if (e.tag === "group") return union(e.children.map((c) => boxOf(c, room, overrides, scope)));
  const at = (k: keyof Box) => placement(e.props[k], k === "x" || k === "w" ? room.w : room.h, scope);
  const [w, h] = [at("w"), at("h")];
  const own = originOf(e, w, h, scope);
  return { x: (room.ox ?? 0) + at("x") - own.x, y: (room.oy ?? 0) + at("y") - own.y, w, h };
}

/** The room the children of a frame, or of the page for null, sit in, and where it sits on
 *  the page. */
export function inside(page: Page, frame: string | null): { at: Box; room: Room } {
  const e = frame ? find(page.children, frame) : undefined;
  if (e?.tag === "group") return inside(page, parentOf(page, e.id));
  const b = frame ? absolute(page, frame) : undefined;
  if (!e || !b) return { at: { x: 0, y: 0, w: page.width, h: page.height }, room: { w: page.width, h: page.height } };
  const o = originOf(e, b.w, b.h, scopeOf(page, frame!));
  return { at: b, room: { w: b.w, h: b.h, ox: o.x, oy: o.y } };
}

/** The room an element sits in: its frame's, or the page's. */
export function roomOf(page: Page, id: string): Room {
  return inside(page, parentOf(page, id)).room;
}

/** How to write `px` into a placement value that was `old`: a percent of `room` stays one. */
function placementText(old: string | undefined, key: keyof Box, px: number, room: Room): string {
  const whole = key === "x" || key === "w" ? room.w : room.h;
  return isPercent(old) && whole > 0 ? `${Number(((px / whole) * 100).toFixed(2))}%` : String(Number(px.toFixed(2)));
}

/** The text of one of `e`'s placement values that puts it at `box` in `room`: x and y place
 *  its origin, which moves with its size. */
export function boxText(e: Element, key: keyof Box, box: Box, room: Room): string {
  const own = originOf(e, box.w, box.h);
  const px = key === "x" ? box.x - (room.ox ?? 0) + own.x : key === "y" ? box.y - (room.oy ?? 0) + own.y : box[key];
  return placementText(e.props[key], key, px, room);
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
  const at = { x: 0, y: 0 };
  for (const [i, e] of path.slice(0, -1).entries()) {
    // a group holds no room of its own
    if (e.tag === "group") continue;
    const b = boxOf(e, room, overrides, reads[i]);
    const o = originOf(e, b.w, b.h, reads[i]);
    room = { w: b.w, h: b.h, ox: o.x, oy: o.y };
    [at.x, at.y] = [at.x + b.x, at.y + b.y];
  }
  const own = boxOf(path[path.length - 1], room, overrides, reads[path.length - 1]);
  return { ...own, x: own.x + at.x, y: own.y + at.y };
}

/** True when each of `keys` is a plain number, a plain percent or unset, so a drag may write
 *  them, and for a group so in all it holds. A shape has no box of ours: its attributes place it. */
export function literal(e: Element, keys: (keyof Box)[]): boolean {
  if (e.tag === "group") return e.children.length > 0 && e.children.every((c) => literal(c, keys));
  return !SHAPES.has(e.tag) && keys.every((k) => e.props[k] === undefined || isNumber(e.props[k]) || isPercent(e.props[k]));
}

/** The x and y that put `e` dx and dy on from where it sits in `room`. */
function shifted(e: Element, room: Room, dx: number, dy: number): { x: string; y: string } {
  const b = boxOf(e, room);
  const there = { ...b, x: b.x + dx, y: b.y + dy };
  return { x: boxText(e, "x", there, room), y: boxText(e, "y", there, room) };
}

/** The edits that move an element on the page dx and dy, a group by what it holds. */
export function shiftBy(page: Page, e: Element, dx: number, dy: number): Edit[] {
  const room = roomOf(page, e.id);
  return leaves(e)
    .filter((l) => literal(l, ["x", "y"]))
    .map((l): Edit => ({ kind: "set_props", page: page.id, id: l.id, props: shifted(l, room, dx, dy) }));
}

/** Moves a copy dx and dy across `room`, as shiftBy moves an element on the page. */
export function shiftCopy(e: Element, room: Room, dx: number, dy: number) {
  for (const l of leaves(e)) if (literal(l, ["x", "y"])) Object.assign(l.props, shifted(l, room, dx, dy));
}

/** Whether `parent`, or the page for null, may hold a `child`: a frame holds elements, a
 *  drawing or a group shapes, as the backend allows. */
export function holds(parent: Tag | null, child: Tag): boolean {
  const shape = SHAPES.has(child);
  if (parent === null || parent === "div" || parent === "group") return !shape;
  return (parent === "svg" || parent === "g") && shape;
}

/** Moves an element to `index` of `parent`, counted without it, as moveAll does. */
export function moveTo(page: Page, id: string, parent: string | null, index: number) {
  moveAll(page, [id], parent, index);
}

/** Moves elements, kept together in the order given, to `index` of `parent` counted without
 *  them. Into another frame each keeps its place on the page when its x and y are plain
 *  numbers. One undo takes it all back. */
export function moveAll(page: Page, ids: string[], parent: string | null, index: number) {
  const edits: Edit[] = [];
  // each holder's list as the moves before leave it, so each index is the one it lands at
  const lists = new Map<string | null, string[]>();
  const list = (holder: string | null) => lists.get(holder) ?? lists.set(holder, childrenOf(page, holder).map((c) => c.id)).get(holder)!;
  const b = inside(page, parent);
  let last: string | null = null;
  for (const id of ids) {
    const e = find(page.children, id);
    if (!e) continue;
    const from = parentOf(page, id);
    const was = list(from).indexOf(id);
    list(from).splice(was, 1);
    const to = list(parent);
    // the first goes in front of what stays behind the slot, the rest each in front of the last
    const behind = last ?? to.filter((x) => !ids.includes(x))[index - 1];
    const at = behind === undefined ? 0 : to.indexOf(behind) + 1;
    to.splice(at, 0, id);
    last = id;
    if (from === parent && at === was) continue;
    edits.push({ kind: "move_element", page: page.id, id, parent, index: at });
    const a = inside(page, from);
    // into or out of a group, the room stays and so does every place
    const same = a.at.x === b.at.x && a.at.y === b.at.y && a.room.ox === b.room.ox && a.room.oy === b.room.oy;
    if (from === parent || same || !literal(e, ["x", "y"])) continue;
    for (const l of leaves(e)) {
      const own = boxOf(l, a.room);
      const there = { ...own, x: own.x + a.at.x - b.at.x, y: own.y + a.at.y - b.at.y };
      edits.push({ kind: "set_props", page: page.id, id: l.id, props: { x: boxText(l, "x", there, b.room), y: boxText(l, "y", there, b.room) } });
    }
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

/** Puts elements that share a holder into a new group, which the screen then selects. */
export function group(page: Page, ids: string[]) {
  const picked = tops(page, ids);
  if (picked.length === 0) return;
  if (picked.some((e) => parentOf(page, e.id) !== parentOf(page, picked[0].id))) return notify("Pick elements that sit in one frame to group them.", "warn");
  send({ type: "edit", edit: { kind: "group", page: page.id, ids: picked.map((e) => e.id) } });
}

/** Puts what each picked group holds in its place, as one undo. Gives back what they held. */
export function ungroup(page: Page, ids: string[]): string[] {
  const groups = tops(page, ids).filter(isGroup);
  sendEdits(groups.map((g): Edit => ({ kind: "ungroup", page: page.id, id: g.id })));
  return groups.flatMap((g) => g.children.map((c) => c.id));
}

/** Removes elements as one undo. */
export function remove(page: Page, elements: Element[]) {
  sendEdits(elements.map((e) => ({ kind: "remove_element", page: page.id, id: e.id })));
}

/** An edge or centre several elements line up on. */
export type Align = "left" | "centre" | "right" | "top" | "middle" | "bottom";

/** The selected elements that can move, each with its box on the page. */
function placed(page: Page, ids: string[]) {
  return tops(page, ids)
    .filter((e) => literal(e, ["x", "y"]))
    .flatMap((e) => {
      const b = absolute(page, e.id);
      return b ? [{ e, b }] : [];
    });
}

/** The edits that move `e` across or down from `from` to `to`, none when it stays. */
const along = (page: Page, e: Element, across: boolean, from: number, to: number) => (to === from ? [] : shiftBy(page, e, across ? to - from : 0, across ? 0 : to - from));

/** Lines elements up on one edge or centre of the box around them, as one undo. */
export function align(page: Page, ids: string[], how: Align) {
  const all = placed(page, ids);
  const across = how === "left" || how === "centre" || how === "right";
  const start = Math.min(...all.map(({ b }) => (across ? b.x : b.y)));
  const end = Math.max(...all.map(({ b }) => (across ? b.x + b.w : b.y + b.h)));
  sendEdits(
    all.flatMap(({ e, b }) => {
      const size = across ? b.w : b.h;
      const at = how === "left" || how === "top" ? start : how === "right" || how === "bottom" ? end - size : Math.round((start + end - size) / 2);
      return along(page, e, across, across ? b.x : b.y, at);
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
    all.flatMap(({ e, b }) => {
      const to = Math.round(at);
      at += size(b) + gap;
      return along(page, e, across, across ? b.x : b.y, to);
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
