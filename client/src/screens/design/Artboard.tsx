// The page on its artboard, or as an upright phone lays it out: the wheel or a pinch zooms, a
// drag on empty space or with two fingers pans, elements move and resize on the grid (Alt
// slips it), and a drag writes when it ends.

import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { type Box, fitIn, homeOf, leaves, PageView, pageGround, SHAPES, union } from "../../page/PageView";
import { createPhonePage, reflows } from "../../page/phone";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Pick } from "./DesignScreen";
import { Keyboard, Smartphone } from "../../ui/icons";
import { fingers } from "../../ui/fingers";
import { follow } from "../../ui/press";
import { fingered } from "../../ui/touch";
import { createSize, onResize } from "../../ui/size";
import { wheelPx, zoomBy } from "../../ui/wheel";
import { type Flow, flowOf, resolve, sizeWord, UNIT } from "../../state/bind";
import { find } from "../../state/elements";
import { moving, type Reshape, reshape } from "./geometry";
import { canvasMenu, elementMenu } from "./menus";
import { absolute, boxOf, boxText, childrenOf, entered, flowed, laidOut, literal, moveTo, originOf, parentOf, pickFrom, roomOf, scopeOf, sendEdits, setProps, showProps, stackAt, tops } from "./tree";

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
/** Under a finger a side shorter on screen than this keeps its corner grips alone, so a press
 *  in the middle of a small element still moves it. */
const SIDE = 48;
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
  ["Click", "select the outermost element there"],
  ["Click again", "the next one there, further in, then beneath"],
  ["Shift or Ctrl click", "add to the selection or take away"],
  ["Shift drag on empty space", "add what lies wholly inside"],
  ["Ctrl A", "select everything on the page"],
  ["Drag", "move by whole units, Alt by pixels"],
  ["Drag a grip", "resize, several or a group all together"],
  ["Arrows", "nudge a unit, Shift four, Alt a pixel"],
  ["Double click", "type into the element's field"],
  ["Delete", "remove"],
  ["Ctrl D", "duplicate"],
  ["Ctrl G", "group, Ctrl Shift G ungroups"],
  ["Shift A", "lay out in a new frame"],
  ["Ctrl C, X, V", "copy, cut and paste"],
  ["Ctrl [ and ]", "send back, bring forward, Shift all the way"],
  ["Ctrl Z", "undo, Ctrl Shift Z or Ctrl Y redoes"],
  ["Escape", "let go"],
];

/** A pan, a box drawn to select, a part dragged along its frame's flow to `slot`, or a move or
 *  resize of `ids` led by the one under the pointer, or scaled together by the box `around`
 *  them. `enter` is what a press on the selected element picks when it lets go unmoved: the
 *  next one at that point. */
type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "box"; sx: number; sy: number }
  | { kind: "reorder"; id: string; parent: string; flow: Flow; sx: number; sy: number; slot: number | null; enter?: string }
  | { kind: "move" | Handle; lead: string; ids: string[]; sx: number; sy: number; bases: Record<string, Box>; boxes: Record<string, Box>; n: number; enter?: string; turn: Turns; around?: Around }
  | { kind: "shape"; how: "move" | Handle; id: string; sx: number; sy: number; base: Element; screen: DOMMatrix; outline: DOMRect; props: Record<string, string> | null; enter?: string };

/** The box around several elements or a group's parts on the page as a scale began, and how far
 *  each one's room sits from the page's corner. */
type Around = { base: Box; offsets: Record<string, { x: number; y: number }> };

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

/** An upright phone's screen in CSS pixels, the one the preview lays a page out for. */
const PHONE = { w: 390, h: 844 };

/** Why a phone shows a page as it is, or nothing when it lays it out again. */
function asDesigned(page: Page): string | undefined {
  if (page.interface !== null) return "A component shows on a phone where its page places it";
  if (page.shows !== "full") return "A page over another shows on a phone as it is";
  if (!reflows(page)) return "A page taller than wide shows on a phone as it is";
  return undefined;
}

/** Screen pixels per unit, kept to where the page still reads. */
const zoomed = (k: number) => Math.min(8 * UNIT, Math.max(0.1 * UNIT, k));

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

/** Where a point `v` along one side lands as the span from `from` of `size` becomes the one from
 *  `to` of `next`: on the grid, unless it stays where it was. */
