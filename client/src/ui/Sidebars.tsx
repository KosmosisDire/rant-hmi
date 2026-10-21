// The sidebars every screen shares: their widths, whether each is open, the edge that drags a
// width and the top bar's button that opens or closes one. This browser remembers them all.

import { createEffect, createSignal } from "solid-js";
import { remembered, rememberedNumber } from "../state/remember";
import { PanelLeft, PanelRight } from "./icons";
import { follow } from "./press";

const [left, setLeft] = rememberedNumber("sidebar-left", 300);
const [right, setRight] = rememberedNumber("sidebar-right", 360);
const SHOWN = ["open", "closed"] as const;
const shown = { left: remembered("sidebar-left-shown", "open", SHOWN), right: remembered("sidebar-right-shown", "open", SHOWN) };

/** A sidebar keeps at least this width, and leaves the detail pane at least DETAIL. */
const MIN = 160;
const DETAIL = 320;

/** The sidebars' widths as CSS variables, for the frame every screen sits in. */
export const sidebarWidths = () => ({ "--sidebar-left": `${left()}px`, "--sidebar-right": `${right()}px` });

/** Which sidebars are closed, as classes of that frame. */
export const sidebarsClosed = () => ({ "left-closed": shown.left[0]() === "closed", "right-closed": shown.right[0]() === "closed" });

/** The top bar's button that opens or closes a sidebar, lit while it is open. */
export function SidebarToggle(p: { side: "left" | "right" }) {
  const [state, set] = shown[p.side];
  const open = () => state() === "open";
  return (
    <button class="bar-btn" classList={{ on: open() }} title={`${open() ? "Close" : "Open"} the ${p.side} sidebar`} onClick={() => set(open() ? "closed" : "open")}>
      {p.side === "left" ? <PanelLeft size={16} /> : <PanelRight size={16} />}
    </button>
  );
}

export function Edge(p: { side: "left" | "right" }) {
  const [dragging, setDragging] = createSignal(false);
  // a sidebar slides open and closed, but follows a drag at once
  createEffect(() => document.documentElement.classList.toggle("resizing", dragging()));
  const down = (e: PointerEvent) => {
    const grip = e.currentTarget as HTMLElement;
    const edge = grip.parentElement!;
    const bar = (p.side === "left" ? edge.previousElementSibling : edge.nextElementSibling) as HTMLElement | null;
    const row = edge.parentElement;
    if (e.button !== 0 || !bar || !row) return;
    e.preventDefault();
    // all in the row but this sidebar and the detail pane keeps its width
    const taken = [...row.children].filter((c) => c !== bar && !c.classList.contains("detail")).reduce((sum, c) => sum + c.getBoundingClientRect().width, 0);
    const max = Math.max(MIN, row.clientWidth - taken - DETAIL);
    const [x0, w0] = [e.clientX, bar.getBoundingClientRect().width];
    const set = p.side === "left" ? setLeft : setRight;
    const move = (m: PointerEvent) => set(Math.round(Math.min(max, Math.max(MIN, w0 + (p.side === "left" ? m.clientX - x0 : x0 - m.clientX)))));
    grip.setPointerCapture(e.pointerId);
    setDragging(true);
    follow(e, { move, end: () => setDragging(false) });
  };
  return (
    <div class="edge" data-side={p.side}>
      <div class="grip" classList={{ dragging: dragging() }} title="Drag to resize" onPointerDown={down} />
    </div>
  );
}
