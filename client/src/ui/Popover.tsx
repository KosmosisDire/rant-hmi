// A panel floating under the control that opened it, beside it for a submenu, or at a point
// for a right click, and on a phone a sheet along the bottom. A press outside closes it and any
// opened from it, Escape the top one.

import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { phone } from "./phone";
import { Sheet } from "./Sheet";

interface Open {
  el: HTMLElement;
  anchor: HTMLElement | null;
  close: () => void;
}

/** Open popovers, the latest last. */
const open: Open[] = [];

function pressed(e: PointerEvent) {
  const target = e.target as Node;
  // a field's completion list floats outside, but belongs to the field
  if ((target as HTMLElement).closest?.(".suggest")) return;
  // a press on what opened one leaves it to that control, which toggles it
  let at = open.length - 1;
  while (at >= 0 && !open[at].el.contains(target) && !open[at].anchor?.contains(target)) at--;
  for (const p of open.slice(at + 1).reverse()) p.close();
}

function key(e: KeyboardEvent) {
  if (e.key !== "Escape" || open.length === 0) return;
  // a field's own completion list closes first, and is open only while its field is focused
  if (document.querySelector(".suggest")) return;
  e.preventDefault();
  e.stopPropagation();
  open.at(-1)!.close();
}

export function Popover(p: { anchor: HTMLElement | { x: number; y: number }; onClose: () => void; class?: string; side?: boolean; children: JSX.Element }) {
  let el!: HTMLDivElement;
  const [at, setAt] = createSignal({ left: -9999, top: -9999 });
  // the first sheet open dims the screen, and one opened from it stacks over it
  const sheet = phone();
  const first = open.length === 0;
  const element = p.anchor instanceof HTMLElement ? p.anchor : null;
  const place = () => {
    const a = element?.getBoundingClientRect() ?? { left: (p.anchor as { x: number }).x, right: (p.anchor as { x: number }).x, top: (p.anchor as { y: number }).y, bottom: (p.anchor as { y: number }).y };
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    if (p.side) {
      // a submenu's first row lines up with the row that opened it
      const left = a.right + w + 4 > innerWidth ? a.left - w - 4 : a.right + 4;
      setAt({ left: Math.max(8, left), top: Math.max(8, Math.min(a.top - 7, innerHeight - h - 8)) });
      return;
    }
    const left = Math.max(8, Math.min(a.left, innerWidth - w - 8));
    const gap = element ? 4 : 0;
    const below = a.bottom + gap;
    setAt({ left, top: below + h > innerHeight - 8 ? Math.max(8, a.top - h - gap) : below });
  };
  onMount(() => {
    const entry = { el, anchor: element, close: p.onClose };
    open.push(entry);
    if (open.length === 1) {
      window.addEventListener("pointerdown", pressed, true);
      window.addEventListener("keydown", key, true);
    }
    const follow = new ResizeObserver(place);
    if (!sheet) {
      place();
      follow.observe(el);
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
    }
    onCleanup(() => {
      follow.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      open.splice(open.indexOf(entry), 1);
      if (open.length === 0) {
        window.removeEventListener("pointerdown", pressed, true);
        window.removeEventListener("keydown", key, true);
      }
    });
  });
  return (
    <Portal>
      {sheet ? (
        <Sheet ref={(e) => (el = e)} modal scrim={first} onClose={p.onClose}>
          <div class={`popover in-sheet ${p.class ?? ""}`}>{p.children}</div>
        </Sheet>
      ) : (
        <div ref={el} class={`popover ${p.class ?? ""}`} style={{ left: `${at().left}px`, top: `${at().top}px` }}>
          {p.children}
        </div>
      )}
    </Portal>
  );
}
