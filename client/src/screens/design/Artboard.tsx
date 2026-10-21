// The page on its artboard: the wheel zooms, a drag on empty space pans, elements move and
// resize on the grid (Alt slips it), and a drag writes when it ends.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Box, PageView, pageGround, SHAPES } from "../../page/PageView";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Pick } from "./DesignScreen";
import { Keyboard } from "../../ui/icons";
import { follow } from "../../ui/press";
import { UNIT } from "../../state/bind";
import { moving, type Reshape, reshape } from "./geometry";
import { canvasMenu, elementMenu } from "./menus";
import { leaves } from "../../page/PageView";
import { absolute, boxOf, boxText, find, isGroup, laidOut, literal, originOf, parentOf, pickAt, roomOf, sendEdits, setProps, showProps, tops } from "./tree";

/** Places snap to whole units. A finer one is typed as a fraction, or dragged with Alt, which
 *  lands on pixels, a tenth of a unit. */
export const GRID = 1;
/** Shift's nudge, in units. */
export const STEP = 4;
/** Grid lines every so many units and how strong each set is. A set fades out as its lines
 *  close up on screen, so zoomed out the grid thins instead of turning grey. */
const LEVELS = [
  [GRID, 0.045],
  [GRID * 4, 0.06],
  [GRID * 16, 0.06],
] as const;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

/** Each grip's direction on an unturned box, in degrees clockwise from east. */
const AIMS: Record<Handle, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];

/** The resize cursor nearest a grip's direction once its element turns `turn` degrees. */
function cursorOf(h: Handle, turn: number): string {
  const along = (((AIMS[h] + turn) % 180) + 180) % 180;
  return CURSORS[Math.round(along / 45) % 4];
}

/** What each key and gesture does here, as the keys list shows it. */
const KEYS: [string, string][] = [
  ["Wheel", "zoom about the pointer"],
  ["Drag on empty space", "pan, as the middle button does"],
  ["Click", "select"],
  ["Click a group", "select it whole, click again for the part"],
  ["Shift or Ctrl click", "add to the selection or take away"],
  ["Shift drag on empty space", "add what lies wholly inside"],
  ["Ctrl A", "select everything on the page"],
  ["Drag", "move by whole units, Alt by pixels"],
  ["Arrows", "nudge a unit, Shift four, Alt a pixel"],
  ["Double click", "type into the element's field"],
  ["Delete", "remove"],
  ["Ctrl D", "duplicate"],
  ["Ctrl G", "group, Ctrl Shift G ungroups"],
  ["Ctrl C, X, V", "copy, cut and paste"],
  ["Ctrl [ and ]", "send back, bring forward, Shift all the way"],
  ["Ctrl Z", "undo, Ctrl Shift Z or Ctrl Y redoes"],
  ["Escape", "let go"],
];

/** A pan, a box drawn to select, or a move or resize of `ids` led by the one under the pointer.
 *  `enter` is what a press inside a selected group picks when it lets go unmoved. */
type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "box"; sx: number; sy: number }
  | { kind: "move" | Handle; lead: string; ids: string[]; sx: number; sy: number; bases: Record<string, Box>; boxes: Record<string, Box>; n: number; enter?: string; turn: Turns }
  | { kind: "shape"; how: "move" | Handle; id: string; sx: number; sy: number; base: Element; screen: DOMMatrix; outline: DOMRect; props: Record<string, string> | null; enter?: string };

/** A box shown in place of an element's own until the page carries it. `n` names the drag
 *  that made it, so a finished drag never clears a newer one's box. */
type Held = Record<string, { box: Box; n: number }>;

function keysFor(kind: "move" | Handle): (keyof Box)[] {
  if (kind === "move") return ["x", "y"];
  const keys: (keyof Box)[] = [];
  if (kind.includes("w")) keys.push("x", "w");
  if (kind.includes("e")) keys.push("w");
  if (kind.includes("n")) keys.push("y", "h");
  if (kind.includes("s")) keys.push("h");
  return keys;
}

function snap(v: number, free: boolean) {
  return free ? Math.round(v * UNIT) / UNIT : Math.round(v / GRID) * GRID;
}

