// The page an upright phone shows in place of a landscape one: the same elements, read in bands
// and columns and laid out again with frames, so what is too wide reflows and nothing is zoomed.
// docs/design/phone-layout.md weighs the choices.

import { createComputed, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { docScope, type Flow, flowOf, isNumber, isPercent, originAt, percentOf, placement, repeatScope, resolve, type Scope, sizeWord, UNIT } from "../state/bind";
import { component } from "../state/store";
import { type Box, leaves, union } from "./PageView";
import { copiesOf } from "./repeat";

/** The margin round the page and the space between its blocks, in units: 16 px. */
const GAP = 1.6;

/** How far a block that reflows may narrow to share a line, as a share of its designed width. */
const NARROWS = 0.75;

/** Less than this apart is touching, in units. */
const EPS = 0.01;

/** Whether an upright screen shows a page laid out again for it: one wider than tall. */
export const reflows = (page: Page) => page.width > page.height;

/** Where elements are placed: its size, where their x and y count from, and what they read. */
interface Room {
  w: number;
  h: number;
  ox: number;
  oy: number;
  scope: Scope;
}

/** An element of a room with the box it is drawn at there, and `n`, its place back to front. */
interface Item {
  e: Element;
  n: number;
  room: Room;
  box: Box;
  /** One copy's box, the same as `box` unless it repeats. */
  one: Box;
}

/** What the phone lays out as one: an element alone, several drawn as one, or a backdrop
 *  `under` the items that sit on it, which it holds on the phone. */
interface Block {
  box: Box;
  items: Item[];
  under?: Item;
}

/** A value read once, as the layout is made: what it reads is never followed. */
const read = (value: string | undefined, scope: Scope) => untrack(() => resolve(value, scope));

const num = (n: number) => String(Number(n.toFixed(3)));

/** A frame the phone page adds, named by where it sits so it keeps its name as values change. */
const frame = (id: string, props: Record<string, string>, children: Element[]): Element => ({ id, tag: "div", component: null, props, handlers: [], state: [], children });

/** `page` laid out again for an upright screen `screen` pixels across and down: one frame laid
 *  out down, as wide as the screen and as tall as it needs, holding the page's blocks. */
export function phonePage(page: Page, screen: { w: number; h: number }): Page {
  // a copy shares nothing with the store it came from, and reading it follows the whole page
  const own = JSON.parse(JSON.stringify(page)) as Page;
  const room = { w: own.width, h: own.height, ox: 0, oy: 0, scope: docScope(page) };
  const G = num(GAP);
  const props = { w: "fill", h: "hug", layout: '"down"', align: '"top center"', gap: G, padding: G, position: '"relative"' };
  const root = frame("phone", props, column(blocksOf(itemsIn(own.children, room)), screen.w / UNIT - 2 * GAP, "phone"));
  return { ...own, width: screen.w / UNIT, height: screen.h / UNIT, children: [root] };
}

/** The phone page of what `page` gives, null while it gives none, kept so what stays the same
 *  keeps its identity and only what changed redraws, as a video that keeps playing. */
export function createPhonePage(page: () => Page | null, screen: () => { w: number; h: number }): () => Page | null {
  const [kept, setKept] = createStore<{ page: Page | null }>({ page: null });
  createComputed(() => {
    const pg = page();
    setKept("page", pg ? reconcile(phonePage(pg, screen()), { key: "id" }) : null);
  });
  return () => kept.page;
}

/** Each element in `room` with the box it is drawn at, a repeat's around all its copies. */
function itemsIn(children: Element[], room: Room): Item[] {
  return children.map((e, n) => {
    const boxes = boxesOf(e, room);
    return { e, n, room, box: union(boxes), one: boxes[0] ?? union([]) };
  });
}

/** The boxes an element is drawn at in `room`: each copy's when it repeats. A group's is the
 *  box around what it holds, and a hug's size, which only the page knows, is none. */
function boxesOf(e: Element, room: Room): Box[] {
  if (e.tag === "group") return [union(e.children.flatMap((c) => boxesOf(c, room)))];
  const repeat = e.props.repeat?.trim() ? read(e.props.repeat, room.scope) : undefined;
  const scopes = repeat ? copiesOf(repeat.ok ? repeat.value : undefined).map((item, i) => repeatScope(room.scope, i, () => item)) : [room.scope];
  return scopes.map((scope) => {
    const made = e.tag === "use" ? component(e.component ?? "") : undefined;
    const size = (k: "w" | "h") => {
      const whole = k === "w" ? room.w : room.h;
      if (sizeWord(e.props[k]) === "fill") return whole;
      if (sizeWord(e.props[k]) === "hug") return made ? (k === "w" ? made.width : made.height) : 0;
      return untrack(() => placement(e.props[k], whole, scope));
    };
    const [w, h] = [size("w"), size("h")];
    const origin = read(e.props.origin, scope);
    const own = originAt(origin.ok ? origin.value : undefined, w, h);
    const at = (k: "x" | "y") => untrack(() => placement(e.props[k], k === "x" ? room.w : room.h, scope));
    return { x: room.ox + at("x") - own.x, y: room.oy + at("y") - own.y, w, h };
  });
}

/** A plain frame with nothing in it and nothing to do: a backdrop, when something sits on it. */
const plain = (e: Element) => e.tag === "div" && e.children.length === 0 && e.handlers.length === 0 && !e.props.layout && !e.props.repeat;

/** Whether an expression places it, so it may move: a group when anything in it does. */
const moves = (e: Element): boolean => leaves(e).some((l) => [l.props.x, l.props.y].some((v) => v !== undefined && !isNumber(v) && !isPercent(v)));

const overlap = (a: Box, b: Box) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

/** The blocks `items` make: a backdrop takes what is drawn on it, whose centre it holds, the
 *  smallest backdrop when several do, and blocks that overlap are drawn as one. */
function blocksOf(items: Item[]): Block[] {
  const owner = new Map<Item, Item>();
  for (const it of items) {
    const [cx, cy] = [it.box.x + it.box.w / 2, it.box.y + it.box.h / 2];
    const holds = (b: Item) => b.n < it.n && plain(b.e) && cx >= b.box.x && cx <= b.box.x + b.box.w && cy >= b.box.y && cy <= b.box.y + b.box.h;
    const under = items.filter(holds).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
    if (under) owner.set(it, under);
  }
  const on = (b: Item): Item[] => items.filter((it) => owner.get(it) === b).flatMap((it) => [it, ...on(it)]);
  const blocks = items
    .filter((it) => !owner.has(it))
    .map((it): Block => {
      const held = on(it).sort((a, b) => a.n - b.n);
      const box = union([it.box, ...held.map((h) => h.box)]);
      if (held.length === 0) return { box, items: [it] };
      // something that moves over a backdrop keeps it whole, so it moves over the same place
      return held.some((h) => moves(h.e)) ? { box, items: [it, ...held] } : { box, items: held, under: it };
    });
  const all = (b: Block) => (b.under ? [b.under, ...b.items] : b.items);
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (!overlap(blocks[i].box, blocks[j].box)) continue;
      blocks[i] = { box: union([blocks[i].box, blocks[j].box]), items: [...all(blocks[i]), ...all(blocks[j])].sort((a, b) => a.n - b.n) };
      blocks.splice(j, 1);
      // the grown block may now overlap one already passed
      j = i;
    }
  }
  return blocks;
}

