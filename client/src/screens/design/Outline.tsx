import { createSignal, For, type JSX, Show } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Tag } from "../../protocol/Tag";
import { remembered } from "../../state/remember";
import { freeName } from "../../state/names";
import { startPage, state } from "../../state/store";
import { openPage } from "../../state/view";
import { ChevronDown, ChevronRight, Component, CopyPlus, File, Plus, Star, Trash } from "../../ui/icons";
import { openMenu } from "../../ui/Menu";
import { addElement } from "./add";
import { ComponentCard } from "./ComponentCard";
import type { Pick } from "./DesignScreen";
import { addMenu, elementMenu, layersMenu } from "./menus";
import { TagIcon } from "./TagIcon";
import { chain, childrenOf, find, holds, moveAll, parentOf, tops } from "./tree";
import { follow } from "../../ui/press";
import { closeDrawer } from "../../ui/Sidebars";

const FOLDS = ["open", "closed"] as const;

/** Whether each pane of the sidebar shows its body, as this browser remembers it. */
const folds = {
  pages: remembered("pane-pages", "open", FOLDS),
  components: remembered("pane-components", "open", FOLDS),
  layers: remembered("pane-layers", "open", FOLDS),
};

/** A pane's head whose word folds the body away and back, its actions on the right. */
function FoldHead(p: { title: string; pane: keyof typeof folds; first?: boolean; children: JSX.Element }) {
  const [fold, setFold] = folds[p.pane];
  return (
    <div class="pane-head" classList={{ "layers-head": !p.first }}>
      <button class="head-title fold" aria-expanded={fold() === "open"} onClick={() => setFold(fold() === "open" ? "closed" : "open")}>
        <Show when={fold() === "open"} fallback={<ChevronRight size={12} />}>
          <ChevronDown size={12} />
        </Show>
        <span>{p.title}</span>
      </button>
      {p.children}
    </div>
  );
}

const shown = (pane: keyof typeof folds) => folds[pane][0]() === "open";

