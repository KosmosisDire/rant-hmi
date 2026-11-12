import { createEffect, createSignal, For, on, Show, untrack } from "solid-js";
import { send } from "../../net/connection";
import type { Element } from "../../protocol/Element";
import type { Page } from "../../protocol/Page";
import type { Space } from "../../protocol/Space";
import type { Tag } from "../../protocol/Tag";
import type { Variable } from "../../protocol/Variable";
import { edit } from "../../state/change";
import { rememberedWords } from "../../state/remember";
import { freeName } from "../../state/names";
import { startPage, state } from "../../state/store";
import { flyTo } from "../../state/view";
import { isNumber } from "../../state/bind";
import { chain, find } from "../../state/elements";
import { CircleDot, Component, CopyPlus, File, FilePlus, Plus, Repeat, Rotate3d, Star, Trash, Zap } from "../../ui/icons";
import { dragToFolder, FolderTree, INDENT, justDragged, moveRow, TreeRow } from "../../ui/Tree";
import { type MenuEntry, openMenu } from "../../ui/Menu";
import { addElement } from "./add";
import { PagePicture, placeComponent } from "./PagePicture";
import type { Pick } from "./DesignScreen";
import { addMenu, elementMenu, layersMenu } from "./menus";
import { TagIcon } from "./TagIcon";
import { childrenOf, holds, isHolder, moveAll, parentOf, tops } from "./tree";
import { follow } from "../../ui/press";
import { closeDrawer } from "../../ui/Sidebars";

/** The pages and frames opened in the layers, a page by its id and a frame by its page's and
 *  its own. All start folded. */
const [opened, setOpened] = rememberedWords("layers-open");

/** Opens a page, with an element on it picked or none. */
type Open = (page: string, id?: string | null) => void;

/** The left sidebar, one tree: the components and the pages in their folders, each the top of
 *  its layers. */
