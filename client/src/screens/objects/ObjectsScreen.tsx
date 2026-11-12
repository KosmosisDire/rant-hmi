// The Objects tab: the objects and the theme over the mesh on the left, the open one's sheet in
// the middle, and on the right what is picked of it.

import { batch, createEffect, createSignal, For, type JSX, on, onMount, Show, untrack } from "solid-js";
import { standardType } from "../../lang/math.js";
import { send } from "../../net/connection";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { freeName, HMI, importOf, key, named, object, pathOf } from "../../state/names";
import { notify, page as pageOf, setState, split, state } from "../../state/store";
import { usedBy } from "../../state/usage";
import { objectsWanted, tookObjectsWanted } from "../../state/view";
import { AppWindow, ChartSpline, CircleDot, Copy, File, Monitor, Palette, Parentheses, Plus, Sigma, Trash, Zap } from "../../ui/icons";
import { dragToFolder, FolderTree, justDragged, moveRow, TreeRow } from "../../ui/Tree";
import { PagePicture } from "../design/PagePicture";
import { KindIcon, ObjectIcon } from "../../ui/marks";
import { copyText, openMenu } from "../../ui/Menu";
import { closeDrawer, Edge, reveal, Sidebar } from "../../ui/Sidebars";
import { onResize } from "../../ui/size";
import { Inspector } from "./Inspector";
import { PageSheet, stateCount } from "./PageSheet";
import type { Element } from "../../protocol/Element";
import type { Kind } from "../../protocol/Kind";
import type { Object as Thing } from "../../protocol/Object";
import type { Page } from "../../protocol/Page";
import { Sheet } from "./Sheet";
import { ThemeSheet } from "./Theme";

/** What the inspector shows of the open sheet: the object itself, one of its members by name,
 *  one of its logic's rules, an entity on the mesh, a token of the theme, or a page's state by
 *  the element keeping it, none for the page's own. */
export type Pick =
  | { kind: "object" }
  | { kind: "member"; name: string }
  | { kind: "rule"; id: string }
  | { kind: "entity"; name: string }
  | { kind: "token"; name: string }
  | { kind: "state"; holder: string | null; name: string };

export interface Picking {
  /** The object whose sheet shows, null while the theme's does. */
  open: string | null;
  /** The page whose sheet shows in place of any object's, if one does. */
  page: string | null;
  /** Shows a page's sheet. */
  onOpenPage: (page: string) => void;
  picked: Pick;
  /** Shows the sheet of an object, or the theme's for null, with `pick` picked, else itself. */
  onOpen: (object: string | null, pick?: Pick) => void;
  onPick: (pick: Pick) => void;
  /** Moves the pick with a member renamed from `from` to `to`, and back if that is refused. */
  onRename: (from: string, to: string) => void;
  /** Opens a page in the Design tab. */
  onPage: (page: string) => void;
  /** Marks what was just added, by an id its inspector knows it by, to type its name. */
  added: (id: string) => void;
  /** A new number while the inspector of what `id` names should put the caret in its name. */
  focus: (id: string) => number | undefined;
}

const pascal = (s: string) => {
  const clean = s.replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z]/.test(clean) ? clean.charAt(0).toUpperCase() + clean.slice(1) : `E${clean}`;
};

/** The name an entity gets as a member of `object`: its last step in PascalCase, with the one
 *  before it when that is taken or is a standard type's name. */
function suggest(object: string, entity: string): string {
  const parts = entity.split("/").filter(Boolean);
  const last = pascal(parts.at(-1) ?? "Member");
  const clash = (n: string) => !!named(key(object, n)) || standardType(n) !== undefined;
  return freeName(clash(last) && parts.length > 1 ? pascal(parts.at(-2)!) + last : last, clash);
}



/** The kinds of mesh member, in the order an object's row marks them. */
const KINDS: Kind[] = ["topic", "variable", "function", "task"];

/** Small marks for each kind of thing an object or a page defines, in a row's trail. */
function Defines(p: { marks: [boolean, JSX.Element, string][] }) {
  return (
    <span class="list-trail defines">
      <For each={p.marks.filter(([has]) => has)}>{([, icon, title]) => <span title={title}>{icon}</span>}</For>
    </span>
  );
}

/** What an object defines: its mesh members by kind, then its own state, computed values,
 *  records, functions and logic. */
const objectMarks = (o: Thing): [boolean, JSX.Element, string][] => [
  ...KINDS.map((k): [boolean, JSX.Element, string] => [o.imports.some((i) => i.kind === k), <KindIcon kind={k} size={11} />, `mesh ${k}s`]),
  [o.variables.length > 0, <span class="kind kind-local"><CircleDot size={11} /></span>, "state"],
  [o.computed.length > 0, <span class="kind kind-local"><Sigma size={11} /></span>, "computed values"],
  [o.records.length > 0, <span class="kind kind-local"><ChartSpline size={11} /></span>, "records"],
  [o.functions.length > 0, <span class="kind kind-local"><Parentheses size={11} /></span>, "functions"],
  [o.logic.length > 0, <span class="kind kind-local"><Zap size={11} /></span>, "logic"],
];

