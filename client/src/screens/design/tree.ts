// Finding elements and their boxes in a page's tree.

import { type Box, type Home, homeOf, leaves, type Overrides, SHAPES, union } from "../../page/PageView";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { docScope, flowOf, isNumber, isPercent, originAt, pageScope, placement, repeatScope, resolve, type Scope, sizeWord, UNIT } from "../../state/bind";
import { edit, show } from "../../state/change";
import { chain, find } from "../../state/elements";
import { notify } from "../../state/store";
import { moving, reshape } from "./geometry";

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

/** The size of what holds an element, which a percent in its placement is a share of, its
 *  origin, the point its x and y count from, and whether it lays out what it holds itself. */
export interface Room {
  w: number;
  h: number;
  ox?: number;
  oy?: number;
  flows?: boolean;
}

/** Whether a frame lays out what it holds, read where it is drawn. */
function flows(e: Element, scope: Scope): boolean {
  if (e.tag !== "div" || e.props.layout === undefined) return false;
  const r = resolve(e.props.layout, scope);
  return r.ok && flowOf(r.value) !== undefined;
}

/** Whether `e` is placed freely by `position: "absolute"`, which takes it out of its frame's
 *  flow as CSS does. */
function free(e: Element, scope: Scope): boolean {
  if (e.props.position === undefined) return false;
  const r = resolve(e.props.position, scope);
  return r.ok && r.value === "absolute";
}

/** Whether `room`'s flow places `e`: its frame lays out what it holds, and `e` is not free. */
export function flowed(e: Element, room: Room, scope: Scope = pageScope): boolean {
  return !!room.flows && !free(e, scope);
}

/** The box the editor drew an element at, from its frame's inner corner, for one the page
 *  lays out itself. A repeat's first copy stands for it, as everywhere in the editor. */
function drawn(id: string): Box | undefined {
  const el = document.querySelector<HTMLElement>(`.page-layer.open [data-id="${id}"]`);
  return el ? { x: el.offsetLeft / UNIT, y: el.offsetTop / UNIT, w: el.offsetWidth / UNIT, h: el.offsetHeight / UNIT } : undefined;
}

/** Whether the page lays out an element, or a frame around it, itself: a frame's flow or a
 *  hug or a fill. Then its box is measured from the drawn page. */
export function laidOut(page: Page, id: string): boolean {
  const path = chain(page.children, id) ?? [];
  const reads = scopes(page, path);
  // what holds each, a group passing on the frame around it
  let holder: number | null = null;
  return path.some((e, i) => {
    const laid = !!sizeWord(e.props.w) || !!sizeWord(e.props.h) || (holder !== null && flows(path[holder], reads[holder]) && !free(e, reads[i]));
    if (e.tag !== "group") holder = i;
    return laid;
  });
}

/** Whether an element is a group, of elements or of a diagram's shapes, picked whole first. */
/** What keeps elements of each home together, which grouping makes. */
const GROUPS: Record<Home, Tag> = { page: "group", diagram: "g", scene: "anchor" };

export const isGroup = (e: Element | undefined) => !!e && GROUPS[homeOf(e.tag)] === e.tag;

/** What lies under a point to pick from, given what is hit there front to back: for each, the
 *  elements around it from the outermost in, each once. */
export function stackAt(page: Page, hits: string[]): string[] {
  const out: string[] = [];
  for (const hit of hits) for (const e of chain(page.children, hit) ?? []) if (!out.includes(e.id)) out.push(e.id);
  return out;
}

/** Whether the selection is on an element or inside it. */
export function entered(page: Page, id: string, selected: string[]): boolean {
  const e = find(page.children, id);
  return selected.some((s) => s === id || (!!e && !!find(e.children, s)));
}

/** What a click picks from a point's `stack`: past the one element selected there, so each
 *  click goes one further in or beneath and then around again, else the outermost there the
 *  selection has not entered, so a frame or group is picked whole before what it holds. */
