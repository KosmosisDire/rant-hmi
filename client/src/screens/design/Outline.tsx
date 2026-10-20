import { createSignal, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { state } from "../../state/store";
import { openPage } from "../../state/view";
import { File, Plus, Square, Type } from "../../ui/icons";
import { chain, childrenOf, find, moveTo, parentOf } from "./tree";

/** What a new frame or text starts as: visible, on the grid, and plainly named. */
const STARTS: Record<Tag, Record<string, string>> = {
  div: { name: "Frame", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35", "border-radius": "8" },
  span: { name: "Text", x: "44", y: "44", w: "176", h: "44", text: '"Text"', color: "#e4e6e8", "font-size": "18" },
};

/** The left sidebar: the pages, and the open page's elements as layers. */
export function Outline(p: { page: Page | undefined; selected: string | null; onSelect: (id: string | null) => void }) {
  const add = (tag: Tag) => {
    const page = p.page;
    if (!page) return;
    // into the selected frame, at its top left, else onto the page
    const holder = p.selected ? find(page.children, p.selected) : undefined;
    const inside = holder?.tag === "div";
    const props = { ...STARTS[tag], ...(inside ? { x: "11", y: "11" } : {}) };
    send({ type: "edit", edit: { kind: "add_element", page: page.id, parent: inside ? holder.id : null, index: null, element: { id: "", tag, props, children: [] } } });
  };
  const addPage = () => send({ type: "edit", edit: { kind: "add_page", name: `Page ${state.pages.length + 1}` } });

  return (
    <>
      <div class="pane-head">
        <span class="head-title">Pages</span>
        <button class="icon-btn" title="Add a page" onClick={addPage}>
          <Plus size={14} />
        </button>
      </div>
      <div class="pages">
        <For each={state.pages}>
          {(pg) => (
            <button class="list-row" classList={{ selected: pg.id === p.page?.id }} onClick={() => openPage(pg.id)}>
              <File size={14} />
              <span class="list-label">{pg.name}</span>
              <span class="list-trail mono">
                {pg.width}x{pg.height}
              </span>
            </button>
          )}
        </For>
      </div>
      <div class="pane-head layers-head">
        <span class="head-title">Layers</span>
        <button class="icon-btn" title="Add a frame" onClick={() => add("div")}>
          <Square size={14} />
        </button>
        <button class="icon-btn" title="Add a text" onClick={() => add("span")}>
          <Type size={14} />
        </button>
      </div>
      <Show when={p.page && p.page.children.length > 0} fallback={<div class="pane-body placeholder">Add a frame or a text.</div>}>
        <LayerList page={p.page!} selected={p.selected} onSelect={p.onSelect} />
      </Show>
    </>
  );
}

/** Where a dragged layer would land: in front of a row, behind it, or inside a frame. */
type Spot = { id: string; where: "front" | "behind" | "inside" };

/** The layers, front first as they stack. A row dragged onto another's edge goes in front of
 *  or behind it, onto a frame's middle into that frame. */
function LayerList(p: { page: Page; selected: string | null; onSelect: (id: string) => void }) {
  let host!: HTMLDivElement;
  let press: { id: string; y: number } | null = null;
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [spot, setSpot] = createSignal<Spot | null>(null);

  const spotAt = (y: number, id: string): Spot | null => {
    for (const row of host.querySelectorAll<HTMLElement>(".list-row[data-id]")) {
      const r = row.getBoundingClientRect();
      if (y < r.top || y >= r.bottom) continue;
      const over = row.dataset.id!;
      if (chain(p.page.children, over)?.some((e) => e.id === id)) return null;
      const f = (y - r.top) / r.height;
      const frame = row.dataset.frame !== undefined;
      // under an open frame the next row is its front child, so its lower edge means inside too
      if (frame && f > 0.25 && (f < 0.75 || row.dataset.open !== undefined)) return { id: over, where: "inside" };
      return { id: over, where: f < 0.5 ? "front" : "behind" };
    }
    return null;
  };

  const drop = (id: string, s: Spot) => {
    if (s.where === "inside") {
      const frame = find(p.page.children, s.id);
      if (frame) moveTo(p.page, id, frame.id, frame.children.filter((c) => c.id !== id).length);
      return;
    }
    const parent = parentOf(p.page, s.id);
    const at = childrenOf(p.page, parent)
      .filter((c) => c.id !== id)
      .findIndex((c) => c.id === s.id);
    moveTo(p.page, id, parent, s.where === "front" ? at + 1 : at);
  };

  const down = (e: PointerEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".list-row[data-id]")?.dataset.id;
    if (e.button === 0 && id) press = { id, y: e.clientY };
  };
  const move = (e: PointerEvent) => {
    if (!press) return;
    if (!dragging() && Math.abs(e.clientY - press.y) > 4) {
      setDragging(press.id);
      // once captured, the release clicks no row
      host.setPointerCapture(e.pointerId);
    }
    if (dragging()) setSpot(spotAt(e.clientY, press.id));
  };
  const up = () => {
    const [id, s] = [dragging(), spot()];
    press = null;
    setDragging(null);
    setSpot(null);
    if (id && s) drop(id, s);
  };

  return (
    <div class="pane-body" ref={host} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <Layers elements={p.page.children} depth={0} selected={p.selected} dragging={dragging()} spot={spot()} onSelect={p.onSelect} />
    </div>
  );
}

function Layers(p: { elements: Element[]; depth: number; selected: string | null; dragging: string | null; spot: Spot | null; onSelect: (id: string) => void }) {
  const at = (id: string) => (p.spot?.id === id ? p.spot.where : undefined);
  return (
    <For each={[...p.elements].reverse()}>
      {(e) => (
        <>
          <button
            class="list-row"
            classList={{ selected: e.id === p.selected, dragged: e.id === p.dragging, "drop-front": at(e.id) === "front", "drop-behind": at(e.id) === "behind", "drop-inside": at(e.id) === "inside" }}
            data-id={e.id}
            data-frame={e.tag === "div" ? "" : undefined}
            data-open={e.children.length > 0 ? "" : undefined}
            onClick={() => p.onSelect(e.id)}
          >
            <span style={{ width: `${p.depth * 14}px` }} />
            <span class="layer-icon">
              <Show when={e.tag === "div"} fallback={<Type size={13} />}>
                <Square size={13} />
              </Show>
            </span>
            <span class="list-label">{e.props.name ?? e.id}</span>
            <span class="list-trail mono faint">{e.id}</span>
          </button>
          <Show when={e.children.length > 0}>
            <Layers elements={e.children} depth={p.depth + 1} selected={p.selected} dragging={p.dragging} spot={p.spot} onSelect={p.onSelect} />
          </Show>
        </>
      )}
    </For>
  );
}