/** How an element is turned as drawn, in degrees clockwise: by its own rotation, and by those
 *  of the frames around it, which turn the room it sits in. */
type Turns = { own: number; room: number };

/** A vector turned clockwise by `deg`, on a page whose y runs down. */
function turned(x: number, y: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
}

/** A box resized by a grip pulled `dx`, `dy` in its room, along its own turned sides. The side
 *  or corner across from the grip stays where it is drawn, wherever the element turns about. */
function resized(e: Element, kind: Handle, b: Box, dx: number, dy: number, turn: number, free: boolean): Box {
  const [du, dv] = turned(dx, dy, -turn);
  let [w, h] = [b.w, b.h];
  if (kind.includes("e")) w = Math.max(GRID, snap(b.w + du, free));
  if (kind.includes("w")) w = Math.max(GRID, snap(b.w - du, free));
  if (kind.includes("s")) h = Math.max(GRID, snap(b.h + dv, free));
  if (kind.includes("n")) h = Math.max(GRID, snap(b.h - dv, free));
  const across = (ww: number, hh: number) => ({ x: kind.includes("w") ? ww : kind.includes("e") ? 0 : ww / 2, y: kind.includes("n") ? hh : kind.includes("s") ? 0 : hh / 2 });
  const [own, now] = [originOf(e, b.w, b.h), originOf(e, w, h)];
  const [a, z] = [across(b.w, b.h), across(w, h)];
  // the origin moves so the far side, turned about it, lands where it was
  const [px, py] = turned(a.x - own.x - (z.x - now.x), a.y - own.y - (z.y - now.y), turn);
  return { x: b.x + own.x + px - now.x, y: b.y + own.y + py - now.y, w, h };
}

/** A shape scaled by a grip, about the far side of its outline. A flat side, as a level
 *  line's height, has nothing to scale. */
function scaling(h: Handle, b: DOMRect, du: number, dv: number): Reshape {
  const by = (size: number, grow: number) => (size > 0 ? Math.max(0.05, (size + grow) / size) : 1);
  return {
    sx: h.includes("e") ? by(b.width, du) : h.includes("w") ? by(b.width, -du) : 1,
    sy: h.includes("s") ? by(b.height, dv) : h.includes("n") ? by(b.height, -dv) : 1,
    ax: h.includes("w") ? b.x + b.width : b.x,
    ay: h.includes("n") ? b.y + b.height : b.y,
    dx: 0,
    dy: 0,
  };
}

