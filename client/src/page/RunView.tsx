// A screen's open pages as an operator sees them: the top full page fits the screen, laid out
// again on an upright one, and pages over it float at its scale above a dimmed backdrop.

import { createEffect, For, onCleanup, onMount, Show } from "solid-js";
import type { Page } from "../protocol/Page";
import { back, prune, stack, undo } from "../state/stack";
import { fullAt } from "../state/address";
import { page } from "../state/store";
import { Download } from "../ui/icons";
import { openMenu } from "../ui/Menu";
import { savePicture, showsPicture } from "../ui/Picture";
import { pageAct } from "./act";
import { UNIT } from "../state/bind";
import { createSize } from "../ui/size";
import { fitIn, PageView } from "./PageView";
import { createPhonePage, reflows } from "./phone";

export function RunView(p: { active: boolean }) {
  let host!: HTMLDivElement;
  const size = createSize();
  const pages = () => stack().flatMap((o) => page(o.id) ?? []);
  // a page removed while open closes
  createEffect(() => prune((id) => page(id) !== undefined));
  /** Where the pages in sight start: the top full page. */
  const base = () => fullAt(pages());
  const scale = () => {
    const b = pages()[base()];
    return b ? fitIn(b.width * UNIT, b.height * UNIT, size()).k : 1;
  };
  const place = (pg: Page) => fitIn(pg.width * UNIT, pg.height * UNIT, size(), scale()).transform;

  // measured at once when the tab shows, so its first frame is never drawn at no size
  createEffect(() => p.active && size.measure());
  onMount(() => {
    size.track(host);
    // an Escape a handler names is the handler's, and one it leaves undoes the last step
    const key = (e: KeyboardEvent) => p.active && e.key === "Escape" && !e.defaultPrevented && undo();
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
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
          // a screen held upright shows a landscape page laid out again for its width, unzoomed
          const phone = createPhonePage(() => (n() === base() && size().w < size().h && reflows(pg) ? pg : null), size);
          return (
            // a page under another is covered, so its elements hear no keys
            <div class="run-layer" classList={{ phone: !!phone() }} data-page={pg.id} hidden={n() < base()} inert={n() < pages().length - 1}>
              <Show when={n() > base()}>
                <div class="run-backdrop" onPointerDown={() => n() === pages().length - 1 && back()} />
              </Show>
              <div class="run-page" classList={{ over: n() > base() }} style={{ transform: phone() ? "none" : place(pg) }}>
                <PageView page={phone() ?? pg} act={pageAct(pg.id)} grows={!!phone()} />
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
