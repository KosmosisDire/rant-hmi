// A screen's open pages as an operator sees them: the top full page fits the screen, stacked
// on a narrow one, and pages over it float at its scale above a dimmed backdrop.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Page } from "../protocol/Page";
import { back, prune, stack } from "../state/stack";
import { page } from "../state/store";
import { Download } from "../ui/icons";
import { openMenu } from "../ui/Menu";
import { savePicture, showsPicture } from "../ui/Picture";
import { pageAct } from "./act";
import { UNIT } from "../state/bind";
import { PageView, stacked } from "./PageView";

export function RunView(p: { active: boolean }) {
  let host!: HTMLDivElement;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const pages = () => stack().flatMap((o) => page(o.id) ?? []);
  // a page removed while open closes
  createEffect(() => prune((id) => page(id) !== undefined));
  /** Where the pages in sight start: the top full page. */
  const base = () => {
    const all = pages();
    let n = all.length - 1;
    while (n > 0 && all[n].shows !== "full") n--;
    return Math.max(0, n);
  };
  const scale = () => {
    const b = pages()[base()];
    return b ? Math.min(size().w / (b.width * UNIT), size().h / (b.height * UNIT)) : 1;
  };
  const place = (pg: Page) => {
    const [w, h] = [pg.width * UNIT, pg.height * UNIT];
    const k = Math.min(scale(), size().w / w, size().h / h);
    return `translate(${(size().w - w * k) / 2}px, ${(size().h - h * k) / 2}px) scale(${k})`;
  };
  // a portrait screen reads a landscape page as its blocks one under another, at one zoom
  const layout = (pg: Page, n: number) => {
    if (n !== base() || size().w >= size().h || pg.width <= pg.height) return { transform: place(pg) };
    const stack = stacked(pg);
    const k = size().w / (stack.width * UNIT);
    // the page's ground reaches the screen's foot even when its blocks end above it
    const tall = { ...stack, height: Math.max(stack.height, Math.floor(size().h / k / UNIT)) };
    return { transform: `scale(${k})`, stack: tall, height: tall.height * UNIT * k };
  };

  // measured at once when the tab shows, so its first frame is never drawn at no size
  const measure = () => setSize({ w: host.clientWidth, h: host.clientHeight });
  createEffect(() => p.active && measure());
  onMount(() => {
    const watch = new ResizeObserver(measure);
    watch.observe(host);
    const key = (e: KeyboardEvent) => p.active && e.key === "Escape" && back();
    window.addEventListener("keydown", key);
    onCleanup(() => {
      watch.disconnect();
      window.removeEventListener("keydown", key);
    });
  });

  return (
    <div
      class="run-view"
      ref={host}
      onContextMenu={(e) => {
        // a long press never opens a menu, so it stays a press, and a mouse saves a picture
        if ((e as PointerEvent).pointerType === "touch") return e.stopPropagation();
        const el = (e.target as HTMLElement).closest<HTMLElement>(".el[data-id]");
        if (!el || !showsPicture(el)) return;
        openMenu(e, [{ label: "Save picture", icon: <Download size={13} />, run: () => savePicture(el, el.dataset.name ?? "picture") }]);
      }}
    >
      <For each={pages()}>
        {(pg, n) => {
          const shown = () => layout(pg, n());
          return (
            <div class="run-layer" classList={{ stacked: !!shown().stack }} data-page={pg.id} hidden={n() < base()}>
              <Show when={n() > base()}>
                <div class="run-backdrop" onPointerDown={() => n() === pages().length - 1 && back()} />
              </Show>
              <div class="run-page" classList={{ over: n() > base() }} style={{ transform: shown().transform }}>
                <PageView page={pg} act={pageAct(pg.id)} overrides={shown().stack?.at} size={shown().stack} />
              </div>
              {/* the stacked page's height, which it does not take once scaled */}
              <Show when={shown().height}>{(h) => <div style={{ height: `${h()}px` }} />}</Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