export function Outline(p: { page: Page | undefined; selected: string[]; onPick: Pick; onOpen: Open; onEdit: (id: string, key: string) => void }) {
  // into the frame picked last, at its top left, else onto the page
  const place = (tag: Tag, props: Record<string, string>, component: string | null = null) => {
    const page = p.page;
    if (!page) return;
    const last = p.selected.at(-1);
    const holder = last ? find(page.children, last) : undefined;
    addElement(page, holder && holds(page, holder.tag, { tag, component }) ? holder.id : null, tag, props, component);
  };
  const openAdd = (button: HTMLElement) => {
    const page = p.page;
    const at = button.getBoundingClientRect();
    if (page) openMenu({ x: at.left, y: at.bottom + 4 }, addMenu(page, place));
  };
  const pages = () => state.pages.filter((pg) => pg.interface === null);
  const components = () => state.pages.filter((pg) => pg.interface !== null);
  const addPage = () => {
    let n = pages().length + 1;
    while (pages().some((pg) => pg.name === `Page ${n}`)) n++;
    edit({ kind: "add_page", name: `Page ${n}` });
  };
  // a 3D one holds parts and is placed in a scene
  const addComponent = (space: Space) => {
    const name = freeName(space === "3d" ? "Component3D" : "Component", (n) => components().some((c) => c.name === n));
    edit({ kind: "add_component", name, space });
  };
  // a copy's name, free among the pages, spelled as a component's when it is one
  const copyPage = (pg: Page) => {
    const spell = (n: number) => (pg.interface ? `${pg.name}Copy${n > 1 ? n : ""}` : `${pg.name} copy${n > 1 ? ` ${n}` : ""}`);
    let n = 1;
    while (state.pages.some((other) => other.name === spell(n))) n++;
    edit({ kind: "copy_page", page: pg.id, name: spell(n) });
  };
  /** The rows a page or component has of its own. */
  const pageRows = (pg: Page): MenuEntry[] => {
    const component = pg.interface !== null;
    const last = !component && pages().length < 2;
    const kind = component ? "components" : "pages";
    return [
      { label: "Duplicate", icon: <CopyPlus size={13} />, run: () => copyPage(pg) },
      moveRow(kind, pg.id, pg.folder, state.folders[kind]),
      ...(component ? [] : [{ label: "Make the start page", icon: <Star size={13} />, disabled: startPage() === pg.id, run: () => send({ type: "set_start", page: pg.id }) }]),
      "-",
      { label: component ? "Delete component" : "Delete page", icon: <Trash size={13} />, disabled: last, run: () => edit({ kind: "remove_page", page: pg.id }) },
    ];
  };
  // a band's menu adds to its page, so it opens the page first
  const bandMenu = (e: MouseEvent, pg: Page) => {
    p.onOpen(pg.id);
    layersMenu(e, pg, p.onPick, () => pg.children.forEach((c) => p.onPick(c.id, true)), ["-", ...pageRows(pg)]);
  };

  const shut = (key: string) => !opened().includes(key);
  const fold = (key: string) => setOpened(shut(key) ? [...opened(), key] : opened().filter((k) => k !== key));
  // what is picked shows its row, its page and the frames around it opening, though one folded
  // after stays so. One picked as it is made may come before the page holding it, so the tree
  // is read again as it changes until each picked one is in it.
  let [last, unseen]: [string[], string[]] = [[], []];
  createEffect(() => {
    const [picked, page] = [p.selected, p.page];
    if (picked !== last) [last, unseen] = [picked, [...picked]];
    if (!page || unseen.length === 0) return;
    const found = unseen.flatMap((id) => {
      const path = chain(page.children, id);
      return path ? [{ id, around: path.slice(0, -1).map((e) => `${page.id} ${e.id}`) }] : [];
    });
    if (found.length === 0) return;
    unseen = unseen.filter((id) => !found.some((f) => f.id === id));
    untrack(() => {
      const closed = [...new Set([page.id, ...found.flatMap((f) => f.around)])].filter(shut);
      if (closed.length > 0) setOpened([...opened(), ...closed]);
    });
  });
  // the open page's band, or the row picked on it, scrolls into sight once drawn
  let tree: HTMLDivElement | undefined;
  createEffect(
    on([() => p.page?.id, () => p.selected], () =>
      requestAnimationFrame(() => tree?.querySelector(".page-group.open .list-row.selected[data-id], .page-group.open .page-row")?.scrollIntoView({ block: "nearest" })),
    ),
  );

  const band = (pg: Page, depth: number) => (
    <PageLayers
      page={pg}
      depth={depth}
      open={pg.id === p.page?.id}
      start={startPage() === pg.id}
      selected={p.selected}
      shut={shut}
      onFold={fold}
      onPick={p.onPick}
      onOpen={p.onOpen}
      onEdit={p.onEdit}
      onMenu={bandMenu}
      onAdd={openAdd}
    />
  );

  return (
    // the space below the rows is the open page's, as its row is
    <div class="pane-body layers" ref={tree} onContextMenu={(e) => p.page && bandMenu(e, p.page)}>
      <FolderTree
        kind="components"
        title="Components"
        folders={state.folders.components}
        items={components()}
        folderOf={(c) => c.folder}
        row={band}
        end={
          <>
            <button class="row-add" title="Add a 3D component" onClick={(e) => (e.stopPropagation(), addComponent("3d"))}>
              <Rotate3d size={14} />
            </button>
            <button class="row-add" title="Add a component" onClick={(e) => (e.stopPropagation(), addComponent("2d"))}>
              <Plus size={15} />
            </button>
          </>
        }
      />
      <FolderTree
        kind="pages"
        title="Pages"
        folders={state.folders.pages}
        items={pages()}
        folderOf={(pg) => pg.folder}
        row={band}
        end={
          <button class="row-add" title="Add a page" onClick={(e) => (e.stopPropagation(), addPage())}>
            <FilePlus size={14} />
          </button>
        }
      />
    </div>
  );
}

/** A page's or component's row, pinned while its layers scroll beneath it. A press opens it and
 *  flies to it, its caret shows or hides what it holds, and a drag takes it into a folder, or a
 *  component onto a page on the board, placed there. The open one's + adds to it. */
