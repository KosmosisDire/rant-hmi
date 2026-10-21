// A panel along the bottom of a phone's screen, as the explorer's. It rests at stops: its grip
// alone unless it is modal, then all it holds while that is under half its room, else 70
// percent, then its room but a strip. A drag of the grip moves it and rests it at the stop it
// was thrown toward, a tap on the grip steps it up, and a modal one dragged down closes. Its
// room is the screen, or when docked what holds it, which it tells how tall it rests as --sheet
// so the rest can keep clear of it.

import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { follow } from "./press";
import { onResize } from "./size";

/** A drag further than this rests the sheet at the next stop its way, else at the nearest. */
const THROW = 24;
/** What the highest stop leaves showing above it, so the sheet still reads as one. */
const ABOVE = 48;

export function Sheet(p: {
  ref?: (el: HTMLDivElement) => void;
  class?: string;
  modal?: boolean;
  docked?: boolean;
  scrim?: boolean;
  onClose?: () => void;
  /** The stop to rest at, counted from the lowest, for an owner that moves it too. */
  stop?: number;
  onStop?: (stop: number) => void;
  children: JSX.Element;
}) {
  let box!: HTMLDivElement;
  let grip!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [stops, setStops] = createSignal<number[]>([0]);
  const [own, setOwn] = createSignal(0);
  const stop = () => Math.min(p.stop ?? own(), stops().length - 1);
  const setStop = (n: number) => (p.onStop ? p.onStop(n) : setOwn(n));
  const [dragged, setDragged] = createSignal<number | null>(null);
  const [shown, setShown] = createSignal(false);
  // a new room, as a phone's keyboard makes, moves it at once, so what has the focus is kept in sight
  const [resized, setResized] = createSignal(false);

  const measure = () => {
    const room = box.offsetParent ? box.offsetParent.clientHeight : innerHeight;
    const holds = grip.offsetHeight + content.offsetHeight;
    const list = p.modal ? [] : [grip.offsetHeight];
    const middle = holds <= room * 0.5 ? holds : Math.min(holds, room * 0.7);
    if (list.length === 0 || middle > list.at(-1)! + 1) list.push(middle);
    const full = Math.min(holds, room - ABOVE);
    if (full > list.at(-1)! + 1) list.push(full);
    setStops(list);
  };
  const rest = () => (shown() ? stops()[stop()] : 0);
  const height = () => dragged() ?? rest();
  createEffect(() => p.docked && box.parentElement?.style.setProperty("--sheet", `${Math.ceil(rest())}px`));

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
        if (Math.abs(moved) < 4) return setStop((stop() + 1) % list.length);
        if (p.modal && moved < -THROW && at < list[0]) return p.onClose?.();
        let next = list.reduce((best, h, i) => (Math.abs(h - at) < Math.abs(list[best] - at) ? i : best), 0);
        if (moved > THROW) next = list.findIndex((h) => h >= at - 1);
        else if (moved < -THROW) next = list.reduce((last, h, i) => (h <= at + 1 ? i : last), -1);
        setStop(Math.max(0, next === -1 ? list.length - 1 : next));
      },
    });
  };

  const resize = () => {
    setResized(true);
    measure();
    requestAnimationFrame(() => setResized(false));
  };

  onMount(() => {
    measure();
    onResize(content, measure);
    window.addEventListener("resize", resize);
    // drawn shut first, so it slides up to its stop
    const frame = requestAnimationFrame(() => setShown(true));
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    });
  });

  return (
    <>
      <Show when={p.scrim}>
        <div class="sheet-scrim" />
      </Show>
      <div
        ref={(el) => {
          box = el;
          p.ref?.(el);
        }}
        class={`sheet ${p.class ?? ""}`}
        classList={{ dock: p.docked, snap: dragged() !== null || resized() }}
        style={{ height: `${Math.ceil(height())}px` }}
      >
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
