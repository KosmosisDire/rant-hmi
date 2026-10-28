// A component as a card in the Design sidebar: a live picture of it over its name. A click
// opens it, and a drag places an instance on the page it lands on, centred there. Either
// puts a phone's drawer away.

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fitIn, PageView } from "../../page/PageView";
import type { Page } from "../../protocol/Page";
import { UNIT } from "../../state/bind";
import { page as pageOf } from "../../state/store";
import { openPage } from "../../state/view";
import { addElement } from "./add";
import { follow } from "../../ui/press";
import { closeDrawer } from "../../ui/Sidebars";
import { createSize } from "../../ui/size";

/** How far a press moves before it is a drag and no longer a click. */
const SLOP = 6;

/** A component drawn whole in a box of `w` by `h`, centred. */
function Picture(p: { component: Page; w: number; h: number }) {
  const [w, h] = [() => p.component.width * UNIT, () => p.component.height * UNIT];
  const k = () => fitIn(w(), h(), p).k;
  return (
    <div class="card-fit" style={{ width: `${w()}px`, height: `${h()}px`, transform: `translate(-50%, -50%) scale(${k()})` }}>
      <PageView page={p.component} />
    </div>
  );
}

export function ComponentCard(p: { component: Page; open: boolean; onMenu: (e: MouseEvent) => void }) {
  let thumb!: HTMLDivElement;
  const box = createSize();
  onMount(() => box.track(thumb));

  const [ghost, setGhost] = createSignal<{ x: number; y: number } | null>(null);
  let press: { id: number; x: number; y: number } | null = null;
  let dragged = false;
  const end = () => {
    press = null;
    setGhost(null);
  };
  // Escape lets go of a drag, placing nothing
  createEffect(() => {
    if (!ghost()) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && end();
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    dragged = false;
    const card = e.currentTarget as HTMLElement;
    follow(e, { move: (m) => move(m, card), end: up });
  };
  const move = (e: PointerEvent, card: HTMLElement) => {
    if (!press) return;
    if (!ghost()) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP) return;
      card.setPointerCapture(e.pointerId);
      dragged = true;
      closeDrawer();
    }
    setGhost({ x: e.clientX, y: e.clientY });
  };
  // a release missed places nothing
  const up = (e?: PointerEvent) => {
    if (press && e?.type === "pointerup" && ghost()) drop(e.clientX, e.clientY);
    end();
  };
  // onto the page on the board where it lands, unless that page is this component
  const drop = (x: number, y: number) => {
    const layer = document.elementFromPoint(x, y)?.closest(".artboard .page-layer[data-page]");
    const page = layer && pageOf(layer.getAttribute("data-page") ?? "");
    const sheet = layer?.querySelector(":scope > .page");
    if (!page || !sheet || page.id === p.component.id) return;
    const r = sheet.getBoundingClientRect();
    const k = r.width / page.width;
    const { name, width: w, height: h } = p.component;
    addElement(page, null, "use", { name, w: String(w), h: String(h) }, name, { x: (x - r.left) / k - w / 2, y: (y - r.top) / k - h / 2 });
  };

  return (
    <button
      class="card"
      title={p.component.name}
      classList={{ selected: p.open, dragged: !!ghost() }}
      onClick={() => {
        if (dragged) return;
        openPage(p.component.id);
        closeDrawer();
      }}
      onPointerDown={down}
      onContextMenu={(e) => {
        end();
        p.onMenu(e);
      }}
    >
      <div class="card-thumb" ref={thumb}>
        <Picture component={p.component} w={box().w} h={box().h} />
      </div>
      <span class="list-label">{p.component.name}</span>
      <Show when={ghost()}>
        {(g) => (
          <Portal>
            <div class="card-ghost" style={{ left: `${g().x}px`, top: `${g().y}px`, width: `${box().w}px`, height: `${box().h}px` }}>
              <Picture component={p.component} w={box().w} h={box().h} />
            </div>
          </Portal>
        )}
      </Show>
    </button>
  );
}
