// The page on its artboard: the wheel zooms, a drag on empty space pans, elements move and
// resize on the grid (Alt slips it), and a drag writes when it ends.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Box, PageView, pageGround } from "../../page/PageView";
import type { Edit } from "../../protocol/Edit";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import { number } from "../../state/bind";
import type { Pick } from "./DesignScreen";
import { absolute, boxOf, find, literal, sendEdits, tops } from "./tree";

export const GRID = 11;
/** Grid lines every so many units and how strong each set is. A set fades out as its lines
 *  close up on screen, so zoomed out the grid thins instead of turning grey. */
const LEVELS = [
  [GRID, 0.045],
  [GRID * 4, 0.06],
  [GRID * 16, 0.06],
] as const;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

/** A pan, or a move or resize of `ids` led by the one under the pointer. */
type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move" | Handle; lead: string; ids: string[]; sx: number; sy: number; bases: Record<string, Box>; boxes: Record<string, Box>; n: number };

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
  return free ? Math.round(v) : Math.round(v / GRID) * GRID;
}

function dragged(kind: "move" | Handle, b: Box, dx: number, dy: number, free: boolean): Box {
  if (kind === "move") return { x: snap(b.x + dx, free), y: snap(b.y + dy, free), w: b.w, h: b.h };
  let [x, y, right, bottom] = [b.x, b.y, b.x + b.w, b.y + b.h];
  if (kind.includes("w")) x = Math.min(snap(x + dx, free), right - GRID);
  if (kind.includes("e")) right = Math.max(snap(right + dx, free), x + GRID);
  if (kind.includes("n")) y = Math.min(snap(y + dy, free), bottom - GRID);
  if (kind.includes("s")) bottom = Math.max(snap(bottom + dy, free), y + GRID);
  return { x, y, w: right - x, h: bottom - y };
}

