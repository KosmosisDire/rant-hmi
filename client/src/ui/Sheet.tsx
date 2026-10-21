// A panel along the bottom of a phone's screen, as the explorer's. It rests at stops: its grip
// alone unless it is modal, then all it holds while that is under half the screen, else 70
// percent, then the screen below the top bar. A drag of the grip moves it and rests it at the
// stop it was thrown toward, a tap on the grip steps it up, and a modal one dragged down closes.

import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { follow } from "./press";

/** A drag further than this rests the sheet at the next stop its way, else at the nearest. */
const THROW = 24;
/** What the highest stop leaves showing above it, so the sheet still reads as one. */
const ABOVE = 48;

export function Sheet(p: { ref?: (el: HTMLDivElement) => void; class?: string; modal?: boolean; scrim?: boolean; onClose?: () => void; children: JSX.Element }) {
  let grip!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [stops, setStops] = createSignal<number[]>([0]);
  const [stop, setStop] = createSignal(0);
  const [dragged, setDragged] = createSignal<number | null>(null);
  const [shown, setShown] = createSignal(false);

  const measure = () => {
    const room = innerHeight;
    const holds = grip.offsetHeight + content.offsetHeight;
    const list = p.modal ? [] : [grip.offsetHeight];
    const middle = holds <= room * 0.5 ? holds : Math.min(holds, room * 0.7);
    if (list.length === 0 || middle > list.at(-1)! + 1) list.push(middle);
    const full = Math.min(holds, room - ABOVE);
    if (full > list.at(-1)! + 1) list.push(full);
    setStops(list);
    setStop((s) => Math.min(s, list.length - 1));
  };
  const height = () => (shown() ? (dragged() ?? stops()[stop()]) : 0);

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [y0, h0] = [e.clientY, height()];
    const low = p.modal ? 0 : stops()[0];
    follow(e, {
      move: (m) => setDragged(Math.max(low, Math.min(h0 + y0 - m.clientY, stops().at(-1)!))),
      end: (u) => {
        const moved = u ? y0 - u.clientY : 0;
        const at = dragged() ?? h0;
        setDragged(null);
        const list = stops();
        if (Math.abs(moved) < 4) return setStop((s) => (s + 1) % list.length);
        if (p.modal && moved < -THROW && at < list[0]) return p.onClose?.();
        let next = list.reduce((best, h, i) => (Math.abs(h - at) < Math.abs(list[best] - at) ? i : best), 0);
        if (moved > THROW) next = list.findIndex((h) => h >= at - 1);
        else if (moved < -THROW) next = list.reduce((last, h, i) => (h <= at + 1 ? i : last), -1);
        setStop(Math.max(0, next === -1 ? list.length - 1 : next));
      },
    });
  };

  onMount(() => {
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(content);
    window.addEventListener("resize", measure);
    // drawn shut first, so it slides up to its stop
    const frame = requestAnimationFrame(() => setShown(true));
    onCleanup(() => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      window.removeEventListener("resize", measure);
    });
  });

  return (
    <>
      <Show when={p.scrim}>
        <div class="sheet-scrim" />
      </Show>
      <div ref={p.ref} class={`sheet ${p.class ?? ""}`} classList={{ dragging: dragged() !== null }} style={{ height: `${Math.ceil(height())}px` }}>
        <div ref={grip} class="sheet-grip" onPointerDown={down} />
        <div class="sheet-body">
          <div ref={content} class="sheet-content">
            {p.children}
          </div>
        </div>
      </div>
    </>
  );
}