/** `blocks` in bands from where an empty line runs right across them along `axis`. */
function split(blocks: Block[], axis: "x" | "y"): Block[][] {
  const size = axis === "x" ? "w" : "h";
  const out: Block[][] = [];
  let end = -Infinity;
  for (const b of [...blocks].sort((p, q) => p.box[axis] - q.box[axis])) {
    if (b.box[axis] >= end - EPS) out.push([]);
    out[out.length - 1].push(b);
    end = Math.max(end, b.box[axis] + b.box[size]);
  }
  return out;
}

/** What a frame laid out down holds for `blocks`: each band across them in turn, a band of
 *  several a row of its columns. Blocks that no line parts go in reading order. */
function column(blocks: Block[], across: number, path: string): Element[] {
  if (blocks.length === 1) return [place(blocks[0], "down", across, path)];
  const bands = split(blocks, "y");
  if (bands.length > 1) return bands.flatMap((band, i) => column(band, across, `${path}/${i}`));
  const columns = split(blocks, "x");
  if (columns.length > 1) return [row(columns, across, `${path}/r`)];
  const order = [...blocks].sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x);
  return order.map((b, i) => place(b, "down", across, `${path}/${i}`));
}

/** A row of `columns` that wraps: those that fit side by side stay so, the rest go under. */
function row(columns: Block[][], across: number, id: string): Element {
  const parts = columns.map((c, i) => {
    if (c.length === 1) return place(c[0], "right", across, `${id}/${i}`);
    const props = { h: "hug", layout: '"down"', align: '"top center"', gap: num(GAP) };
    widen(props, "right", union(c.map((b) => b.box)).w, across);
    return frame(`${id}/${i}/c`, props, column(c, across, `${id}/${i}`));
  });
  return frame(id, { w: "fill", h: "hug", layout: '"right"', wrap: "true", align: '"top center"', gap: num(GAP) }, parts);
}

