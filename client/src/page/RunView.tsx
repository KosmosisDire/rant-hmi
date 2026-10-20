// The open pages of a screen as an operator sees them. The top full page fills the screen,
// scaled to fit, and pages over it float centred at its scale above a dimmed backdrop. Pages
// beneath stay as they were, so closing lands exactly where the screen was.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Page } from "../protocol/Page";
import { back, stack } from "../state/stack";
import { page } from "../state/store";
import { pageAct } from "./act";
import { PageView } from "./PageView";

export function RunView(p: { active: boolean }) {
  let host!: HTMLDivElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const pages = () => stack().flatMap((o) => page(o.id) ?? []);
  /** Where the pages in sight start: the top full page. */
  const base = () => {
    const all = pages();
    let n = all.length - 1;
    while (n > 0 && all[n].shows !== "full") n--;
    return Math.max(0, n);
  };
  const scale = () => {
    const b = pages()[base()];
    return b ? Math.min(size().w / b.width, size().h / b.height) : 1;
  };
  const place = (pg: Page) => {
    const k = Math.min(scale(), size().w / pg.width, size().h / pg.height);
    return `translate(${(size().w - pg.width * k) / 2}px, ${(size().h - pg.height * k) / 2}px) scale(${k})`;
  };

  onMount(() => {
    const watch = new ResizeObserver(() => setSize({ w: host.clientWidth, h: host.clientHeight }));
    watch.observe(host);
    const key = (e: KeyboardEvent) => p.active && e.key === "Escape" && back();
    window.addEventListener("keydown", key);
    onCleanup(() => {
      watch.disconnect();
      window.removeEventListener("keydown", key);
    });
  });

  return (
    <div class="run-view" ref={host}>
      <For each={pages()}>
        {(pg, n) => (
          <div class="run-layer" data-page={pg.id} hidden={n() < base()}>
            <Show when={n() > base()}>
              <div class="run-backdrop" onPointerDown={() => n() === pages().length - 1 && back()} />
            </Show>
            <div class="run-page" classList={{ over: n() > base() }} style={{ transform: place(pg) }}>
              <PageView page={pg} act={pageAct(pg.id)} />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
