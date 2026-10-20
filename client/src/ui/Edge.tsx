// The edge between a sidebar and the detail pane: a grip that drags the sidebar's width,
// which every screen shares and this browser remembers.

import { createSignal } from "solid-js";
import { rememberedNumber } from "../state/remember";

const [left, setLeft] = rememberedNumber("sidebar-left", 300);
const [right, setRight] = rememberedNumber("sidebar-right", 360);

/** A sidebar keeps at least this width, and leaves the detail pane at least DETAIL. */
const MIN = 160;
const DETAIL = 320;

/** The sidebars' widths as CSS variables, for the frame every screen sits in. */
export const sidebarWidths = () => ({ "--sidebar-left": `${left()}px`, "--sidebar-right": `${right()}px` });

export function Edge(p: { side: "left" | "right" }) {
  const [dragging, setDragging] = createSignal(false);
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
    const up = () => {
      setDragging(false);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.setPointerCapture(e.pointerId);
    setDragging(true);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  return (
    <div class="edge" data-side={p.side}>
      <div class="grip" classList={{ dragging: dragging() }} title="Drag to resize" onPointerDown={down} />
    </div>
  );
}