/** The width a block that reflows takes in a frame laid out `along`: the whole line down a
 *  column, else a part of a row it may narrow to and grow from. */
function widen(props: Record<string, string | undefined>, along: Flow, w: number, across: number) {
  if (along === "down") {
    props.w = "fill";
    return;
  }
  if (sizeWord(props.w) !== "hug") props.w = num(Math.min(w, across) * NARROWS);
  Object.assign(props, { "flex-grow": "1", "max-width": '"100%"' });
}

/** One block as the phone shows it, in a frame laid out `along` with `across` units of room. */
function place(b: Block, along: Flow, across: number, path: string): Element {
  if (b.under) return section(b.under.e, b.items, b.box, b.under.room.scope, along, across, path);
  if (b.items.length > 1) return whole(b.items, b.box, across, path);
  const it = b.items[0];
  const { e, box } = it;
  const scope = it.room.scope;
  const made = e.tag === "use" ? component(e.component ?? "") : undefined;
  // a repeat spread over the page lays out its copies in a frame of its own
  if (box.w > it.one.w + EPS || box.h > it.one.h + EPS) {
    const flow = box.w - it.one.w >= box.h - it.one.h ? "right" : "down";
    const props = { h: "hug", layout: `"${flow}"`, wrap: "true", align: '"top center"', gap: num(GAP) };
    widen(props, along, box.w, across);
    return frame(`${path}/n`, props, [sized(it, 1)]);
  }
  if (e.tag === "group" || e.tag === "markup" || (e.tag === "svg" && e.props.viewbox === undefined)) return whole([it], box, across, path);
  // what scales itself to its box is narrowed in proportion
  if (e.tag === "media" || e.tag === "svg" || (e.tag === "use" && made?.interface?.sizing !== "fill")) return sized(it, Math.min(1, across / box.w));
  const layout = e.tag === "div" ? read(e.props.layout, scope) : undefined;
  const flow = layout?.ok ? flowOf(layout.value) : undefined;
  // a frame placing its parts freely keeps them so where it fits, else they are laid out again
  if (e.tag === "div" && e.children.length > 0 && !flow) {
    if (box.w <= across + EPS) return sized(it, 1);
    const o = read(e.props.origin, scope);
    const at = originAt(o.ok ? o.value : undefined, box.w, box.h);
    return section(e, itemsIn(e.children, { w: box.w, h: box.h, ox: at.x, oy: at.y, scope }), box, scope, along, across, path);
  }
  const props = { ...e.props };
  if (sizeWord(props.h) === "fill") props.h = num(box.h);
  widen(props, along, box.w, across);
  return narrowed({ ...e, props }, box.w, box.h, across, scope);
}

/** The element at the size it is drawn at times `k`, a fill made the number it comes to. */
function sized(it: Item, k: number): Element {
  const props = { ...it.e.props };
  for (const key of ["w", "h"] as const) {
    if (k < 1 || sizeWord(props[key]) === "fill") props[key] = num(it.one[key] * k);
  }
  return { ...it.e, props };
}

/** `items` drawn as one at their places in `box`, scaled whole to fit `across`. */
function whole(items: Item[], box: Box, across: number, path: string): Element {
  const k = Math.min(1, across / box.w);
  const inner = frame(`${path}/w`, { w: num(box.w), h: num(box.h), ...(k < 1 ? { scale: num(k) } : {}) }, items.map((it) => moved(it.e, it.room, box)));
  return k < 1 ? frame(`${path}/s`, { w: num(box.w * k), h: num(box.h * k) }, [inner]) : inner;
}

/** `e` placed from the corner of `to` in place of its room's origin, what read the room's size
 *  made numbers, so what moves still moves. A group moves what it holds. */
function moved(e: Element, room: Room, to: Box): Element {
  if (e.tag === "group") return { ...e, children: e.children.map((c) => moved(c, room, to)) };
  const props = { ...e.props };
  const whole = (k: "x" | "y" | "w" | "h") => (k === "x" || k === "w" ? room.w : room.h);
  // a share of the room becomes the units it comes to
  const units = (k: "x" | "y" | "w" | "h") => {
    const { expr, percent } = percentOf(props[k]);
    const v = expr?.trim() || "0";
    if (sizeWord(v) === "fill") return num(whole(k));
    return percent ? `(${v}) * ${num(whole(k) / 100)}` : v;
  };
  for (const [k, by] of [["x", to.x - room.ox], ["y", to.y - room.oy]] as const) {
    const v = units(k);
    props[k] = isNumber(v) ? num(Number(v) - by) : `(${v}) - ${num(by)}`;
  }
  for (const k of ["w", "h"] as const) if (props[k] !== undefined && sizeWord(props[k]) !== "hug") props[k] = units(k);
  return { ...e, props };
}

