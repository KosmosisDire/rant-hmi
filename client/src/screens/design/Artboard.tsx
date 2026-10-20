// The page on its artboard: pan with a wheel or a drag on empty space, zoom with Ctrl and
// the wheel, select by clicking, move by dragging, resize by the grips. Everything snaps to
// the grid, and Alt lets it slip. A drag shows at once and writes when it ends.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Box, PageView } from "../../page/PageView";
import type { Page } from "../../protocol/Page";
import { number } from "../../state/bind";
import { absolute, boxOf, find, literal, setProps } from "./tree";

export const GRID = 11;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move" | Handle; id: string; sx: number; sy: number; base: Box; moved: boolean };

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

export function Artboard(p: { page: Page; selected: string | null; onSelect: (id: string | null) => void }) {
  let host!: HTMLDivElement;
  const [view, setView] = createSignal({ k: 0.5, x: 0, y: 0 });
  const [held, setHeld] = createSignal<Record<string, Box>>({});
  const overrides = (id: string) => held()[id];
  let drag: Drag | null = null;

  let fittedFor = "";
  const fit = () => {
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const k = Math.min((r.width - 64) / p.page.width, (r.height - 64) / p.page.height);
    setView({ k, x: (r.width - p.page.width * k) / 2, y: (r.height - p.page.height * k) / 2 });
    fittedFor = p.page.id;
  };
  onMount(() => {
    // fits once the artboard first has a size, and again for each page opened
    const watch = new ResizeObserver(() => fittedFor !== p.page.id && fit());
    watch.observe(host);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view();
      if (e.ctrlKey) {
        const r = host.getBoundingClientRect();
        const [px, py] = [e.clientX - r.left, e.clientY - r.top];
        const k = Math.min(8, Math.max(0.1, v.k * Math.exp(-e.deltaY * 0.002)));
        setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
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
    const done = Object.keys(h).filter((id) => {
      const e = find(p.page.children, id);
      return !e || ["x", "y", "w", "h"].every((k) => number(e.props[k]) === h[id][k as keyof Box]);
    });
    if (done.length) setHeld((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !done.includes(id))));
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
          drag = { kind, id, sx: e.clientX, sy: e.clientY, base: boxOf(e2), moved: false };
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
    const box = dragged(drag.kind, drag.base, dx / k, dy / k, e.altKey);
    drag.moved = true;
    setHeld({ ...held(), [drag.id]: box });
  };

  const up = () => {
    const d = drag;
    drag = null;
    if (!d || d.kind === "pan" || !d.moved) return;
    const box = held()[d.id];
    if (!box) return;
    const props: Record<string, string> = {};
    for (const k of ["x", "y", "w", "h"] as (keyof Box)[]) {
      if (box[k] !== d.base[k]) props[k] = String(box[k]);
    }
    if (Object.keys(props).length) setProps(p.page.id, d.id, props);
    // a refused write must not hold the box forever
    window.setTimeout(() => setHeld((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== d.id))), 3000);
  };

  const ring = createMemo(() => {
    const b = p.selected ? absolute(p.page, p.selected, overrides) : undefined;
    if (!b) return undefined;
    const v = view();
    return { left: v.x + b.x * v.k, top: v.y + b.y * v.k, width: b.w * v.k, height: b.h * v.k };
  });

  return (
    <div class="artboard" ref={host} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div class="page-layer" style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().k})` }}>
        <PageView page={p.page} overrides={overrides} design />
      </div>
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
