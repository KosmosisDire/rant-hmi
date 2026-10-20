// A panel floating under the control that opened it. A press outside closes it and any opened
// from it, Escape closes the top one.

import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

interface Open {
  el: HTMLElement;
  anchor: HTMLElement;
  close: () => void;
}

/** Open popovers, the latest last. */
const open: Open[] = [];

function pressed(e: PointerEvent) {
  const target = e.target as Node;
  // a press on what opened one leaves it to that control, which toggles it
  let at = open.length - 1;
  while (at >= 0 && !open[at].el.contains(target) && !open[at].anchor.contains(target)) at--;
  for (const p of open.slice(at + 1).reverse()) p.close();
}

function key(e: KeyboardEvent) {
  if (e.key !== "Escape" || open.length === 0) return;
  // a field's own completion list closes first
  if ((e.target as HTMLElement).closest?.(".draft")?.querySelector(".suggest")) return;
  e.preventDefault();
  e.stopPropagation();
  open.at(-1)!.close();
}

export function Popover(p: { anchor: HTMLElement; onClose: () => void; class?: string; children: JSX.Element }) {
  let el!: HTMLDivElement;
  const [at, setAt] = createSignal({ left: -9999, top: -9999 });
  const place = () => {
    const a = p.anchor.getBoundingClientRect();
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    const left = Math.max(8, Math.min(a.left, innerWidth - w - 8));
    const below = a.bottom + 4;
    setAt({ left, top: below + h > innerHeight - 8 ? Math.max(8, a.top - h - 4) : below });
  };
  onMount(() => {
    const entry = { el, anchor: p.anchor, close: p.onClose };
    open.push(entry);
    if (open.length === 1) {
      window.addEventListener("pointerdown", pressed, true);
      window.addEventListener("keydown", key, true);
    }
    place();
    const follow = new ResizeObserver(place);
    follow.observe(el);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
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
      <div ref={el} class={`popover ${p.class ?? ""}`} style={{ left: `${at().left}px`, top: `${at().top}px` }}>
        {p.children}
      </div>
    </Portal>
  );
}