function PageLayers(p: {
  page: Page;
  depth: number;
  open: boolean;
  start: boolean;
  selected: string[];
  shut: (key: string) => boolean;
  onFold: (key: string) => void;
  onPick: Pick;
  onOpen: Open;
  onEdit: (id: string, key: string) => void;
  onMenu: (e: MouseEvent, page: Page) => void;
  onAdd: (button: HTMLElement) => void;
}) {
  const component = () => p.page.interface !== null;
  // a row of a page not open opens it with that row picked
  const pick: Pick = (id, add) => (p.open ? p.onPick(id, add) : p.onOpen(p.page.id, id));
  return (
    <div class="page-group" classList={{ open: p.open }}>
      <TreeRow
        depth={p.depth}
        class="page-row"
        classList={{ selected: p.open && p.selected.length === 0, open: p.open }}
        data-page={p.page.id}
        open={p.page.children.length > 0 ? !p.shut(p.page.id) : undefined}
        onFold={() => p.onFold(p.page.id)}
        onClick={() => {
          if (justDragged()) return;
          p.onOpen(p.page.id);
          flyTo(p.page.id);
          closeDrawer();
        }}
        onPointerDown={(e) =>
          dragToFolder(e, {
            kind: component() ? "components" : "pages",
            name: p.page.id,
            label: p.page.name,
            // a component goes onto the page it lands on, so a phone's drawer gets out of its way
            elsewhere: component() ? (x, y) => placeComponent(p.page, x, y) : undefined,
            onStart: component() ? closeDrawer : undefined,
          })
        }
        onContextMenu={(e) => p.onMenu(e, p.page)}
        icon={
          <Show when={component()} fallback={<File size={13} />}>
            <Component size={13} />
          </Show>
        }
        label={p.page.name}
        preview={() => <PagePicture page={p.page} />}
        end={
          <>
            <Show when={p.start}>
              <span class="tag" title="Operators' screens open on this page">
                start
              </span>
            </Show>
            <span class="marks">
              <Show when={p.page.state.length > 0}>
                <Kept state={p.page.state} />
              </Show>
            </span>
            <Show when={p.open}>
              <button class="row-add" title="Add an element" onClick={(e) => (e.stopPropagation(), p.onAdd(e.currentTarget))}>
                <Plus size={15} />
              </button>
            </Show>
          </>
        }
      />
      <Show when={p.page.children.length > 0 && !p.shut(p.page.id)}>
        <LayerList
          page={p.page}
          depth={p.depth + 1}
          selected={p.open ? p.selected : []}
          shut={(id) => p.shut(`${p.page.id} ${id}`)}
          onFold={(id) => p.onFold(`${p.page.id} ${id}`)}
          onPick={pick}
          onEdit={(id, key) => {
            if (!p.open) p.onOpen(p.page.id, id);
            p.onEdit(id, key);
          }}
        />
      </Show>
    </div>
  );
}

/** Where dragged layers would land: `index` of `parent`, counted without them. A line between
 *  rows shows the place, indented to its depth, or a frame they go into lights up. */
type Spot = { parent: string | null; index: number; line?: { y: number; depth: number }; into?: string };

/** A page's layers, front first as they stack. Rows dragged onto another's edge go in front of
 *  or behind it, onto a frame's middle into that frame, and below them all to the page's back.
 *  A selected row takes the rest of the selection with it. */