/** Light lines on a dark page, dark ones on a light page. */
function ink(g: CanvasRenderingContext2D, ground: string): string {
  g.fillStyle = ground;
  const hex = /^#([0-9a-f]{6})$/i.exec(String(g.fillStyle))?.[1];
  if (!hex) return "255, 255, 255";
  const [r, gr, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * gr + 0.0722 * b > 128 ? "0, 0, 0" : "255, 255, 255";
}

export function Artboard(p: { page: Page; selected: string[]; onPick: Pick; onEdit: (id: string) => void }) {
  let host!: HTMLDivElement;
  let grid!: HTMLCanvasElement;
  const [view, setView] = createSignal({ k: 0.5, x: 0, y: 0 });
  const [held, setHeld] = createSignal<Held>({});
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
      const k = Math.min(8, Math.max(0.1, v.k * Math.exp(-dy * 0.002)));
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

  // a written drag keeps showing until the page carries its numbers, so nothing jumps back
  createEffect(() => {
    const h = held();
    for (const id of Object.keys(h)) {
      if (drag && drag.kind !== "pan" && drag.ids.includes(id)) continue;
      const e = find(p.page.children, id);
      if (!e || ["x", "y", "w", "h"].every((k) => number(e.props[k]) === h[id].box[k as keyof Box])) release(id);
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
      const hit = target.closest(".el[data-id]")?.getAttribute("data-id") ?? null;
      const start = (kind: "move" | Handle, lead: string, group: Element[]) => {
        const bases = Object.fromEntries(group.map((g) => [g.id, boxOf(g)]));
        drag = { kind, lead, ids: group.map((g) => g.id), sx: e.clientX, sy: e.clientY, bases, boxes: { ...bases }, n: ++drags };
      };
      if (handle && p.selected.length === 1) {
        const one = find(p.page.children, p.selected[0]);
        if (one && literal(one, keysFor(handle))) start(handle, one.id, [one]);
      } else if (hit && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        return p.onPick(hit, true);
      } else if (hit) {
        // a press on one of several selected moves them all, any other picks it alone
        const keep = p.selected.length > 1 && p.selected.includes(hit);
        if (!keep) p.onPick(hit);
        const group = (keep ? tops(p.page, p.selected) : [find(p.page.children, hit)!]).filter((g) => literal(g, ["x", "y"]));
        if (group.some((g) => g.id === hit)) start("move", hit, group);
      } else {
        p.onPick(null);
        drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      }
    }
    if (drag) host.setPointerCapture(e.pointerId);
  };

  const move = (e: PointerEvent) => {
    if (!drag) return;
    const [dx, dy] = [e.clientX - drag.sx, e.clientY - drag.sy];
    if (drag.kind === "pan") {
      setView({ ...view(), x: drag.vx + dx, y: drag.vy + dy });
      return;
    }
    const d = drag;
    const k = view().k;
    const lead = d.bases[d.lead];
    const moved = dragged(d.kind, lead, dx / k, dy / k, e.altKey);
    // the others keep their places against the one under the pointer
    for (const id of d.ids) {
      const b = d.bases[id];
      d.boxes[id] = id === d.lead ? moved : { ...b, x: b.x + moved.x - lead.x, y: b.y + moved.y - lead.y };
    }
    setHeld({ ...held(), ...Object.fromEntries(d.ids.map((id) => [id, { box: d.boxes[id], n: d.n }])) });
  };

  const up = () => {
    const d = drag;
    drag = null;
    if (!d || d.kind === "pan") return;
    const edits: Edit[] = [];
    for (const id of d.ids) {
      const props: Record<string, string> = {};
      for (const k of ["x", "y", "w", "h"] as (keyof Box)[]) {
        if (d.boxes[id][k] !== d.bases[id][k]) props[k] = String(d.boxes[id][k]);
      }
      if (Object.keys(props).length > 0) edits.push({ kind: "set_props", page: p.page.id, id, props });
      else release(id, d.n);
    }
    sendEdits(edits);
    // a refused write must not hold its boxes forever
    window.setTimeout(() => d.ids.forEach((id) => release(id, d.n)), 3000);
  };

  // the page at its true size, about the middle of the view
  const actual = () => {
    const r = host.getBoundingClientRect();
    const v = view();
    const [cx, cy] = [r.width / 2, r.height / 2];
    setView({ k: 1, x: cx - (cx - v.x) / v.k, y: cy - (cy - v.y) / v.k });
  };

  const sheet = () => {
    const v = view();
    return { left: `${v.x}px`, top: `${v.y}px`, width: `${p.page.width * v.k}px`, height: `${p.page.height * v.k}px` };
  };

  /** Where an element's ring goes on screen, on whole pixels so its thin line stays crisp. */
  const ring = (id: string) => {
    const b = absolute(p.page, id, overrides);
    if (!b) return undefined;
    const v = view();
    const [left, top] = [Math.round(v.x + b.x * v.k), Math.round(v.y + b.y * v.k)];
    const [right, bottom] = [Math.round(v.x + (b.x + b.w) * v.k), Math.round(v.y + (b.y + b.h) * v.k)];
    return { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` };
  };

  return (
    <div
      class="artboard"
      ref={host}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDblClick={(e) => {
        // the press captured the pointer, so the target is the artboard: look beneath it
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest(".el[data-id]")?.getAttribute("data-id");
        if (hit) p.onEdit(hit);
      }}
    >
      <canvas class="artboard-grid" ref={grid} />
      <div class="page-layer" style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().k})` }}>
        <PageView page={p.page} overrides={overrides} design />
      </div>
      <div class="veil" style={sheet()} />
      {/* a ring for each selected element, its grips only when it is the one */}
      <For each={p.selected}>
        {(id) => (
          <Show when={ring(id)}>
            {(r) => (
              <div class="ring" style={r()}>
                <Show when={p.selected.length === 1}>
                  <For each={HANDLES}>{(h) => <span class={`handle ${h}`} data-handle={h} />}</For>
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
      <div class="zoom">
        <button class="icon-btn mono" title="Show at 100%" onClick={actual} onPointerDown={(e) => e.stopPropagation()}>
          {Math.round(view().k * 100)}%
        </button>
        <button class="icon-btn" title="Fit the page" onClick={fit} onPointerDown={(e) => e.stopPropagation()}>
          Fit
        </button>
      </div>
    </div>
  );
}
