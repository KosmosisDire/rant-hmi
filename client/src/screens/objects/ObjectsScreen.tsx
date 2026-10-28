// The Objects tab: the objects and the theme over the mesh on the left, the open one's sheet in
// the middle, and on the right what is picked of it.

import { batch, createEffect, createSignal, For, type JSX, on, onMount, Show } from "solid-js";
import { send } from "../../net/connection";
import type { EntityInfo } from "../../protocol/EntityInfo";
import { freeMember, freeName, HMI, importOf, key, named, object } from "../../state/names";
import { notify, setState, split, state } from "../../state/store";
import { usedBy } from "../../state/usage";
import { Copy, Monitor, Palette, Plus, Trash } from "../../ui/icons";
import { ObjectIcon } from "../../ui/marks";
import { fold, FoldHead } from "../../ui/Fold";
import { copyText, openMenu } from "../../ui/Menu";
import { closeDrawer, Edge, reveal, Sidebar } from "../../ui/Sidebars";
import { onResize } from "../../ui/size";
import { Inspector } from "./Inspector";
import { MeshTree } from "./MeshTree";
import { Sheet } from "./Sheet";
import { ThemeSheet } from "./Theme";

/** What the inspector shows of the open sheet: the object itself, one of its members by name,
 *  one of its logic's rules, an entity on the mesh, or a token of the theme. */
export type Pick = { kind: "object" } | { kind: "member"; name: string } | { kind: "rule"; id: string } | { kind: "entity"; name: string } | { kind: "token"; name: string };

export interface Picking {
  /** The object whose sheet shows, null while the theme's does. */
  open: string | null;
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
 *  before it when that is taken. */
function suggest(object: string, entity: string): string {
  const parts = entity.split("/").filter(Boolean);
  const last = pascal(parts.at(-1) ?? "Member");
  const taken = !!named(key(object, last));
  return freeMember(object, taken && parts.length > 1 ? pascal(parts.at(-2)!) + last : last);
}

/** An entity's path as a member of `object` writes it: from the object's mesh root, else from
 *  the mesh's own with a leading slash. */
function relative(object: string, entity: string): string {
  const root = state.objects.find((o) => o.name === object)?.mesh ?? "";
  if (!root) return entity;
  return entity.startsWith(`${root}/`) ? entity.slice(root.length + 1) : `/${entity}`;
}

/** Whether the objects and the mesh, which share the sidebar, each show, as this browser
 *  remembers it. */
const folds = { objects: fold("pane-objects"), mesh: fold("pane-mesh") };
const shown = (part: keyof typeof folds) => folds[part][0]() === "open";

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
  const [fresh, setFresh] = createSignal<{ id: string; n: number } | null>(null);
  const picking: Picking = {
    get open() {
      return open();
    },
    get picked() {
      return picked();
    },
    onOpen: (o, pick) => {
      batch(() => {
        setFresh(null);
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
        if (open() === r.object && now.kind === "member" && now.name === r.to && !named(key(r.object, r.to))) setPicked({ kind: "member", name: r.from });
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
    send({ type: "import", object: o, import: { alias, entity: relative(o, e.name), kind: e.kind, intent: "read" } });
    picking.onPick({ kind: "entity", name: e.name });
  };
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
    if (places.length > 0) return notify(`${places.length === 1 ? "1 place names" : `${places.length} places name`} ${name}. Change those first.`, "fault");
    send({ type: "set_object", name, object: null });
    if (chosen() === name) setChosen(undefined);
  };
  const menu = (e: MouseEvent, name: string) =>
    openMenu(e, [
      { label: "Copy the name", icon: <Copy size={13} />, run: () => copyText(name) },
      ...(name === HMI ? [] : ["-" as const, { label: "Remove", icon: <Trash size={13} />, run: () => remove(name) }]),
    ]);
  const count = (name: string) => {
    const o = object(name);
    return o ? o.imports.length + o.variables.length + o.computed.length + o.records.length + o.functions.length + o.logic.length : 0;
  };

  const Row = (r: { name: string; icon: JSX.Element }) => (
    <button class="list-row" data-object={r.name} classList={{ selected: open() === r.name }} onClick={() => picking.onOpen(r.name)} onContextMenu={(e) => menu(e, r.name)}>
      {r.icon}
      <span class="list-label mono">{r.name}</span>
      <span class="list-trail">{count(r.name)}</span>
    </button>
  );

  return (
    <>
      <Sidebar side="left">
        <FoldHead title="Objects" fold={folds.objects}>
          <button class="icon-btn" title="Add an object" onClick={() => make("NewObject", "")}>
            <Plus size={14} />
          </button>
        </FoldHead>
        <div class="objects-list" classList={{ tall: !shown("mesh") }} hidden={!shown("objects")}>
          <Row
            name={HMI}
            icon={
              <span class="kind kind-local" title="the HMI's own object">
                <Monitor size={14} />
              </span>
            }
          />
          <button class="list-row" data-object="" classList={{ selected: open() === null }} onClick={() => picking.onOpen(null)}>
            <span class="kind kind-local" title="theme">
              <Palette size={14} />
            </span>
            <span class="list-label">Theme</span>
            <span class="list-trail">{state.tokens.length}</span>
          </button>
          <div class="list-sep" />
          <For each={state.objects.filter((o) => o.name !== HMI)}>{(o) => <Row name={o.name} icon={<ObjectIcon />} />}</For>
        </div>
        <FoldHead title="Mesh" fold={folds.mesh} below />
        <div class="mesh-part" hidden={!shown("mesh")}>
          <MeshTree picking={picking} onAdd={add} onMake={(path) => make(pascal(path.split("/").at(-1) ?? "Object"), path)} />
        </div>
        <div class="pane-foot">
          <span class="section" style={{ margin: 0 }}>
            {state.entities.length === 1 ? "1 entity" : `${state.entities.length} entities`}
          </span>
        </div>
      </Sidebar>
      <Edge side="left" />
      <section class="detail objects-detail" ref={detail}>
        <Show when={open() !== null} fallback={<ThemeSheet picking={picking} />}>
          <Show when={object(open()!)}>{(o) => <Sheet object={o()} picking={picking} />}</Show>
        </Show>
      </section>
      <Edge side="right" />
      <Sidebar side="right">
        <Inspector picking={picking} onAdd={add} onRemove={remove} adding={adding()} />
      </Sidebar>
    </>
  );
}