/** What a page defines: state, its own or its elements', and views showing other pages. */
const pageMarks = (pg: Page): [boolean, JSX.Element, string][] => [
  [stateCount(pg) > 0, <span class="kind kind-local"><CircleDot size={11} /></span>, "state"],
  [keepsViews(pg.children), <span class="kind kind-local"><AppWindow size={11} /></span>, "views"],
];

/** Whether any of `elements`, or what they hold, is a view. */
const keepsViews = (elements: Element[]): boolean => elements.some((e) => e.tag === "view" || keepsViews(e.children));



/** The member just asked for from the mesh, by its key, whose refusal shows beside its entity. */
const [adding, setAdding] = createSignal("");

export function ObjectsScreen(p: { onPage: (page: string) => void }) {
  // the object picked, kept while it lives or was just asked for, else the first of the user's
  const [chosen, setChosen] = createSignal<string | null>();
  const [asked, setAsked] = createSignal("");
  const open = () => {
    const c = chosen();
    if (c === null || (c !== undefined && (object(c) || c === asked()))) return c;
    return state.objects.find((o) => o.name !== HMI)?.name ?? HMI;
  };
  const [picked, setPicked] = createSignal<Pick>({ kind: "object" });
  const [pageOpen, setPageOpen] = createSignal<string | null>(null);
  const [fresh, setFresh] = createSignal<{ id: string; n: number } | null>(null);
  const picking: Picking = {
    get open() {
      return open();
    },
    get picked() {
      return picked();
    },
    get page() {
      const id = pageOpen();
      return id && pageOf(id) ? id : null;
    },
    onOpenPage: (id) => {
      batch(() => {
        setFresh(null);
        setPageOpen(id);
        setPicked({ kind: "object" });
      });
      closeDrawer();
    },
    onOpen: (o, pick) => {
      batch(() => {
        setFresh(null);
        setPageOpen(null);
        setChosen(o);
        setPicked(pick ?? { kind: "object" });
      });
      closeDrawer();
      if (pick) reveal();
    },
    onPick: (pick) => {
      batch(() => {
        setFresh(null);
        setPicked(pick);
      });
      reveal();
    },
    onRename: (from, to) => {
      const o = open();
      if (o === null) return;
      batch(() => {
        setRenamed({ object: o, from, to });
        setPicked({ kind: "member", name: to });
      });
    },
    onPage: (page) => p.onPage(page),
    added: (id) => setFresh({ id, n: (fresh()?.n ?? 0) + 1 }),
    focus: (id) => (fresh()?.id === id ? fresh()!.n : undefined),
  };

  // a rename shows at once, and the objects as they stand come back before its refusal, so a
  // refused one takes the pick back to the name it kept
  const [renamed, setRenamed] = createSignal<{ object: string; from: string; to: string } | null>(null);
  createEffect(
    on(
      () => state.refused,
      (refused) => {
        const r = renamed();
        if (!refused || !r) return;
        setRenamed(null);
        const now = picked();
        if (open() === r.object && now.kind === "member" && now.name === r.to && named(key(r.object, r.from))) setPicked({ kind: "member", name: r.from });
      },
      { defer: true },
    ),
  );

  let detail!: HTMLElement;
  // a picked row is kept in sight, on a phone above the sheet as that rises and measures
  const keep = () => detail.querySelector(".member-row.selected")?.scrollIntoView({ block: "nearest" });
  createEffect(on([open, picked], () => requestAnimationFrame(keep), { defer: true }));
  onMount(() => onResize(detail, keep));

  /** Adds an object, its sheet open and its name ready to type. */
  const make = (base: string, mesh: string) => {
    const name = freeName(base, (n) => !!object(n));
    setState("refused", null);
    send({ type: "set_object", name: "", object: { name, mesh } });
    setAsked(name);
    picking.onOpen(name);
    picking.added(`object:${name}`);
  };

  /** Makes an entity a member of the open object, picked once it comes. */
  const add = (e: EntityInfo) => {
    const o = open();
    if (o === null) return;
    const alias = suggest(o, e.name);
    setState("refused", null);
    setAdding(key(o, alias));
    send({ type: "import", object: o, import: { alias, entity: pathOf(object(o)!, e.name), kind: e.kind, intent: "read" } });
    picking.onPick({ kind: "entity", name: e.name });
  };
  // what another tab asks to show here, as a name's definition
  createEffect(() => {
    const w = objectsWanted();
    if (!w) return;
    untrack(() => {
      if ("page" in w) {
        picking.onOpenPage(w.page);
        picking.onPick({ kind: "state", holder: w.holder, name: w.state });
      } else if ("token" in w) picking.onOpen(null, { kind: "token", name: w.token });
      else picking.onOpen(w.object, w.member ? { kind: "member", name: w.member } : undefined);
      tookObjectsWanted();
    });
  });

  // an entity picked that becomes a member shows as that member
  createEffect(() => {
    const s = picked();
    const i = s.kind === "entity" ? importOf(s.name) : undefined;
    if (!i) return;
    const [o, name] = split(i.alias);
    picking.onOpen(o, { kind: "member", name });
  });

  const remove = (name: string) => {
    const places = usedBy(name).filter((at) => at.object !== name);
    if (places.length > 0) notify(`${places.length === 1 ? "1 place still names" : `${places.length} places still name`} ${name}`, "warn");
    send({ type: "set_object", name, object: null });
    if (chosen() === name) setChosen(undefined);
  };
  const menu = (e: MouseEvent, name: string) =>
    openMenu(e, [
      { label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(name) },
      ...(name === HMI ? [] : [moveRow("objects", name, object(name)?.folder ?? "", state.folders.objects), "-" as const, { label: "Remove", icon: <Trash size={13} />, run: () => remove(name) }]),
    ]);

  const Row = (r: { name: string; icon: JSX.Element; depth: number }) => (
    <TreeRow
      depth={r.depth}
      data-object={r.name}
      classList={{ selected: !picking.page && open() === r.name }}
      onClick={() => !justDragged() && picking.onOpen(r.name)}
      onPointerDown={(e) => r.name !== HMI && dragToFolder(e, { kind: "objects", name: r.name, label: r.name })}
      onContextMenu={(e) => menu(e, r.name)}
      icon={r.icon}
      label={<span class="mono">{r.name}</span>}
      end={<Show when={object(r.name)}>{(o) => <Defines marks={objectMarks(o())} />}</Show>}
    />
  );
  const pageMenu = (e: MouseEvent, pg: Page) => openMenu(e, [{ label: "Open in Design", icon: <File size={13} />, run: () => picking.onPage(pg.id) }, moveRow("pages", pg.id, pg.folder, state.folders.pages)]);

  return (
    <>
      <Sidebar side="left">
        <div class="objects-list">
          <Row
            name={HMI}
            depth={0}
            icon={
              <span class="kind kind-local" title="the HMI's own object">
                <Monitor size={14} />
              </span>
            }
          />
          <TreeRow
            depth={0}
            data-object=""
            classList={{ selected: !picking.page && open() === null }}
            onClick={() => picking.onOpen(null)}
            icon={
              <span class="kind kind-local" title="theme">
                <Palette size={14} />
              </span>
            }
            label="Theme"
          />
          <FolderTree
            kind="objects"
            title="Objects"
            folders={state.folders.objects}
            items={state.objects.filter((o) => o.name !== HMI)}
            folderOf={(o) => o.folder}
            row={(o, depth) => <Row name={o.name} icon={<ObjectIcon />} depth={depth} />}
            end={
              <button
                class="row-add"
                title="Add an object"
                onClick={(e) => {
                  e.stopPropagation();
                  make("NewObject", "");
                }}
              >
                <Plus size={15} />
              </button>
            }
          />
          <FolderTree
            kind="pages"
            title="Pages"
            folders={state.folders.pages}
            items={state.pages.filter((pg) => pg.interface === null)}
            folderOf={(pg) => pg.folder}
            row={(pg, depth) => (
              <TreeRow
                depth={depth}
                data-page={pg.id}
                classList={{ selected: picking.page === pg.id }}
                onClick={() => !justDragged() && picking.onOpenPage(pg.id)}
                onPointerDown={(e) => dragToFolder(e, { kind: "pages", name: pg.id, label: pg.name })}
                onContextMenu={(e) => pageMenu(e, pg)}
                icon={<File size={14} />}
                label={pg.name}
                end={<Defines marks={pageMarks(pg)} />}
                preview={() => <PagePicture page={pg} />}
              />
            )}
          />
        </div>
        <div class="pane-foot">
          <span class="section" style={{ margin: 0 }}>
            {state.entities.length === 1 ? "1 entity" : `${state.entities.length} entities`}
          </span>
        </div>
      </Sidebar>
      <Edge side="left" />
      <section class="detail objects-detail" ref={detail}>
        <Show
          when={picking.page ? pageOf(picking.page) : undefined}
          fallback={
            <Show when={open() !== null} fallback={<ThemeSheet picking={picking} />}>
              <Show when={object(open()!)}>{(o) => <Sheet object={o()} picking={picking} onAdd={add} />}</Show>
            </Show>
          }
        >
          {(pg) => <PageSheet page={pg()} picking={picking} />}
        </Show>
      </section>
      <Edge side="right" />
      <Sidebar side="right">
        <Inspector picking={picking} onAdd={add} onRemove={remove} adding={adding()} />
      </Sidebar>
    </>
  );
}