/** Light lines on a dark page, dark ones on a light page. */
function ink(g: CanvasRenderingContext2D, ground: string): string {
  g.fillStyle = ground;
  const hex = /^#([0-9a-f]{6})$/i.exec(String(g.fillStyle))?.[1];
  if (!hex) return "255, 255, 255";
  const [r, gr, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * gr + 0.0722 * b > 128 ? "0, 0, 0" : "255, 255, 255";
}

export function Artboard(p: {
  page: Page;
  selected: string[];
  onPick: Pick;
  onEdit: (id: string) => void;
  /** Whether the keys list shows. */
  keys: boolean;
  onKeys: (shown: boolean) => void;
}) {
  let host!: HTMLDivElement;
  let grid!: HTMLCanvasElement;
  /** Where the page sits on screen, and `k` screen pixels per unit. */
  const [view, setView] = createSignal({ k: UNIT / 2, x: 0, y: 0 });
  const [held, setHeld] = createSignal<Held>({});
  /** The box a Shift drag draws, on screen. */
  const [box, setBox] = createSignal<{ left: number; top: number; width: number; height: number } | null>(null);
  const overrides = (id: string) => held()[id]?.box;
  const release = (id: string, n?: number) =>
    setHeld((all) => (all[id] && (n === undefined || all[id].n === n) ? Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)) : all));
  let drag: Drag | null = null;
  let drags = 0;

  let fittedFor = "";
  const fit = () => {
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const k = Math.min((r.width - 64) / p.page.width, (r.height - 64) / p.page.height);
    setView({ k, x: (r.width - p.page.width * k) / 2, y: (r.height - p.page.height * k) / 2 });
    fittedFor = p.page.id;
  };
  // the page's ground and its grid, drawn at screen size so every line is one crisp pixel
  const draw = () => {
    const r = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const [cw, ch] = [Math.round(r.width * dpr), Math.round(r.height * dpr)];
    if (grid.width !== cw || grid.height !== ch) [grid.width, grid.height] = [cw, ch];
    const g = grid.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, cw, ch);
    const v = view();
    // the page's fill, else the default its style gives
    const sheet = host.querySelector<HTMLElement>(".page");
    const ground = pageGround(p.page) ?? ((sheet && getComputedStyle(sheet).getPropertyValue("--page-ground").trim()) || "#000000");
    const [x0, y0] = [Math.round(v.x * dpr), Math.round(v.y * dpr)];
    const [x1, y1] = [Math.round((v.x + p.page.width * v.k) * dpr), Math.round((v.y + p.page.height * v.k) * dpr)];
    const lines = ink(g, ground);
    g.save();
    g.shadowColor = "rgba(0, 0, 0, 0.45)";
    g.shadowBlur = 30 * dpr;
    g.shadowOffsetY = 10 * dpr;
    g.fillStyle = ground;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.restore();
    const width = Math.max(1, Math.round(dpr));
    for (const [step, strength] of LEVELS) {
      const a = strength * Math.min(1, Math.max(0, (step * v.k - 4) / 8));
      if (a <= 0) continue;
      g.fillStyle = `rgba(${lines}, ${a})`;
      for (let u = step; u < p.page.width; u += step) g.fillRect(Math.round((v.x + u * v.k) * dpr), y0, width, y1 - y0);
      for (let u = step; u < p.page.height; u += step) g.fillRect(x0, Math.round((v.y + u * v.k) * dpr), x1 - x0, width);
    }
  };
  createEffect(draw);

  onMount(() => {
    // fits once the artboard first has a size, and again for each page opened
    const watch = new ResizeObserver(() => (fittedFor !== p.page.id ? fit() : draw()));
    watch.observe(host);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view();
      const r = host.getBoundingClientRect();
      const [px, py] = [e.clientX - r.left, e.clientY - r.top];
      // a wheel's notch, a trackpad's glide and a pinch all zoom, never by a leap
      const dy = Math.max(-120, Math.min(120, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY));
      const k = Math.min(8 * UNIT, Math.max(0.1 * UNIT, v.k * Math.exp(-dy * 0.002)));
      setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
    };
    host.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => {
      watch.disconnect();
      host.removeEventListener("wheel", wheel);
    });
  });
  createEffect(() => {
    if (p.page.id !== fittedFor) fit();
  });

  // a written drag keeps showing until the page carries its numbers, so nothing jumps back.
  // The page is read before the skip, so its numbers arriving after the drag run this again.
  createEffect(() => {
    const h = held();
    for (const id of Object.keys(h)) {
      const e = find(p.page.children, id);
      const now = e && boxOf(e, roomOf(p.page, id));
      const carried = !now || (["x", "y", "w", "h"] as const).every((k) => Math.abs(now[k] - h[id].box[k]) < 0.01);
      if (carried && !(drag && "ids" in drag && drag.ids.includes(id))) release(id);
    }
  });

  const down = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    const v = view();
    // a field being typed in commits before the canvas takes over
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (e.button === 1) {
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
    } else if (e.button === 0) {
      const handle = target.closest("[data-handle]")?.getAttribute("data-handle") as Handle | null;
      const deepest = target.closest(".el[data-id]")?.getAttribute("data-id") ?? null;
      const hit = deepest && pickAt(p.page, deepest, p.selected);
      // a selected group the press is inside, which it moves rather than picking into at once
      const holder = deepest && hit ? p.selected.find((id) => id !== hit && isGroup(find(p.page.children, id)) && !!find(find(p.page.children, id)!.children, deepest)) : undefined;
      // a group moves by what it holds, led by the box around them
      const start = (kind: "move" | Handle, lead: string, group: Element[], enter?: string) => {
        const all = group.flatMap((g) => (g.tag === "group" ? [g, ...leaves(g)] : [g]));
        const bases = Object.fromEntries(all.map((g) => [g.id, boxOf(g, roomOf(p.page, g.id))]));
        drag = { kind, lead, ids: all.map((g) => g.id), sx: e.clientX, sy: e.clientY, bases, boxes: { ...bases }, n: ++drags, enter, turn: turnsOf(lead) };
      };
      // a shape's own attributes move and scale it, in its drawing's units
      const startShape = (how: "move" | Handle, id: string) => {
        const el = host.querySelector(`.page-layer [data-id="${id}"]`);
        const base = find(p.page.children, id);
        const screen = el instanceof SVGGraphicsElement ? (el.parentNode as SVGGraphicsElement).getScreenCTM() : null;
        if (!(el instanceof SVGGraphicsElement) || !base || !screen || !reshape(base, moving(0, 0))) return;
        const props = { ...base.props };
        drag = { kind: "shape", how, id, sx: e.clientX, sy: e.clientY, base: { ...base, props }, screen, outline: el.getBBox(), props: null };
      };
      if (handle && p.selected.length === 1 && shape(p.selected[0])) {
        startShape(handle, p.selected[0]);
      } else if (handle && p.selected.length === 1) {
        const one = find(p.page.children, p.selected[0]);
        if (one && movable(one, keysFor(handle))) start(handle, one.id, [one]);
      } else if (hit && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        return p.onPick(hit, true);
      } else if (holder && hit && shape(holder)) {
        startShape("move", holder);
        if (drag?.kind === "shape") drag.enter = hit;
      } else if (holder && hit) {
        const group = tops(p.page, p.selected).filter((g) => movable(g, ["x", "y"]));
        if (group.some((g) => g.id === holder)) start("move", holder, group, hit);
        else p.onPick(hit);
      } else if (hit && shape(hit)) {
        p.onPick(hit);
        startShape("move", hit);
      } else if (hit) {
        // a press on one of several selected moves them all, any other picks it alone
        const keep = p.selected.length > 1 && p.selected.includes(hit);
        if (!keep) p.onPick(hit);
        const group = (keep ? tops(p.page, p.selected) : [find(p.page.children, hit)!]).filter((g) => movable(g, ["x", "y"]));
        if (group.some((g) => g.id === hit)) start("move", hit, group);
      } else if (e.shiftKey) {
        drag = { kind: "box", sx: e.clientX, sy: e.clientY };
      } else {
        p.onPick(null);
        drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      }
    }
    if (!drag) return;
    host.setPointerCapture(e.pointerId);
    follow(e, { move, end: up });
  };

  const move = (e: PointerEvent) => {
    if (!drag) return;
    const [dx, dy] = [e.clientX - drag.sx, e.clientY - drag.sy];
    if (drag.kind === "pan") {
      setView({ ...view(), x: drag.vx + dx, y: drag.vy + dy });
      return;
    }
    if (drag.kind === "box") {
      const r = host.getBoundingClientRect();
      setBox({ left: Math.min(drag.sx, e.clientX) - r.left, top: Math.min(drag.sy, e.clientY) - r.top, width: Math.abs(dx), height: Math.abs(dy) });
      return;
    }
    if (drag.kind === "shape") {
      // the pointer's travel in the drawing's units, whole ones unless Alt
      const m = drag.screen.inverse();
      const unit = (v: number) => (e.altKey ? Number(v.toFixed(2)) : Math.round(v));
      const [du, dv] = [unit(m.a * dx + m.c * dy), unit(m.b * dx + m.d * dy)];
      const props = reshape(drag.base, drag.how === "move" ? moving(du, dv) : scaling(drag.how, drag.outline, du, dv));
      if (props) {
        drag.props = props;
        showProps(p.page.id, drag.id, props);
      }
      return;
    }
    const d = drag;
    const k = view().k;
    const lead = d.bases[d.lead];
    // the pointer's travel in the room the elements sit in, which frames around may turn
    const [rx, ry] = turned(dx / k, dy / k, -d.turn.room);
    const one = find(p.page.children, d.lead);
    const moved =
      d.kind === "move" || !one ? { ...lead, x: snap(lead.x + rx, e.altKey), y: snap(lead.y + ry, e.altKey) } : resized(one, d.kind, lead, rx, ry, d.turn.own, e.altKey);
    // the others keep their places against the one under the pointer
    for (const id of d.ids) {
      const b = d.bases[id];
      d.boxes[id] = id === d.lead ? moved : { ...b, x: b.x + moved.x - lead.x, y: b.y + moved.y - lead.y };
    }
    setHeld({ ...held(), ...Object.fromEntries(d.ids.map((id) => [id, { box: d.boxes[id], n: d.n }])) });
  };

  // a menu opening mid gesture, as a long press opens one, puts it back where it began
  const cancel = () => {
    const d = drag;
    drag = null;
    if (!d || d.kind === "pan") return;
    if (d.kind === "box") setBox(null);
    else if (d.kind === "shape") d.props && showProps(p.page.id, d.id, Object.fromEntries(Object.keys(d.props).map((k) => [k, d.base.props[k] ?? null])));
    else d.ids.forEach((id) => release(id, d.n));
  };

  const up = () => {
    const d = drag;
    drag = null;
    if (d?.kind === "box") return takeBox();
    if (d?.kind === "shape") {
      const moved = !!d.props && Object.entries(d.props).some(([k, v]) => d.base.props[k] !== v);
      if (!moved && d.enter) p.onPick(d.enter);
      return moved && setProps(p.page.id, d.id, d.props!);
    }
    if (!d || d.kind === "pan") return;
    const edits: Edit[] = [];
    for (const id of d.ids) {
      const props: Record<string, string> = {};
      const [e, room] = [find(p.page.children, id), roomOf(p.page, id)];
      // a group has no place of its own: what it holds moved
      if (e?.tag === "group") {
        release(id, d.n);
        continue;
      }
      for (const k of ["x", "y", "w", "h"] as (keyof Box)[]) {
        // a new size moves the origin, so x and y follow w and h
        const changed = (key: keyof Box) => d.boxes[id][key] !== d.bases[id][key];
        if (e && (changed(k) || (k === "x" && changed("w")) || (k === "y" && changed("h")))) props[k] = boxText(e, k, d.boxes[id], room);
      }
      if (Object.keys(props).length > 0) edits.push({ kind: "set_props", page: p.page.id, id, props });
      else release(id, d.n);
    }
    sendEdits(edits);
    if (edits.length === 0 && d.enter) p.onPick(d.enter);
    // a refused write must not hold its boxes forever
    window.setTimeout(() => d.ids.forEach((id) => release(id, d.n)), 3000);
  };

  // what lies wholly inside the drawn box joins the selection
  const takeBox = () => {
    const b = box();
    setBox(null);
    if (!b) return;
    const v = view();
    const [x0, y0] = [(b.left - v.x) / v.k, (b.top - v.y) / v.k];
    const [x1, y1] = [x0 + b.width / v.k, y0 + b.height / v.k];
    for (const e of p.page.children) {
      const at = boxOf(e, { w: p.page.width, h: p.page.height });
      if (at.x >= x0 && at.y >= y0 && at.x + at.w <= x1 && at.y + at.h <= y1 && !p.selected.includes(e.id)) p.onPick(e.id, true);
    }
  };

  // the page at its true size, about the middle of the view
  const actual = () => {
    const r = host.getBoundingClientRect();
    const v = view();
    const [cx, cy] = [r.width / 2, r.height / 2];
    setView({ k: UNIT, x: cx - ((cx - v.x) / v.k) * UNIT, y: cy - ((cy - v.y) / v.k) * UNIT });
  };

  const sheet = () => {
    const v = view();
    return { left: `${v.x}px`, top: `${v.y}px`, width: `${p.page.width * v.k}px`, height: `${p.page.height * v.k}px` };
  };

  // a shape's attributes place it, and the page lays some elements out itself, so their rings
  // are measured from the drawn page, each frame while one is picked, as live values may move it
  const shape = (id: string) => SHAPES.has(find(p.page.children, id)?.tag ?? "");
  const measuredOne = (id: string) => shape(id) || laidOut(p.page, id);
  // what a drag may move or size: numbers it can write, and a place no frame's flow sets
  const movable = (e: Element, keys: (keyof Box)[]) => literal(e, keys) && !roomOf(p.page, e.id).flows;
  // what holds the picked elements, outlined faintly so their bounds show
  const parents = () => [...new Set(p.selected.map((id) => parentOf(p.page, id)))].filter((id): id is string => !!id && !p.selected.includes(id));
  const [measured, setMeasured] = createSignal<Record<string, DOMRect>>({});
  createEffect(() => {
    const ids = [...p.selected, ...parents()].filter(measuredOne);
    if (ids.length === 0) return;
    let frame = requestAnimationFrame(function measure() {
      const at: Record<string, DOMRect> = {};
      for (const id of ids) {
        const el = host.querySelector(`.page-layer [data-id="${id}"]`);
        if (el) at[id] = el.getBoundingClientRect();
      }
      setMeasured(at);
      frame = requestAnimationFrame(measure);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // how the one picked element turns as drawn, each frame while it is picked, as live values
  // may turn it: its angle, the point it turns about from its corner, and that point on screen
  const [turn, setTurn] = createSignal<{ id: string; angle: number; room: number; ox: number; oy: number; at: { x: number; y: number } } | null>(null);
  createEffect(() => {
    const id = p.selected.length === 1 ? p.selected[0] : null;
    setTurn(null);
    if (!id) return;
    let frame = requestAnimationFrame(function measure() {
      setTurn(turnOf(id));
      frame = requestAnimationFrame(measure);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const turnsOf = (id: string): Turns => {
    const el = host.querySelector(`.page-layer [data-id="${id}"]`);
    const angle = (x: globalThis.Element) => parseFloat(getComputedStyle(x).rotate) || 0;
    let room = 0;
    for (let a = el?.parentElement?.closest(".el"); a; a = a.parentElement?.closest(".el")) room += angle(a);
    return { own: el ? angle(el) : 0, room };
  };
  const turnOf = (id: string) => {
    const el = host.querySelector(`.page-layer [data-id="${id}"]`);
    if (!el) return null;
    const style = getComputedStyle(el);
    const angle = parseFloat(style.rotate) || 0;
    const room = turnsOf(id).room;
    // a frame's point in its own units, a shape's in its drawing's
    const [ox, oy] = style.transformOrigin.split(" ").map((t) => parseFloat(t) / (el instanceof SVGGraphicsElement ? 1 : UNIT));
    const r = host.getBoundingClientRect();
    if (el instanceof SVGGraphicsElement) {
      // a shape turns about a point of its own outline's box, in the drawing's units
      const b = el.getBBox();
      const m = (el.parentNode as SVGGraphicsElement).getScreenCTM();
      if (!m) return null;
      const at = new DOMPoint(b.x + ox, b.y + oy).matrixTransform(m);
      return { id, angle, room, ox, oy, at: { x: at.x - r.left, y: at.y - r.top } };
    }
    const b = absolute(p.page, id, overrides);
    if (!b) return null;
    const v = view();
    return { id, angle, room, ox, oy, at: { x: v.x + (b.x + ox) * v.k, y: v.y + (b.y + oy) * v.k } };
  };
  // a shape shows grips while its attributes can scale, as a group's transform cannot
  const scales = (id: string) => {
    const e = find(p.page.children, id);
    return !!e && reshape(e, { sx: 2, sy: 2, ax: 0, ay: 0, dx: 0, dy: 0 }) !== null;
  };
  // a flat side, as a level line's, has nothing to scale, and its grips would cover the
  // middle a press moves it by
  // and a size the page sets, as a hug's, has none to pull
  const grips = (id: string) => {
    const m = shape(id) ? measured()[id] : undefined;
    const e = find(p.page.children, id);
    return HANDLES.filter((h) => !(m && m.height < 2 && /^[ns]$/.test(h)) && !(m && m.width < 2 && /^[ew]$/.test(h)) && (shape(id) || (!!e && literal(e, keysFor(h)))));
  };
  // the point shows once the element says how it turns
  const turns = (id: string) => {
    const e = find(p.page.children, id);
    return !!e && (e.props.rotate !== undefined || e.props.origin !== undefined);
  };

  /** Where an element's ring goes on screen, on whole pixels so its thin line stays crisp. */
  const ring = (id: string) => {
    if (shape(id)) {
      const m = measured()[id];
      const r = host.getBoundingClientRect();
      if (!m) return undefined;
      const [left, top] = [Math.round(m.left - r.left), Math.round(m.top - r.top)];
      return { left: `${left}px`, top: `${top}px`, width: `${Math.round(m.right - r.left) - left}px`, height: `${Math.round(m.bottom - r.top) - top}px` };
    }
    // laid out by the page, it is read again each frame
    if (laidOut(p.page, id)) measured();
    const b = absolute(p.page, id, overrides);
    if (!b) return undefined;
    const v = view();
    const [left, top] = [Math.round(v.x + b.x * v.k), Math.round(v.y + b.y * v.k)];
    const [right, bottom] = [Math.round(v.x + (b.x + b.w) * v.k), Math.round(v.y + (b.y + b.h) * v.k)];
    // a frame's ring turns with it
    const t = turn();
    const turned = t?.id === id && t.angle !== 0 ? { transform: `rotate(${t.angle}deg)`, "transform-origin": `${t.ox * v.k}px ${t.oy * v.k}px` } : {};
    return { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`, ...turned };
  };

  return (
    <div
      class="artboard"
      ref={host}
      onPointerDown={down}
      onContextMenu={(e) => {
        cancel();
        const deepest = (e.target as HTMLElement).closest(".el[data-id]")?.getAttribute("data-id");
        const hit = deepest && pickAt(p.page, deepest, p.selected);
        const [r, v] = [host.getBoundingClientRect(), view()];
        const at = { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
        if (hit) elementMenu(e, p.page, p.selected, p.onPick, hit, at);
        else canvasMenu(e, p.page, at, p.onPick, () => p.page.children.forEach((c) => p.onPick(c.id, true)));
      }}
      onDblClick={(e) => {
        // the press captured the pointer, so the target is the artboard: look beneath it
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest(".el[data-id]")?.getAttribute("data-id");
        if (hit) p.onEdit(hit);
      }}
    >
      <canvas class="artboard-grid" ref={grid} />
      <div class="page-layer" style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().k / UNIT})` }}>
        <PageView page={p.page} overrides={overrides} design />
      </div>
      <div class="veil" style={sheet()} />
      <Show when={box()}>{(b) => <div class="marquee" style={{ left: `${b().left}px`, top: `${b().top}px`, width: `${b().width}px`, height: `${b().height}px` }} />}</Show>
      <For each={parents()}>{(id) => <Show when={ring(id)}>{(r) => <div class="holder" style={r()} />}</Show>}</For>
      {/* a ring for each selected element, its grips only when it is the one */}
      <For each={p.selected}>
        {(id) => (
          <Show when={ring(id)}>
            {(r) => (
              <div class="ring" style={r()}>
                <Show when={p.selected.length === 1 && (!shape(id) || scales(id)) && find(p.page.children, id)?.tag !== "group" && !roomOf(p.page, id).flows}>
                  <For each={grips(id)}>{(h) => <span class={`handle ${h}`} data-handle={h} style={{ cursor: cursorOf(h, turn()?.id === id ? turn()!.angle + turn()!.room : 0) }} />}</For>
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
      <Show when={turn() && turns(turn()!.id) && turn()}>{(t) => <div class="origin" style={{ left: `${t().at.x}px`, top: `${t().at.y}px` }} />}</Show>
      <div class="zoom">
        <button class="icon-btn mono" title="Show at 100%" onClick={actual} onPointerDown={(e) => e.stopPropagation()}>
          {Math.round((view().k / UNIT) * 100)}%
        </button>
        <button class="icon-btn" title="Fit the page" onClick={fit} onPointerDown={(e) => e.stopPropagation()}>
          Fit
        </button>
        <button class="icon-btn" classList={{ on: p.keys }} title="Keys (?)" onClick={() => p.onKeys(!p.keys)} onPointerDown={(e) => e.stopPropagation()}>
          <Keyboard size={14} />
        </button>
      </div>
      <Show when={p.keys}>
        <div class="keys" onPointerDown={(e) => e.stopPropagation()}>
          <For each={KEYS}>
            {([key, does]) => (
              <>
                <span class="key">{key}</span>
                <span>{does}</span>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