/** `e` made a frame laid out down that holds `items` laid out again inside it: a backdrop with
 *  what sits on it, or a frame too wide that placed its parts freely. */
function section(e: Element, items: Item[], box: Box, scope: Scope, along: Flow, across: number, path: string): Element {
  const G = num(GAP);
  const props: Record<string, string | undefined> = { ...e.props, h: "hug", layout: '"down"', align: '"top center"', gap: e.props.gap ?? G, padding: e.props.padding ?? G };
  widen(props, along, box.w, across);
  const [, right, , left] = sides(read(props.padding, scope));
  return { ...e, props, children: column(blocksOf(items), across - right - left, path) };
}

/** A frame that lays out its parts, drawn `w` by `h` units on the page, made to fit `to` units
 *  across, and each frame it holds with it. One laid out down grows as tall as its parts need,
 *  what fills its height narrowing with it. One laid out across wraps, at least as tall as it
 *  was, and what fills its width never narrows past what it needs, so it goes under instead. */
function narrowed(e: Element, w: number, h: number, to: number, scope: Scope): Element {
  const layout = e.tag === "div" ? read(e.props.layout, scope) : undefined;
  const flow = layout?.ok ? flowOf(layout.value) : undefined;
  if (!flow || to >= w - EPS) return e;
  const [top, right, bottom, left] = sides(read(e.props.padding, scope));
  const g = read(e.props.gap, scope);
  const gap = g.ok ? length(g.value) : 0;
  const inner = { w: w - left - right, h: h - top - bottom };
  const room = to - left - right;
  const across = flow === "right" || flow === "left";
  const along = across ? "w" : "h";
  // what fills along the flow shares what the rest leave, a hug counted as none
  const parts = e.children.flatMap(leaves);
  const fixed = parts.filter((p) => !sizeWord(p.props[along])).reduce((sum, p) => sum + untrack(() => placement(p.props[along], inner[along], scope)), 0);
  const fills = parts.filter((p) => sizeWord(p.props[along]) === "fill").length;
  const share = Math.max(0, (inner[along] - fixed - gap * (parts.length - 1)) / Math.max(1, fills));
  const fit = (p: Element): Element => {
    if (p.tag === "group") return { ...p, children: p.children.map(fit) };
    const props = { ...p.props };
    const size = (k: "w" | "h") => {
      const word = sizeWord(props[k]);
      return word === "fill" ? (k === along ? share : inner[k]) : word === "hug" ? 0 : untrack(() => placement(props[k], inner[k], scope));
    };
    const [pw, ph] = [size("w"), size("h")];
    if (across && sizeWord(props.w) === "fill") props["min-width"] ??= least(p);
    if (across && sizeWord(props.h) === "fill") props.h = num(inner.h);
    if (!across && sizeWord(props.h) === "fill") props.h = num((share * room) / inner.w);
    if (!sizeWord(props.w) && pw > room + EPS) props["max-width"] = '"100%"';
    return narrowed({ ...p, props }, pw, ph, Math.min(pw, room), scope);
  };
  const tall = across && !sizeWord(e.props.h) ? { "min-height": e.props["min-height"] ?? num(h) } : {};
  return { ...e, props: { ...e.props, h: "hug", ...(across ? { wrap: "true" } : {}), ...tall }, children: e.children.map(fit) };
}

/** The least width a part that fills a row needs: what its text or parts ask for, or for a
 *  component, whose parts ask for nothing, as much as a block that reflows may narrow to. */
function least(p: Element): string {
  const made = p.tag === "use" ? component(p.component ?? "") : undefined;
  return made ? num(made.width * NARROWS) : '"fit-content"';
}

/** A CSS length in units: a bare number is units, as the page reads it, and pixels are tenths. */
function length(v: unknown): number {
  if (typeof v === "number") return v;
  const t = String(v ?? "").trim();
  if (/^-?\d*\.?\d+$/.test(t)) return Number(t);
  return t.endsWith("px") ? parseFloat(t) / UNIT || 0 : 0;
}

/** A padding's top, right, bottom and left in units, as CSS spreads one to four of them. */
function sides(r: ReturnType<typeof read>): [number, number, number, number] {
  const v = r.ok ? r.value : undefined;
  const [top = 0, right = top, bottom = top, left = right] = typeof v === "number" ? [v] : String(v ?? "").trim().split(/\s+/).filter(Boolean).map(length);
  return [top, right, bottom, left];
}