function rescaled(v: number, from: number, size: number, to: number, next: number, free: boolean): number {
  const at = to + (size > 0 ? ((v - from) * next) / size : v - from);
  return Math.abs(at - v) < 1e-6 ? v : snap(at, free);
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
  /** The line where a part dragged along a flow would go, on the page. */
  const [slotLine, setSlotLine] = createSignal<Box | null>(null);
  /** Whether the page shows as an upright phone lays it out, and that phone page while it does. */
  const [phoneOn, setPhoneOn] = createSignal(false);
  const preview = createPhonePage(() => (phoneOn() && !asDesigned(p.page) ? p.page : null), () => PHONE);
  // a phone page is as tall as what it holds, so its ground is measured as drawn
  const drawn = createSize();
  const size = () => {
    const phone = preview();
    return phone ? { width: phone.width, height: Math.max(phone.height, drawn().h / UNIT) } : p.page;
  };
  const overrides = (id: string) => held()[id]?.box;
  const release = (id: string, n?: number) =>
    setHeld((all) => (all[id] && (n === undefined || all[id].n === n) ? Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)) : all));
  let drag: Drag | null = null;
  let drags = 0;
  /** The pinch two fingers make: how far apart they began, their middle then and the view then. */
  let pinch: { d: number; cx: number; cy: number; view: { k: number; x: number; y: number } } | null = null;

  // each page fits when it opens, and again as the preview comes or goes, a phone page by the
  // phone's screen, however far down it runs
  let fittedFor = "";
  const fitKey = () => `${p.page.id}${preview() ? " phone" : ""}`;
  const fit = () => {
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const screen = preview() ?? p.page;
    // a 32 px margin all round
    const f = fitIn(screen.width, screen.height, { w: r.width - 64, h: r.height - 64 });
    setView({ k: f.k, x: f.x + 32, y: f.y + 32 });
    fittedFor = fitKey();
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
    const [x1, y1] = [Math.round((v.x + size().width * v.k) * dpr), Math.round((v.y + size().height * v.k) * dpr)];
    const lines = ink(g, ground);
    g.save();
    g.shadowColor = "rgba(0, 0, 0, 0.45)";
    g.shadowBlur = 30 * dpr;
    g.shadowOffsetY = 10 * dpr;
    g.fillStyle = ground;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.restore();
    // the phone lays the blocks out, so no grid shows
    if (preview()) return;
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
    onResize(host, () => {
      if (fittedFor !== fitKey()) return fit();
      draw();
      keep();
    });
    drawn.track(host.querySelector<HTMLElement>(".page-layer .page")!);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view();
      const r = host.getBoundingClientRect();
      const [px, py] = [e.clientX - r.left, e.clientY - r.top];
      // a wheel's notch, a trackpad's glide and a pinch all zoom
      const k = zoomed(v.k * zoomBy(wheelPx(e, r).y));
      setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
    };
    host.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => host.removeEventListener("wheel", wheel));
  });
  createEffect(() => {
    if (fitKey() !== fittedFor) fit();
  });

  // a written drag keeps showing until the page carries its numbers, so nothing jumps back.
  // The page is read before the skip, so its numbers arriving after the drag run this again.
  createEffect(() => {
    const h = held();
    for (const id of Object.keys(h)) {
      const e = find(p.page.children, id);
      const room = roomOf(p.page, id);
      const now = e && boxOf(e, room);
      // a part its frame lays out is placed by the frame, so only its size is carried
      const keys = e && flowed(e, room) ? (["w", "h"] as const) : (["x", "y", "w", "h"] as const);
      const carried = !now || keys.every((k) => Math.abs(now[k] - h[id].box[k]) < 0.01);
      if (carried && !(drag && "ids" in drag && drag.ids.includes(id))) release(id);
    }
  });

  // a second finger puts back what the first began and pinches. The point of the page under the
  // fingers' middle stays under it as they spread and move
  const finger = fingers({
    begin: (at) => {
      cancel();
      const r = host.getBoundingClientRect();
      pinch = { d: at.spread, cx: at.clientX - r.left, cy: at.clientY - r.top, view: view() };
      return true;
    },
    move: (at) => {
      if (!pinch) return;
      const r = host.getBoundingClientRect();
      const [cx, cy] = [at.clientX - r.left, at.clientY - r.top];
      const v = pinch.view;
      const k = zoomed((v.k * at.spread) / pinch.d);
      setView({ k, x: cx - ((pinch.cx - v.x) * k) / v.k, y: cy - ((pinch.cy - v.y) * k) / v.k });
    },
    end: () => (pinch = null),
  });

  // what this page draws under a point, front to back, each element once
  const hitsAt = (x: number, y: number) => {
    const layer = host.querySelector(".page-layer");
    const ids = document.elementsFromPoint(x, y).map((el) => (layer?.contains(el) ? el.closest(".el[data-id]")?.getAttribute("data-id") : null));
    return [...new Set(ids.filter((id): id is string => !!id))];
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === "touch" && finger.down(e) > 1) return;
    const target = e.target as HTMLElement;
    const v = view();
    // a field being typed in commits before the canvas takes over
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (e.button === 1) {
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
    } else if (e.button === 0) {
      const handle = target.closest("[data-handle]")?.getAttribute("data-handle") as Handle | null;
      const hits = hitsAt(e.clientX, e.clientY);
      const stack = stackAt(p.page, hits);
      const hit = pickFrom(p.page, stack, p.selected);
      // the one element selected, which a press there moves, picking the next when it lets go
      const held = p.selected.length === 1 && stack.includes(p.selected[0]) ? p.selected[0] : undefined;
      // several selected move together, led by the one pressed
      const leader = p.selected.length > 1 ? stack.find((id) => p.selected.includes(id)) : undefined;
      // a group moves by what it holds, led by the box around them
      const start = (kind: "move" | Handle, lead: string, group: Element[], enter?: string) => {
        const all = group.flatMap((g) => (g.tag === "group" ? [g, ...leaves(g)] : [g]));
        const bases = Object.fromEntries(all.map((g) => [g.id, boxOf(g, roomOf(p.page, g.id))]));
        drag = { kind, lead, ids: all.map((g) => g.id), sx: e.clientX, sy: e.clientY, bases, boxes: { ...bases }, n: ++drags, enter, turn: turnsOf(lead) };
      };
      // several, or a group's parts, scale by the box around them, each keeping its share of it
      const scaleBy = (h: Handle, group: Element[]) => {
        if (!scalable(group, h)) return;
        start(h, group[0].id, group);
        const d = drag;
        if (!d || !("ids" in d)) return;
        const offsets = Object.fromEntries(
          d.ids.map((id) => {
            const a = absolute(p.page, id);
            return [id, { x: (a?.x ?? 0) - d.bases[id].x, y: (a?.y ?? 0) - d.bases[id].y }];
          }),
        );
        d.around = { base: union(group.flatMap((g) => absolute(p.page, g.id) ?? [])), offsets };
      };
      // a shape's own attributes move and scale it, in its diagram's units
      const startShape = (how: "move" | Handle, id: string) => {
        const el = host.querySelector(`.page-layer [data-id="${id}"]`);
        const base = find(p.page.children, id);
        const screen = el instanceof SVGGraphicsElement ? (el.parentNode as SVGGraphicsElement).getScreenCTM() : null;
        if (!(el instanceof SVGGraphicsElement) || !base || !screen || !reshape(base, moving(0, 0))) return;
        const props = { ...base.props };
        drag = { kind: "shape", how, id, sx: e.clientX, sy: e.clientY, base: { ...base, props }, screen, outline: el.getBBox(), props: null };
      };
      if (preview() && hit && !(e.shiftKey || e.ctrlKey || e.metaKey)) {
        // the phone lays out each block, so a press picks and a drag pans
        p.onPick(hit);
        drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      } else if (handle && p.selected.length === 1 && shape(p.selected[0])) {
        startShape(handle, p.selected[0]);
      } else if (handle && p.selected.length === 1) {
        const one = find(p.page.children, p.selected[0]);
        if (one?.tag === "group") scaleBy(handle, [one]);
        else if (one && resizable(one, handle)) start(handle, one.id, [one]);
      } else if (handle) {
        scaleBy(handle, tops(p.page, p.selected));
      } else if (hits.length > 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        // adds the outermost in front the selection has not entered, or takes away the front one
        const front = stackAt(p.page, hits.slice(0, 1));
        return p.onPick(front.find((id) => !entered(p.page, id, p.selected)) ?? hits[0], true);
      } else if (leader) {
        const group = tops(p.page, p.selected).filter((g) => movable(g, ["x", "y"]));
        if (group.some((g) => g.id === leader)) start("move", leader, group);
      } else if (hit) {
        // what the press moves: the one selected there, else what it picks
        const one = held ?? hit;
        const enter = held && hit;
        if (!held) p.onPick(hit);
        const flow = flowAround(one);
        if (shape(one)) {
          startShape("move", one);
          if (drag?.kind === "shape") drag.enter = enter;
        } else if (movable(find(p.page.children, one)!, ["x", "y"])) start("move", one, [find(p.page.children, one)!], enter);
        else if (flow) drag = { kind: "reorder", id: one, parent: parentOf(p.page, one)!, flow, sx: e.clientX, sy: e.clientY, slot: null, enter };
        else if (enter) p.onPick(enter);
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
    if (drag.kind === "reorder") {
      if (Math.hypot(dx, dy) < 4) return;
      const r = host.getBoundingClientRect();
      const v = view();
      const at = { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
      const { slot, line } = slotAt(drag, at);
      drag.slot = slot;
      setSlotLine(line);
      return;
    }
    if (drag.kind === "shape") {
      // the pointer's travel in the diagram's units, whole ones unless Alt
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
    if (d.around && d.kind !== "move" && one) {
      // unturned, the box's origin cancels out, so the lead's serves for the box around them all
      const [was, now] = [d.around.base, resized(one, d.kind, d.around.base, rx, ry, 0, e.altKey)];
      const [across, down] = [/[ew]/.test(d.kind), /[ns]/.test(d.kind)];
      const least = e.altKey ? 1 / UNIT : GRID;
      for (const id of d.ids) {
        const [b, o] = [d.bases[id], d.around.offsets[id]];
        const [x0, x1] = across ? [b.x, b.x + b.w].map((v) => rescaled(v + o.x, was.x, was.w, now.x, now.w, e.altKey) - o.x) : [b.x, b.x + b.w];
        const [y0, y1] = down ? [b.y, b.y + b.h].map((v) => rescaled(v + o.y, was.y, was.h, now.y, now.h, e.altKey) - o.y) : [b.y, b.y + b.h];
        d.boxes[id] = { x: x0, y: y0, w: Math.max(least, x1 - x0), h: Math.max(least, y1 - y0) };
      }
      // a group's box is the one around what it holds
      for (const g of d.ids.map((id) => find(p.page.children, id))) if (g?.tag === "group") d.boxes[g.id] = union(leaves(g).map((l) => d.boxes[l.id]));
    } else {
      const moved =
        d.kind === "move" || !one ? { ...lead, x: snap(lead.x + rx, e.altKey), y: snap(lead.y + ry, e.altKey) } : resized(one, d.kind, lead, rx, ry, d.turn.own, e.altKey);
      // the others keep their places against the one under the pointer
      for (const id of d.ids) {
        const b = d.bases[id];
        d.boxes[id] = id === d.lead ? moved : { ...b, x: b.x + moved.x - lead.x, y: b.y + moved.y - lead.y };
      }
    }
    setHeld({ ...held(), ...Object.fromEntries(d.ids.map((id) => [id, { box: d.boxes[id], n: d.n }])) });
  };

  // a menu opening mid gesture, as a long press opens one, puts it back where it began
  const cancel = () => {
    const d = drag;
    drag = null;
    if (!d || d.kind === "pan") return;
    if (d.kind === "box") setBox(null);
    else if (d.kind === "reorder") setSlotLine(null);
    else if (d.kind === "shape") d.props && showProps(p.page.id, d.id, Object.fromEntries(Object.keys(d.props).map((k) => [k, d.base.props[k] ?? null])));
    else d.ids.forEach((id) => release(id, d.n));
  };

  const up = () => {
    const d = drag;
    drag = null;
    if (d?.kind === "box") return takeBox();
    if (d?.kind === "reorder") {
      setSlotLine(null);
      const at = childrenOf(p.page, d.parent).findIndex((c) => c.id === d.id);
      if (d.slot !== null && d.slot !== at) return moveTo(p.page, d.id, d.parent, d.slot);
      return d.enter && p.onPick(d.enter);
    }
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
      // a part its frame lays out keeps only its new size, a number now whatever it was
      for (const k of (e && flowed(e, room) ? ["w", "h"] : ["x", "y", "w", "h"]) as (keyof Box)[]) {
        // a new size moves the origin, so x and y follow w and h, and one that stays keeps its text
        const text = e && boxText(e, k, d.boxes[id], room);
        if (e && text !== boxText(e, k, d.bases[id], room)) props[k] = text!;
      }
      if (Object.keys(props).length > 0) edits.push({ kind: "set_props", page: p.page.id, id, props });
      else release(id, d.n);
    }
    sendEdits(edits);
    if (edits.length === 0 && d.enter) p.onPick(d.enter);
    // a refused write must not hold its boxes forever
    window.setTimeout(() => d.ids.forEach((id) => release(id, d.n)), 3000);
  };

  // the way a part's frame lays it out, when it does
  const flowAround = (id: string): Flow | undefined => {
    const [e, parent] = [find(p.page.children, id), parentOf(p.page, id)];
    const frame = parent ? find(p.page.children, parent) : undefined;
    if (!e || !frame || !flowed(e, roomOf(p.page, id))) return undefined;
    const r = resolve(frame.props.layout, scopeOf(p.page, parent!));
    return r.ok ? flowOf(r.value) : undefined;
  };

  // where among what its frame lays out a dragged part goes, counted without it, and the line
  // that shows it: before the first part the pointer is ahead of along the flow, on its line
  const slotAt = (d: { id: string; parent: string; flow: Flow }, at: { x: number; y: number }): { slot: number; line: Box | null } => {
    const others = childrenOf(p.page, d.parent).filter((c) => c.id !== d.id);
    const across = d.flow === "right" || d.flow === "left";
    const back = d.flow === "left" || d.flow === "up";
    const [along, side] = across ? [at.x, at.y] : [at.y, at.x];
    let last: Box | null = null;
    for (const [i, c] of others.entries()) {
      const b = flowed(c, roomOf(p.page, c.id)) ? absolute(p.page, c.id) : undefined;
      if (!b) continue;
      last = b;
      const [start, size, from, length] = across ? [b.x, b.w, b.y, b.h] : [b.y, b.h, b.x, b.w];
      const ahead = back ? along > start + size / 2 : along < start + size / 2;
      if (side < from || (side <= from + length && ahead)) return { slot: i, line: edge(b, across, back) };
    }
    return { slot: others.length, line: last && edge(last, across, !back) };
  };
  // a part's leading side along the flow, or its trailing one with `back`, as a thin line
  const edge = (b: Box, across: boolean, back: boolean): Box => {
    const t = 2 / view().k;
    return across ? { x: (back ? b.x + b.w : b.x) - t / 2, y: b.y, w: t, h: b.h } : { x: b.x, y: (back ? b.y + b.h : b.y) - t / 2, w: b.w, h: t };
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
      const at = boxOf(e, { w: p.page.width, h: p.page.height }, overrides);
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
    return { left: `${v.x}px`, top: `${v.y}px`, width: `${size().width * v.k}px`, height: `${size().height * v.k}px` };
  };

  // a shape's attributes place it, and the page lays some elements out itself, so their rings
  // are measured from the drawn page, each frame while one is picked, as live values may move it
  const shape = (id: string) => SHAPES.has(find(p.page.children, id)?.tag ?? "");
  const part = (id: string) => homeOf(find(p.page.children, id)?.tag ?? "") === "scene";
  /** Whether an element's box is measured as drawn, turn and all: a shape's, and all on a phone page. */
  const asDrawn = (id: string) => shape(id) || !!preview();
  const measuredOne = (id: string) => asDrawn(id) || laidOut(p.page, id);
  // what a drag may move: numbers it can write, and a place no frame's flow sets
  const movable = (e: Element, keys: (keyof Box)[]) => literal(e, keys) && !flowed(e, roomOf(p.page, e.id));
  // what a grip may size: a size the page works out, as a hug's or a fill's, becomes a number,
  // and the place it moves, for a grip on the left or the top, is one it can write
  const resizable = (e: Element, h: Handle) => {
    const keys = keysFor(h);
    const sizes = keys.filter((k) => k === "w" || k === "h");
    const places = flowed(e, roomOf(p.page, e.id)) ? [] : keys.filter((k) => k === "x" || k === "y");
    return literal(e, places) && sizes.every((k) => literal(e, [k]) || !!sizeWord(e.props[k]));
  };
  // what grips may scale together: along each side the grip moves, every part's place and
  // size, so no frame's flow places one and no shape is among them
  const scalable = (group: Element[], h: Handle) => {
    const keys = [...(/[ew]/.test(h) ? (["x", "w"] as const) : []), ...(/[ns]/.test(h) ? (["y", "h"] as const) : [])];
    return group
      .flatMap(leaves)
      .every((l) => homeOf(l.tag) === "page" && !flowed(l, roomOf(p.page, l.id)) && keys.every((k) => literal(l, [k]) || ((k === "w" || k === "h") && !!sizeWord(l.props[k]))));
  };
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
  const one = createMemo(() => (p.selected.length === 1 ? p.selected[0] : null));
  createEffect(() => {
    const id = one();
    // measured at once too, so its ring and grips never show a frame unturned
    setTurn(id ? untrack(() => turnOf(id)) : null);
    if (!id) return;
    let frame = requestAnimationFrame(function measure() {
      setTurn(turnOf(id));
      frame = requestAnimationFrame(measure);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  // the one picked element stays in sight: picked out of it, as from the layers, or covered as
  // the artboard shrinks, as under a phone's sheet. One a press picks stays put under it.
  const keep = () => {
    const id = one();
    const el = id && !drag && host.querySelector(`.page-layer [data-id="${id}"]`);
    if (!el) return;
    const [r, b] = [host.getBoundingClientRect(), el.getBoundingClientRect()];
    // along one side: wholly in with a margin, or one too big to fit at least partly in
    const into = (a0: number, a1: number, size: number) => {
      const m = Math.min(16, size / 4);
      if (a1 - a0 > size - 2 * m) return a0 > size - m || a1 < m ? m - a0 : 0;
      return a0 < m ? m - a0 : a1 > size - m ? size - m - a1 : 0;
    };
    const [dx, dy] = [into(b.left - r.left, b.right - r.left, r.width), into(b.top - r.top, b.bottom - r.top, r.height)];
    const v = view();
    if (dx !== 0 || dy !== 0) setView({ ...v, x: v.x + dx, y: v.y + dy });
  };
  createEffect(on(one, () => queueMicrotask(keep), { defer: true }));
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
    // a frame's point in its own units, a shape's in its diagram's
    const [ox, oy] = style.transformOrigin.split(" ").map((t) => parseFloat(t) / (el instanceof SVGGraphicsElement ? 1 : UNIT));
    const r = host.getBoundingClientRect();
    if (el instanceof SVGGraphicsElement) {
      // a shape turns about a point of its own outline's box, in the diagram's units
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
  const grips = (id: string) => {
    const m = shape(id) ? measured()[id] : undefined;
    const e = find(p.page.children, id);
    const b = !shape(id) && fingered ? absolute(p.page, id, overrides) : undefined;
    const [w, h] = m ? [m.width, m.height] : b ? [b.w * view().k, b.h * view().k] : [Infinity, Infinity];
    const fits = (g: Handle) => shape(id) || (!!e && (e.tag === "group" ? scalable([e], g) : resizable(e, g)));
    return HANDLES.filter((g) => !(m && m.height < 2 && /^[ns]$/.test(g)) && !(m && m.width < 2 && /^[ew]$/.test(g)) && !short(g, w, h) && fits(g));
  };
  /** Under a finger, whether a grip's side is too short on screen to hold it beside the others. */
  const short = (g: Handle, w: number, h: number) => fingered && ((w < SIDE && /^[ns]$/.test(g)) || (h < SIDE && /^[ew]$/.test(g)));
  // the point shows once the element says how it turns
  const turns = (id: string) => {
    const e = find(p.page.children, id);
    return !!e && (e.props.rotate !== undefined || e.props.origin !== undefined);
  };

  /** A box on the page as a ring on screen, on whole pixels so its thin line stays crisp. */
  const onScreen = (b: Box) => {
    const v = view();
    const [left, top] = [Math.round(v.x + b.x * v.k), Math.round(v.y + b.y * v.k)];
    const [right, bottom] = [Math.round(v.x + (b.x + b.w) * v.k), Math.round(v.y + (b.y + b.h) * v.k)];
    return { left, top, width: right - left, height: bottom - top };
  };
  // several selected: the box around them, whose grips scale them together
  const several = createMemo(() => (p.selected.length > 1 ? tops(p.page, p.selected) : []));
  const around = () => {
    const all = several();
    if (all.length === 0 || all.some((e) => homeOf(e.tag) !== "page")) return undefined;
    if (all.some((e) => laidOut(p.page, e.id))) measured();
    const b = onScreen(union(all.flatMap((e) => boxAt(e.id) ?? [])));
    const handles = preview() ? [] : HANDLES.filter((g) => !short(g, b.width, b.height) && scalable(all, g));
    return { style: { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }, handles };
  };

  /** An element's box on the page. */
  const boxAt = (id: string): Box | undefined => {
    if (!asDrawn(id)) return absolute(p.page, id, overrides);
    const m = measured()[id];
    if (!m) return undefined;
    const [r, v] = [host.getBoundingClientRect(), view()];
    return { x: (m.left - r.left - v.x) / v.k, y: (m.top - r.top - v.y) / v.k, w: m.width / v.k, h: m.height / v.k };
  };

  /** Where an element's ring goes on screen. A 3D part has no box of its own, so it rings its scene. */
  const ring = (id: string): JSX.CSSProperties | undefined => {
    if (part(id)) {
      const scene = parentOf(p.page, id);
      return scene ? ring(scene) : undefined;
    }
    // laid out by the page, it is read again each frame
    if (laidOut(p.page, id)) measured();
    const b = boxAt(id);
    if (!b) return undefined;
    const [v, s] = [view(), onScreen(b)];
    // a frame's ring turns with it, unless measured as drawn
    const t = turn();
    const turned = t?.id === id && t.angle !== 0 && !asDrawn(id) ? { transform: `rotate(${t.angle}deg)`, "transform-origin": `${t.ox * v.k}px ${t.oy * v.k}px` } : {};
    return { left: `${s.left}px`, top: `${s.top}px`, width: `${s.width}px`, height: `${s.height}px`, ...turned };
  };

  return (
    <div
      class="artboard"
      ref={host}
      onPointerDown={down}
      onContextMenu={(e) => {
        cancel();
        const stack = stackAt(p.page, hitsAt(e.clientX, e.clientY));
        // on what is selected, or inside it, the menu acts on the selection
        const around = stack.find((id) => p.selected.includes(id));
        const hit = around ?? pickFrom(p.page, stack, p.selected);
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
        <PageView page={preview() ?? p.page} overrides={overrides} grows={!!preview()} design />
      </div>
      <div class="veil" style={sheet()} />
      <Show when={box()}>{(b) => <div class="marquee" style={{ left: `${b().left}px`, top: `${b().top}px`, width: `${b().width}px`, height: `${b().height}px` }} />}</Show>
      <Show when={slotLine()}>
        {(b) => <div class="slot" style={{ left: `${view().x + b().x * view().k}px`, top: `${view().y + b().y * view().k}px`, width: `${b().w * view().k}px`, height: `${b().h * view().k}px` }} />}
      </Show>
      <For each={parents()}>{(id) => <Show when={ring(id)}>{(r) => <div class="holder" style={r()} />}</Show>}</For>
      {/* a ring for each selected element, its grips only when it is the one */}
      <For each={p.selected}>
        {(id) => (
          <Show when={ring(id)}>
            {(r) => (
              <div class="ring" style={r()}>
                <Show when={!preview() && p.selected.length === 1 && !part(id) && (!shape(id) || scales(id))}>
                  <For each={grips(id)}>{(h) => <span class={`handle ${h}`} data-handle={h} style={{ cursor: cursorOf(h, turn()?.id === id ? turn()!.angle + turn()!.room : 0) }} />}</For>
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
      <Show when={around()}>
        {(a) => (
          <div class="ring around" style={a().style}>
            <For each={a().handles}>{(h) => <span class={`handle ${h}`} data-handle={h} style={{ cursor: cursorOf(h, 0) }} />}</For>
          </div>
        )}
      </Show>
      <Show when={turn() && turns(turn()!.id) && turn()}>{(t) => <div class="origin" style={{ left: `${t().at.x}px`, top: `${t().at.y}px` }} />}</Show>
      <div class="zoom">
        <button class="icon-btn mono" title="Show at 100%" onClick={actual} onPointerDown={(e) => e.stopPropagation()}>
          {Math.round((view().k / UNIT) * 100)}%
        </button>
        <button class="icon-btn" title="Fit the page" onClick={fit} onPointerDown={(e) => e.stopPropagation()}>
          Fit
        </button>
        <button
          class="icon-btn"
          classList={{ on: !!preview() }}
          disabled={!!asDesigned(p.page)}
          title={asDesigned(p.page) ?? (preview() ? "Back to the page as designed" : "Show as an upright phone lays it out")}
          onClick={() => setPhoneOn(!preview())}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Smartphone size={14} />
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
