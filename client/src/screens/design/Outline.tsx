import { createSignal, For, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { number } from "../../state/bind";
import { startPage, state } from "../../state/store";
import { openPage } from "../../state/view";
import { Component, CopyPlus, File, Image, Plus, Shapes, Square, Star, TextCursorInput, Trash, Type, Video } from "../../ui/icons";
import { openMenu } from "../../ui/Menu";
import { Popover } from "../../ui/Popover";
import type { Pick } from "./DesignScreen";
import { elementMenu } from "./menus";
import { TagIcon } from "./TagIcon";
import { chain, childrenOf, find, holds, moveTo, parentOf } from "./tree";

/** What a new element starts as: visible, on the grid, and plainly named. A drawing starts
 *  empty, its shapes added from the inspector. */
const STARTS: Record<"div" | "span" | "input" | "img" | "video" | "svg", Record<string, string>> = {
  div: { name: "Frame", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35", "border-radius": "8" },
  span: { name: "Text", x: "44", y: "44", w: "176", h: "44", text: '"Text"', color: "#e4e6e8", "font-size": "18" },
  input: {
    name: "Input",
    x: "44",
    y: "44",
    w: "176",
    h: "44",
    background: "#1e2125",
    "border-width": "1",
    "border-style": '"solid"',
    "border-color": "#3a4046",
    "border-radius": "6",
    padding: '"0 11px"',
    color: "#e4e6e8",
    "font-size": "18",
  },
  img: { name: "Image", x: "44", y: "44", w: "352", h: "264", fit: '"meet"' },
  video: { name: "Video", x: "44", y: "44", w: "352", h: "264", fit: '"meet"' },
  svg: { name: "Drawing", x: "44", y: "44", w: "176", h: "176" },
};

/** The left sidebar: the pages, and the open page's elements as layers. */
export function Outline(p: { page: Page | undefined; selected: string[]; onPick: Pick; onEdit: (id: string, key: string) => void }) {
  const [picking, setPicking] = createSignal(false);
  let placer!: HTMLButtonElement;
  // into the frame picked last, at its top left, else onto the page
  const place = (tag: Tag, props: Record<string, string>, component: string | null = null) => {
    const page = p.page;
    if (!page) return;
    const last = p.selected.at(-1);
    const holder = last ? find(page.children, last) : undefined;
    const inside = !!holder && holds(holder.tag, tag);
    // step past what already sits there, so a new element never hides behind an old one
    const siblings = inside ? holder.children : page.children;
    let n = inside ? 11 : 44;
    while (siblings.some((e) => number(e.props.x) === n && number(e.props.y) === n)) n += 22;
    const at = { x: String(n), y: String(n) };
    send({ type: "edit", edit: { kind: "add_element", page: page.id, parent: inside ? holder.id : null, index: null, element: { id: "", tag, component, props: { ...props, ...at }, handlers: [], children: [] } } });
  };
  const add = (tag: keyof typeof STARTS) => place(tag, STARTS[tag]);
  const addInstance = (c: Page) => {
    setPicking(false);
    place("use", { name: c.name, w: String(c.width), h: String(c.height) }, c.name);
  };
  const pages = () => state.pages.filter((pg) => pg.interface === null);
  const components = () => state.pages.filter((pg) => pg.interface !== null);
  const addPage = () => {
    let n = pages().length + 1;
    while (pages().some((pg) => pg.name === `Page ${n}`)) n++;
    send({ type: "edit", edit: { kind: "add_page", name: `Page ${n}` } });
  };
  const addComponent = () => {
    let name = "Component";
    for (let n = 2; components().some((c) => c.name === name); n++) name = `Component${n}`;
    send({ type: "edit", edit: { kind: "add_component", name } });
  };
  // a copy's name, free among the pages, spelled as a component's when it is one
  const copyPage = (pg: Page) => {
    const spell = (n: number) => (pg.interface ? `${pg.name}Copy${n > 1 ? n : ""}` : `${pg.name} copy${n > 1 ? ` ${n}` : ""}`);
    let n = 1;
    while (state.pages.some((other) => other.name === spell(n))) n++;
    send({ type: "edit", edit: { kind: "copy_page", page: pg.id, name: spell(n) } });
  };
  const pageMenu = (e: MouseEvent, pg: Page) => {
    const component = pg.interface !== null;
    const last = !component && pages().length < 2;
    openMenu(e, [
      { label: "Open", icon: component ? <Component size={13} /> : <File size={13} />, run: () => openPage(pg.id) },
      { label: "Duplicate", icon: <CopyPlus size={13} />, run: () => copyPage(pg) },
      ...(component ? [] : [{ label: "Make the start page", icon: <Star size={13} />, disabled: startPage() === pg.id, run: () => send({ type: "set_start", page: pg.id }) }]),
      "-",
      { label: component ? "Delete component" : "Delete page", icon: <Trash size={13} />, disabled: last, run: () => send({ type: "edit", edit: { kind: "remove_page", page: pg.id } }) },
    ]);
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
            <button class="list-row" classList={{ selected: pg.id === p.page?.id }} onClick={() => openPage(pg.id)} onContextMenu={(e) => pageMenu(e, pg)}>
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
            <button class="list-row" classList={{ selected: c.id === p.page?.id }} onClick={() => openPage(c.id)} onContextMenu={(e) => pageMenu(e, c)}>
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
        <button class="icon-btn" title="Add an input" onClick={() => add("input")}>
          <TextCursorInput size={14} />
        </button>
        <button class="icon-btn" title="Add an image" onClick={() => add("img")}>
          <Image size={14} />
        </button>
        <button class="icon-btn" title="Add a video" onClick={() => add("video")}>
          <Video size={14} />
        </button>
        <button class="icon-btn" title="Add a drawing" onClick={() => add("svg")}>
          <Shapes size={14} />
        </button>
        <button ref={placer} class="icon-btn" classList={{ on: picking() }} title="Place a component" onClick={() => setPicking(!picking())}>
          <Component size={14} />
        </button>
      </div>
      <Show when={picking()}>
        <Popover anchor={placer} onClose={() => setPicking(false)} class="choice-list add-menu">
          <For each={components().filter((c) => c.id !== p.page?.id)} fallback={<div class="field-hint">Add a component first, under Components.</div>}>
            {(c) => (
              <button class="menu-item" onClick={() => addInstance(c)}>
                <span class="kind kind-local">
                  <Component size={13} />
                </span>
                <span>{c.name}</span>
              </button>
            )}
          </For>
        </Popover>
      </Show>
      <Show when={p.page && p.page.children.length > 0} fallback={<div class="pane-body placeholder">Add a frame or a text.</div>}>
        <LayerList page={p.page!} selected={p.selected} onPick={p.onPick} onEdit={p.onEdit} />
      </Show>
    </>
  );
}

/** Where a dragged layer would land: in front of a row, behind it, or inside a frame. */
type Spot = { id: string; where: "front" | "behind" | "inside" };

/** The layers, front first as they stack. A row dragged onto another's edge goes in front of
 *  or behind it, onto a frame's middle into that frame. */
function LayerList(p: { page: Page; selected: string[]; onPick: Pick; onEdit: (id: string, key: string) => void }) {
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
      // only where what is dragged may go: shapes in drawings, the rest in frames
      const tag = find(p.page.children, id)?.tag;
      const at = find(p.page.children, over);
      const parent = parentOf(p.page, over);
      if (!tag) return null;
      const frame = !!at && holds(at.tag, tag);
      // under an open frame the next row is its front child, so its lower edge means inside too
      if (frame && f > 0.25 && (f < 0.75 || row.dataset.open !== undefined)) return { id: over, where: "inside" };
      if (!holds(parent ? (find(p.page.children, parent)?.tag ?? null) : null, tag)) return null;
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
      <Layers
        elements={p.page.children}
        depth={0}
        selected={p.selected}
        dragging={dragging()}
        spot={spot()}
        onPick={p.onPick}
        onEdit={p.onEdit}
        onMenu={(e, id) => elementMenu(e, p.page, p.selected, p.onPick, id)}
      />
    </div>
  );
}

function Layers(p: {
  elements: Element[];
  depth: number;
  selected: string[];
  dragging: string | null;
  spot: Spot | null;
  onPick: Pick;
  onEdit: (id: string, key: string) => void;
  onMenu: (e: MouseEvent, id: string) => void;
}) {
  const at = (id: string) => (p.spot?.id === id ? p.spot.where : undefined);
  return (
    <For each={[...p.elements].reverse()}>
      {(e) => (
        <>
          <button
            class="list-row"
            classList={{ selected: p.selected.includes(e.id), dragged: e.id === p.dragging, "drop-front": at(e.id) === "front", "drop-behind": at(e.id) === "behind", "drop-inside": at(e.id) === "inside" }}
            data-id={e.id}
            data-frame={e.tag === "div" || e.tag === "svg" || e.tag === "g" ? "" : undefined}
            data-open={e.children.length > 0 ? "" : undefined}
            onClick={(ev) => p.onPick(e.id, ev.shiftKey || ev.ctrlKey || ev.metaKey)}
            onDblClick={() => p.onEdit(e.id, "name")}
            onContextMenu={(ev) => p.onMenu(ev, e.id)}
          >
            <span style={{ width: `${p.depth * 14}px` }} />
            <span class="layer-icon">
              <TagIcon tag={e.tag} size={13} />
            </span>
            <span class="list-label">{e.props.name ?? e.id}</span>
            <span class="list-trail mono faint">{e.id}</span>
          </button>
          <Show when={e.children.length > 0}>
            <Layers elements={e.children} depth={p.depth + 1} selected={p.selected} dragging={p.dragging} spot={p.spot} onPick={p.onPick} onEdit={p.onEdit} onMenu={p.onMenu} />
          </Show>
        </>
      )}
    </For>
  );
}
