import { createSignal, For, Match, Show, Switch } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { startPage, state } from "../../state/store";
import { openPage } from "../../state/view";
import { Component, File, Plus, Square, Type } from "../../ui/icons";
import { chain, childrenOf, find, moveTo, parentOf } from "./tree";
import { number } from "../../state/bind";

/** What a new frame or text starts as: visible, on the grid, and plainly named. */
const STARTS: Record<Exclude<Tag, "use">, Record<string, string>> = {
  div: { name: "Frame", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35", "border-radius": "8" },
  span: { name: "Text", x: "44", y: "44", w: "176", h: "44", text: '"Text"', color: "#e4e6e8", "font-size": "18" },
};

/** The left sidebar: the pages, and the open page's elements as layers. */
export function Outline(p: { page: Page | undefined; selected: string | null; onSelect: (id: string | null) => void }) {
  const [picking, setPicking] = createSignal(false);
  // into the selected frame, at its top left, else onto the page
  const place = (tag: Tag, props: Record<string, string>, component: string | null = null) => {
    const page = p.page;
    if (!page) return;
    const holder = p.selected ? find(page.children, p.selected) : undefined;
    const inside = holder?.tag === "div";
    // step past what already sits there, so a new element never hides behind an old one
    const siblings = inside ? holder.children : page.children;
    let n = inside ? 11 : 44;
    while (siblings.some((e) => number(e.props.x) === n && number(e.props.y) === n)) n += 22;
    const at = { x: String(n), y: String(n) };
    send({ type: "edit", edit: { kind: "add_element", page: page.id, parent: inside ? holder.id : null, index: null, element: { id: "", tag, component, props: { ...props, ...at }, handlers: [], children: [] } } });
  };
  const add = (tag: Exclude<Tag, "use">) => place(tag, STARTS[tag]);
  const addInstance = (c: Page) => {
    setPicking(false);
    place("use", { name: c.name, w: String(c.width), h: String(c.height) }, c.name);
  };
  const pages = () => state.pages.filter((pg) => pg.interface === null);
  const components = () => state.pages.filter((pg) => pg.interface !== null);
  const addPage = () => send({ type: "edit", edit: { kind: "add_page", name: `Page ${pages().length + 1}` } });
  const addComponent = () => {
    let name = "Component";
    for (let n = 2; components().some((c) => c.name === name); n++) name = `Component${n}`;
    send({ type: "edit", edit: { kind: "add_component", name } });
  };

  return (
    <>
      <div class="pane-head">
        <span class="head-title">Pages</span>
        <button class="icon-btn" title="Add a page" onClick={addPage}>
          <Plus size={14} />
        </button>
      </div>
      <div class="pages">
        <For each={pages()}>
          {(pg) => (
            <button class="list-row" classList={{ selected: pg.id === p.page?.id }} onClick={() => openPage(pg.id)}>
              <File size={14} />
              <span class="list-label">{pg.name}</span>
              <Show when={startPage() === pg.id}>
                <span class="tag" title="Operators' screens open on this page">start</span>
              </Show>
              <span class="list-trail mono">
                {pg.width}x{pg.height}
              </span>
            </button>
          )}
        </For>
      </div>
      <div class="pane-head layers-head">
        <span class="head-title">Components</span>
        <button class="icon-btn" title="Add a component" onClick={addComponent}>
          <Plus size={14} />
        </button>
      </div>
      <div class="pages">
        <For each={components()} fallback={<div class="field-hint list-hint">Make a part once, place it on many pages.</div>}>
          {(c) => (
            <button class="list-row" classList={{ selected: c.id === p.page?.id }} onClick={() => openPage(c.id)}>
              <span class="kind kind-local">
                <Component size={14} />
              </span>
              <span class="list-label">{c.name}</span>
              <span class="list-trail mono">
                {c.width}x{c.height}
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
        <button class="icon-btn" classList={{ on: picking() }} title="Place a component" onClick={() => setPicking(!picking())}>
          <Component size={14} />
        </button>
      </div>
      <Show when={picking()}>
        <div class="add-menu">
          <For each={components().filter((c) => c.id !== p.page?.id)} fallback={<div class="field-hint">Add a component first, under Components.</div>}>
            {(c) => (
              <button class="list-row" onClick={() => addInstance(c)}>
                <span class="kind kind-local">
                  <Component size={14} />
                </span>
                <span class="list-label">{c.name}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
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
              <Switch fallback={<Type size={13} />}>
                <Match when={e.tag === "div"}>
                  <Square size={13} />
                </Match>
                <Match when={e.tag === "use"}>
                  <Component size={13} />
                </Match>
              </Switch>
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
