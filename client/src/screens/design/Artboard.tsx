// The page on its artboard: zoom with the wheel, pan with a drag on empty space or the middle
// button, select by clicking, move by dragging, resize by the grips. Everything snaps to the
// grid, and Alt lets it slip. A drag shows at once and writes when it ends.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Box, PageView } from "../../page/PageView";
import type { Page } from "../../protocol/Page";
import { number } from "../../state/bind";
import { absolute, boxOf, find, literal, setProps } from "./tree";

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

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move" | Handle; id: string; sx: number; sy: number; base: Box; box: Box; n: number };

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

export function Artboard(p: { page: Page; selected: string | null; onSelect: (id: string | null) => void }) {
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
    const sheet = host.querySelector<HTMLElement>(".page");
    const ground = (sheet && getComputedStyle(sheet).getPropertyValue("--page-ground").trim()) || "#000000";
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
      if (drag && drag.kind !== "pan" && drag.id === id) continue;
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
      const id = handle ? p.selected : hit;
      const e2 = id ? find(p.page.children, id) : undefined;
      if (id && e2) {
        p.onSelect(id);
        const kind = handle ?? "move";
        if (literal(e2, keysFor(kind))) {
          const base = boxOf(e2);
          drag = { kind, id, sx: e.clientX, sy: e.clientY, base, box: base, n: ++drags };
        }
      } else {
        p.onSelect(null);
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
    const k = view().k;
    drag.box = dragged(drag.kind, drag.base, dx / k, dy / k, e.altKey);
    setHeld({ ...held(), [drag.id]: { box: drag.box, n: drag.n } });
  };

  const up = () => {
    const d = drag;
    drag = null;
    if (!d || d.kind === "pan") return;
    const props: Record<string, string> = {};
    for (const k of ["x", "y", "w", "h"] as (keyof Box)[]) {
      if (d.box[k] !== d.base[k]) props[k] = String(d.box[k]);
    }
    if (Object.keys(props).length === 0) return release(d.id, d.n);
    setProps(p.page.id, d.id, props);
    // a refused write must not hold its box forever
    window.setTimeout(() => release(d.id, d.n), 3000);
  };

  const sheet = () => {
    const v = view();
    return { left: `${v.x}px`, top: `${v.y}px`, width: `${p.page.width * v.k}px`, height: `${p.page.height * v.k}px` };
  };

  const ring = createMemo(() => {
    const b = p.selected ? absolute(p.page, p.selected, overrides) : undefined;
    if (!b) return undefined;
    const v = view();
    return { left: v.x + b.x * v.k, top: v.y + b.y * v.k, width: b.w * v.k, height: b.h * v.k };
  });

  return (
    <div class="artboard" ref={host} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <canvas class="artboard-grid" ref={grid} />
      <div class="page-layer" style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().k})` }}>
        <PageView page={p.page} overrides={overrides} design />
      </div>
      <div class="veil" style={sheet()} />
      <Show when={ring()}>
        {(r) => (
          <div class="ring" style={{ left: `${r().left}px`, top: `${r().top}px`, width: `${r().width}px`, height: `${r().height}px` }}>
            <For each={HANDLES}>{(h) => <span class={`handle ${h}`} data-handle={h} />}</For>
          </div>
        )}
      </Show>
      <div class="zoom">
        <span class="mono">{Math.round(view().k * 100)}%</span>
        <button class="icon-btn" title="Fit the page" onClick={fit} onPointerDown={(e) => e.stopPropagation()}>
          Fit
        </button>
      </div>
    </div>
  );
}