export function pickFrom(page: Page, stack: string[], selected: string[]): string | undefined {
  const one = selected.length === 1 && stack.includes(selected[0]) ? selected[0] : undefined;
  if (one) return stack[(stack.indexOf(one) + 1) % stack.length];
  return stack.find((id) => !entered(page, id, selected)) ?? stack[0];
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
export function originOf(e: Element, w: number, h: number, scope: Scope = pageScope) {
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
  // what the page lays out itself is measured as it drew it
  const placed = flowed(e, room, scope);
  const laid = placed || sizeWord(e.props.w) || sizeWord(e.props.h) ? drawn(e.id) : undefined;
  if (placed) return laid ?? { x: 0, y: 0, w: 0, h: 0 };
  const at = (k: keyof Box) => placement(e.props[k], k === "x" || k === "w" ? room.w : room.h, scope);
  const w = sizeWord(e.props.w) ? (laid?.w ?? 0) : at("w");
  const h = sizeWord(e.props.h) ? (laid?.h ?? 0) : at("h");
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
  const scope = scopeOf(page, frame!);
  const o = originOf(e, b.w, b.h, scope);
  return { at: b, room: { w: b.w, h: b.h, ox: o.x, oy: o.y, flows: flows(e, scope) } };
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

/** The edits that give an element a new origin and leave it where it is drawn: its x and y
 *  follow the point, turned as the element turns, and what it holds, placed from that point,
 *  moves back by as much. A value an expression gives stays as it is. */
export function originEdits(page: Page, id: string, origin: string | null): Edit[] {
  const e = find(page.children, id);
  if (!e) return [];
  const own: Record<string, string | null> = { origin };
  const edits: Edit[] = [{ kind: "set_props", page: page.id, id, props: own }];
  if (SHAPES.has(e.tag)) {
    Object.assign(own, turnedOutline(e, origin, scopeOf(page, id)));
    return edits;
  }
  const [room, scope] = [roomOf(page, id), scopeOf(page, id)];
  const b = boxOf(e, room, undefined, scope);
  const props = { ...e.props };
  if (origin === null) delete props.origin;
  else props.origin = origin;
  const [was, now] = [originOf(e, b.w, b.h, scope), originOf({ ...e, props }, b.w, b.h, scope)];
  const [dx, dy] = [now.x - was.x, now.y - was.y];
  if (!dx && !dy) return edits;
  // a plain number or share moved by `by`, else nothing
  const moved = (el: Element, k: "x" | "y", by: number, within: Room) => {
    const old = el.props[k];
    if (!(old === undefined || isNumber(old) || isPercent(old))) return undefined;
    return placementText(old, k, placement(old, k === "x" ? within.w : within.h) + by, within);
  };
  // the box turns about the point, so the new point sits where the turn takes it
  if (!flowed(e, room, scope)) {
    const r = resolve(e.props.rotate ?? "0", scope);
    const turn = ((r.ok && Number(r.value)) || 0) * (Math.PI / 180);
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const [x, y] = [moved(e, "x", dx * c - dy * s, room), moved(e, "y", dx * s + dy * c, room)];
    if (x !== undefined) own.x = x;
    if (y !== undefined) own.y = y;
  }
  if (e.tag !== "div" || flows(e, scope)) return edits;
  const within: Room = { w: b.w, h: b.h };
  const back = (kids: Element[]) => {
    for (const k of kids) {
      // a group passes on the frame around it
      if (k.tag === "group") {
        back(k.children);
        continue;
      }
      const [x, y] = [moved(k, "x", -dx, within), moved(k, "y", -dy, within)];
      const p: Record<string, string> = {};
      if (x !== undefined) p.x = x;
      if (y !== undefined) p.y = y;
      if (x !== undefined || y !== undefined) edits.push({ kind: "set_props", page: page.id, id: k.id, props: p });
    }
  };
  back(e.children);
  return edits;
}

/** A shape's outline moved so it stays where it is drawn while it turns about a new point of
 *  its own box: by the turn of the point's move less the move. Empty when it does not turn or
 *  an expression places it. */
function turnedOutline(e: Element, origin: string | null, scope: Scope): Record<string, string> {
  const el = document.querySelector(`.page-layer.open [data-id="${e.id}"]`);
  const r = resolve(e.props.rotate ?? "0", scope);
  const turn = ((r.ok && Number(r.value)) || 0) * (Math.PI / 180);
  if (!(el instanceof SVGGraphicsElement) || !turn) return {};
  const { width, height } = el.getBBox();
  // a shape turns about its middle until it names a point
  const point = (o: string | null | undefined) => (o === null || o === undefined ? { x: width / 2, y: height / 2 } : originOf({ ...e, props: { ...e.props, origin: o } }, width, height, scope));
  const [was, now] = [point(e.props.origin), point(origin)];
  const [dx, dy] = [now.x - was.x, now.y - was.y];
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  return reshape(e, moving((c - 1) * dx - s * dy, s * dx + (c - 1) * dy)) ?? {};
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
    room = { w: b.w, h: b.h, ox: o.x, oy: o.y, flows: flows(e, reads[i]) };
    [at.x, at.y] = [at.x + b.x, at.y + b.y];
  }
  const own = boxOf(path[path.length - 1], room, overrides, reads[path.length - 1]);
  return { ...own, x: own.x + at.x, y: own.y + at.y };
}

/** True when each of `keys` is a plain number, a plain percent or unset, so a drag may write
 *  them, and for a group so in all it holds. A shape or a part has no box of ours: its own
 *  attributes place it. */
export function literal(e: Element, keys: (keyof Box)[]): boolean {
  if (e.tag === "group") return e.children.length > 0 && e.children.every((c) => literal(c, keys));
  return homeOf(e.tag) === "page" && keys.every((k) => e.props[k] === undefined || isNumber(e.props[k]) || isPercent(e.props[k]));
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
  // a frame that lays it out places it, never its x and y
  if (flowed(e, room)) return [];
  return leaves(e)
    .filter((l) => literal(l, ["x", "y"]))
    .map((l): Edit => ({ kind: "set_props", page: page.id, id: l.id, props: shifted(l, room, dx, dy) }));
}

/** Moves a copy dx and dy across `room`, as shiftBy moves an element on the page. */
export function shiftCopy(e: Element, room: Room, dx: number, dy: number) {
  for (const l of leaves(e)) if (literal(l, ["x", "y"])) Object.assign(l.props, shifted(l, room, dx, dy));
}

/** What each holder holds: a frame or a group elements, a diagram or its group shapes, a scene
 *  or an anchor parts. */
const INSIDE: Partial<Record<Tag, Home>> = { div: "page", group: "page", svg: "diagram", g: "diagram", scene: "scene", anchor: "scene" };

/** Whether an element of `tag` holds others. */
export const isHolder = (tag: Tag) => INSIDE[tag] !== undefined;

/** Whether `parent`, or the page for null, may hold a `child`, as the backend allows. */
export function holds(parent: Tag | null, child: Tag): boolean {
  return (parent === null ? "page" : INSIDE[parent]) === homeOf(child);
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
    if (from === parent || same || flowed(e, b.room) || !literal(e, ["x", "y"])) continue;
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
  edit({ kind: "group", page: page.id, ids: picked.map((e) => e.id) });
}

/** Puts elements that share a holder into a new frame that lays them out as they stand: in a
 *  row when they spread more across than down, else a column, in that order, their average
 *  gap apart. The frame hugs them where they began, and the screen then selects it. */
export function wrap(page: Page, ids: string[]) {
  const picked = tops(page, ids).filter((e) => homeOf(e.tag) === "page");
  if (picked.length === 0) return;
  const parent = parentOf(page, picked[0].id);
  if (picked.some((e) => parentOf(page, e.id) !== parent)) return notify("Pick elements that sit in one frame to lay them out in a new one.", "warn");
  const all = picked.flatMap((e) => {
    const b = absolute(page, e.id);
    return b ? [{ e, b }] : [];
  });
  const middles = (across: boolean) => all.map(({ b }) => (across ? b.x + b.w / 2 : b.y + b.h / 2));
  const span = (across: boolean) => Math.max(...middles(across)) - Math.min(...middles(across));
  const across = span(true) >= span(false);
  all.sort((p, q) => (across ? p.b.x - q.b.x : p.b.y - q.b.y));
  const gaps = all.slice(1).map(({ b }, i) => (across ? b.x - all[i].b.x - all[i].b.w : b.y - all[i].b.y - all[i].b.h));
  const gap = gaps.length > 0 ? Math.max(0, Math.round(gaps.reduce((n, g) => n + g, 0) / gaps.length)) : 0;
  const { at, room } = inside(page, parent);
  const corner = (k: "x" | "y") => Number((Math.min(...all.map(({ b }) => b[k])) - at[k] - (room[k === "x" ? "ox" : "oy"] ?? 0)).toFixed(2));
  const props = { name: "Frame", x: String(corner("x")), y: String(corner("y")), w: "hug", h: "hug", layout: across ? '"right"' : '"down"', gap: String(gap) };
  edit({ kind: "wrap", page: page.id, ids: all.map(({ e }) => e.id), props });
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
    .filter((e) => literal(e, ["x", "y"]) && !flowed(e, roomOf(page, e.id)))
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
  if (edits.length > 0) edit(edits.length === 1 ? edits[0] : { kind: "batch", edits });
}

/** Sets props, here at once too, so a gesture right after reads what was just typed. */
export const setProps = (page: string, id: string, props: Record<string, string | null>) => edit({ kind: "set_props", page, id, props });

/** Shows props here only, as a gesture does before it lets go and keeps them with setProps.
 *  An empty or null value takes the prop away. */
export const showProps = (page: string, id: string, props: Record<string, string | null>) => show({ kind: "set_props", page, id, props });