/** The left sidebar: the pages, and the open page's elements as layers. */
export function Outline(p: { page: Page | undefined; selected: string[]; onPick: Pick; onEdit: (id: string, key: string) => void }) {
  let adder!: HTMLButtonElement;
  // into the frame picked last, at its top left, else onto the page
  const place = (tag: Tag, props: Record<string, string>, component: string | null = null) => {
    const page = p.page;
    if (!page) return;
    const last = p.selected.at(-1);
    const holder = last ? find(page.children, last) : undefined;
    addElement(page, holder && holds(holder.tag, tag) ? holder.id : null, tag, props, component);
  };
  const openAdd = () => {
    const page = p.page;
    const at = adder.getBoundingClientRect();
    if (page) openMenu({ x: at.left, y: at.bottom + 4 }, addMenu(page, place));
  };
  const pages = () => state.pages.filter((pg) => pg.interface === null);
  // a pick from a phone's drawer puts it away, so the page shows
  const show = (pg: Page) => {
    openPage(pg.id);
    closeDrawer();
  };
  const components = () => state.pages.filter((pg) => pg.interface !== null);
  const addPage = () => {
    let n = pages().length + 1;
    while (pages().some((pg) => pg.name === `Page ${n}`)) n++;
    send({ type: "edit", edit: { kind: "add_page", name: `Page ${n}` } });
  };
  const addComponent = () => {
    const name = freeName("Component", (n) => components().some((c) => c.name === n));
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
      <FoldHead title="Pages" pane="pages" first>
        <button class="icon-btn" title="Add a page" onClick={addPage}>
          <Plus size={14} />
        </button>
      </FoldHead>
      <div class="pages" classList={{ tall: !shown("layers") }} hidden={!shown("pages")}>
        <For each={pages()}>
          {(pg) => (
            <button class="list-row" classList={{ selected: pg.id === p.page?.id }} onClick={() => show(pg)} onContextMenu={(e) => pageMenu(e, pg)}>
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
      <FoldHead title="Components" pane="components">
        <button class="icon-btn" title="Add a component" onClick={addComponent}>
          <Plus size={14} />
        </button>
      </FoldHead>
      <div class="pages cards" classList={{ tall: !shown("layers") }} hidden={!shown("components")}>
        <For each={components()} fallback={<div class="field-hint list-hint">Make a part once, place it on many pages.</div>}>
          {(c) => <ComponentCard component={c} open={c.id === p.page?.id} page={p.page} onMenu={(e) => pageMenu(e, c)} />}
        </For>
      </div>
      <FoldHead title="Layers" pane="layers">
        <button ref={adder} class="icon-btn" title="Add an element" onClick={openAdd}>
          <Plus size={14} />
        </button>
      </FoldHead>
      <Show
        when={shown("layers") && p.page && p.page.children.length > 0}
        fallback={
          <Show when={shown("layers")}>
            <div class="pane-body placeholder" onContextMenu={(e) => p.page && layersMenu(e, p.page, p.onPick, () => {})}>
              Nothing here yet. Add with the + above, or a right click.
            </div>
          </Show>
        }
      >
        <LayerList page={p.page!} selected={p.selected} onPick={p.onPick} onEdit={p.onEdit} />
      </Show>
    </>
  );
}

/** Where dragged layers would land: `index` of `parent`, counted without them. A line between
 *  rows shows the place, indented to its depth, or a frame they go into lights up. */
type Spot = { parent: string | null; index: number; line?: { y: number; depth: number }; into?: string };

/** The layers, front first as they stack. Rows dragged onto another's edge go in front of or
 *  behind it, onto a frame's middle into that frame, and below them all to the page's back.
 *  A selected row takes the rest of the selection with it. */
function LayerList(p: { page: Page; selected: string[]; onPick: Pick; onEdit: (id: string, key: string) => void }) {
  let host!: HTMLDivElement;
  let press: { id: string; y: number } | null = null;
  const [dragging, setDragging] = createSignal<string[]>([]);
  const [spot, setSpot] = createSignal<Spot | null>(null);

  const spotAt = (y: number, ids: string[]): Spot | null => {
    const rows = [...host.querySelectorAll<HTMLElement>(".list-row[data-id]")].map((row) => ({ id: row.dataset.id!, open: row.dataset.open !== undefined, r: row.getBoundingClientRect() }));
    const top = host.getBoundingClientRect().top - host.scrollTop;
    // only where all that is dragged may go: shapes in diagrams, the rest in frames
    const tags = ids.map((id) => find(p.page.children, id)?.tag).filter((t): t is Tag => !!t);
    const fits = (holder: string | null) => tags.every((t) => holds(holder ? (find(p.page.children, holder)?.tag ?? null) : null, t));
    const stays = (holder: string | null) => childrenOf(p.page, holder).filter((c) => !ids.includes(c.id));
    // the row under the pointer, or in a gap the one below it
    const i = rows.findIndex(({ r }) => y < r.bottom);
    if (i < 0) return fits(null) && rows.length > 0 ? { parent: null, index: 0, line: { y: rows[rows.length - 1].r.bottom - top + 1, depth: 0 } } : null;
    const { id: over, open, r } = rows[i];
    const path = chain(p.page.children, over) ?? [];
    if (path.some((e) => ids.includes(e.id))) return null;
    const f = Math.max(0, (y - r.top) / r.height);
    // under an open frame the next row is its front child, so its lower edge means inside too
    if (fits(over) && f > 0.25 && (f < 0.75 || open)) return { parent: over, index: stays(over).length, into: over };
    const parent = parentOf(p.page, over);
    if (!fits(parent)) return null;
    const k = stays(parent).findIndex((c) => c.id === over);
    const front = f < 0.5;
    // midway between this row and its neighbour, so one place draws one line
    const near = rows[front ? i - 1 : i + 1]?.r;
    const at = front ? (near ? (near.bottom + r.top) / 2 : r.top) : near ? (r.bottom + near.top) / 2 : r.bottom;
    return { parent, index: front ? k + 1 : k, line: { y: at - top, depth: path.length - 1 } };
  };

  const down = (e: PointerEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".list-row[data-id]")?.dataset.id;
    if (e.button !== 0 || !id) return;
    press = { id, y: e.clientY };
    follow(e, { move, end: up });
  };
  const move = (e: PointerEvent) => {
    if (!press) return;
    if (dragging().length === 0 && Math.abs(e.clientY - press.y) > 4) {
      const several = p.selected.length > 1 && p.selected.includes(press.id);
      // back to front, so they keep their order where they land
      setDragging(several ? tops(p.page, p.selected).map((x) => x.id) : [press.id]);
      // once captured, the release clicks no row
      host.setPointerCapture(e.pointerId);
    }
    if (dragging().length > 0) setSpot(spotAt(e.clientY, dragging()));
  };
  const up = () => {
    const [ids, s] = [dragging(), spot()];
    press = null;
    setDragging([]);
    setSpot(null);
    if (ids.length > 0 && s) moveAll(p.page, ids, s.parent, s.index);
  };

  return (
    <div
      class="pane-body layers"
      ref={host}
      onPointerDown={down}
      // a row has its own menu, so this is the space around them, the page's top level
      onContextMenu={(e) => layersMenu(e, p.page, p.onPick, () => p.page.children.forEach((c) => p.onPick(c.id, true)))}
    >
      <Layers
        elements={p.page.children}
        depth={0}
        selected={p.selected}
        dragging={dragging()}
        spot={spot()}
        onPick={p.onPick}
        onEdit={p.onEdit}
        onMenu={(e, id) => {
          // a long press opens the menu, so it moves no row
          press = null;
          setDragging([]);
          setSpot(null);
          elementMenu(e, p.page, p.selected, p.onPick, id);
        }}
      />
      <Show when={spot()?.line}>{(l) => <div class="drop-line" style={{ top: `${l().y}px`, left: `${14 + l().depth * 14}px` }} />}</Show>
    </div>
  );
}

function Layers(p: {
  elements: Element[];
  depth: number;
  selected: string[];
  dragging: string[];
  spot: Spot | null;
  onPick: Pick;
  onEdit: (id: string, key: string) => void;
  onMenu: (e: MouseEvent, id: string) => void;
}) {
  return (
    <For each={[...p.elements].reverse()}>
      {(e) => (
        <>
          <button
            class="list-row"
            classList={{ selected: p.selected.includes(e.id), dragged: p.dragging.includes(e.id), "drop-inside": p.spot?.into === e.id }}
            data-id={e.id}
            data-frame={e.tag === "div" || e.tag === "group" || e.tag === "svg" || e.tag === "g" ? "" : undefined}
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
          </button>
          <Show when={e.children.length > 0}>
            <Layers elements={e.children} depth={p.depth + 1} selected={p.selected} dragging={p.dragging} spot={p.spot} onPick={p.onPick} onEdit={p.onEdit} onMenu={p.onMenu} />
          </Show>
        </>
      )}
    </For>
  );
}
