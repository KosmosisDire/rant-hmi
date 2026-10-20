import { For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { state } from "../../state/store";
import { openPage } from "../../state/view";
import { File, Plus, Square, Type } from "../../ui/icons";
import { find } from "./tree";

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
    send({ type: "edit", edit: { kind: "add_element", page: page.id, parent: inside ? holder.id : null, tag, props } });
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
      <div class="pane-body">
        <Show when={p.page && p.page.children.length > 0} fallback={<div class="placeholder">Add a frame or a text.</div>}>
          <Layers elements={p.page!.children} depth={0} selected={p.selected} onSelect={p.onSelect} />
        </Show>
      </div>
    </>
  );
}

function Layers(p: { elements: Element[]; depth: number; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <For each={p.elements}>
      {(e) => (
        <>
          <button class="list-row" classList={{ selected: e.id === p.selected }} onClick={() => p.onSelect(e.id)}>
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
            <Layers elements={e.children} depth={p.depth + 1} selected={p.selected} onSelect={p.onSelect} />
          </Show>
        </>
      )}
    </For>
  );
}