function LayerList(p: { page: Page; depth: number; selected: string[]; shut: (id: string) => boolean; onFold: (id: string) => void; onPick: Pick; onEdit: (id: string, key: string) => void }) {
  let host!: HTMLDivElement;
  let press: { id: string; y: number } | null = null;
  const [dragging, setDragging] = createSignal<string[]>([]);
  const [spot, setSpot] = createSignal<Spot | null>(null);

  const spotAt = (y: number, ids: string[]): Spot | null => {
    const rows = [...host.querySelectorAll<HTMLElement>(".list-row[data-id]")].map((row) => ({ id: row.dataset.id!, open: row.dataset.open !== undefined, r: row.getBoundingClientRect() }));
    const top = host.getBoundingClientRect().top;
    // only where all that is dragged may go: shapes in diagrams, the rest in frames
    const moved = ids.map((id) => find(p.page.children, id)).filter((e): e is Element => !!e);
    const fits = (holder: string | null) => moved.every((e) => holds(p.page, holder ? (find(p.page.children, holder)?.tag ?? null) : null, e));
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
    if (ids.length === 0 || !s) return;
    moveAll(p.page, ids, s.parent, s.index);
    // a frame they go into opens, so they stay in sight
    if (s.into && p.shut(s.into)) p.onFold(s.into);
  };

  return (
    <div class="layer-list" ref={host} onPointerDown={down}>
      <Layers
        elements={p.page.children}
        depth={p.depth}
        selected={p.selected}
        dragging={dragging()}
        spot={spot()}
        shut={p.shut}
        onFold={p.onFold}
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
      <Show when={spot()?.line}>{(l) => <div class="drop-line" style={{ top: `${l().y}px`, left: `${8 + (p.depth + l().depth) * INDENT}px` }} />}</Show>
    </div>
  );
}

/** What a layer's row marks of it: that it repeats, and that it has handlers, the events named
 *  in its title. */
/** How much a page or an element keeps, its names in its title. */
function Kept(p: { state: Variable[] }) {
  return (
    <span class="mark mark-state" title={`Keeps ${p.state.map((v) => v.name).join(", ")}`}>
      <CircleDot size={10} />
      {p.state.length}
    </span>
  );
}

/** What a layer handles, what it repeats over and how much it keeps, at the row's end. */
function Marks(p: { element: Element }) {
  const events = () => [...new Set(p.element.handlers.map((h) => h.event))];
  return (
    <span class="marks">
      <Show when={events().length > 0}>
        <span class="mark" title={`On ${events().join(", ")}`}>
          <Zap size={11} />
        </span>
      </Show>
      <Show when={p.element.props.repeat?.trim()}>
        {(over) => (
          <span class="mark mark-repeat" title={`Repeats over ${over()}`}>
            <Repeat size={10} />
            <Show when={isNumber(over())}>{over().trim()}</Show>
          </span>
        )}
      </Show>
      <Show when={p.element.state.length > 0}>
        <Kept state={p.element.state} />
      </Show>
    </span>
  );
}

function Layers(p: {
  elements: Element[];
  depth: number;
  selected: string[];
  dragging: string[];
  spot: Spot | null;
  /** Whether a frame is folded, its parts hidden. */
  shut: (id: string) => boolean;
  onFold: (id: string) => void;
  onPick: Pick;
  onEdit: (id: string, key: string) => void;
  onMenu: (e: MouseEvent, id: string) => void;
}) {
  return (
    <For each={[...p.elements].reverse()}>
      {(e) => (
        <>
          <TreeRow
            depth={p.depth}
            classList={{ selected: p.selected.includes(e.id), dragged: p.dragging.includes(e.id), "drop-inside": p.spot?.into === e.id }}
            data-id={e.id}
            data-frame={isHolder(e.tag) ? "" : undefined}
            data-open={e.children.length > 0 && !p.shut(e.id) ? "" : undefined}
            open={e.children.length > 0 ? !p.shut(e.id) : undefined}
            onFold={() => p.onFold(e.id)}
            onClick={(ev) => p.onPick(e.id, ev.shiftKey || ev.ctrlKey || ev.metaKey)}
            onDblClick={() => p.onEdit(e.id, "name")}
            onContextMenu={(ev) => p.onMenu(ev, e.id)}
            icon={<TagIcon tag={e.tag} size={13} />}
            label={e.props.name ?? e.id}
            end={<Marks element={e} />}
          />
          <Show when={e.children.length > 0 && !p.shut(e.id)}>
            <Layers elements={e.children} depth={p.depth + 1} selected={p.selected} dragging={p.dragging} spot={p.spot} shut={p.shut} onFold={p.onFold} onPick={p.onPick} onEdit={p.onEdit} onMenu={p.onMenu} />
          </Show>
        </>
      )}
    </For>
  );
}
