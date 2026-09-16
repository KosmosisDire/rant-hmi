/* What the sidebars need from the shell, plus the two things every panel shares: the fold
 * state (per view, never synced) and the section header.
 *
 * There is no separate "live" update path any more. A live frame and a document echo are
 * the same event to a sidebar: the shape is unchanged, so every binding re-reads and assigns.
 * One reconciliation path with two triggers (reconcile.ts). */

import { DropPlan } from "./arrange.js";
import { DocStore } from "./doc.js";
import { el } from "./dom.js";
import { makeFolds } from "./fold.js";
import { iconMarkup } from "./icons.js";
import { placeBox } from "./popover.js";
import { AggFrame, AttrTable, BuiltinDef, Diag, Json, Lang, Live, Mesh, Node, NodeAttrs, Op, Page, Registry, RepeatCopy } from "./types.js";

export type Mode = "edit" | "test" | "operate";

/* What the view is currently SHOWING, as opposed to what the document says: none of it is
 * synced and none of it survives a reload. It used to live in canvas.ts, next to the
 * renderer that read it; with the artboard's own coordinate space gone, so are the fields
 * that only made sense inside one (`scale` in px-per-canvas-unit, and the `ghost` rect a
 * drag painted). What is left is selection and presentation. */
export interface ViewState {
  mode: Mode;
  selection: number[];
  hover: number;
  /* per-SEAT interaction state, the "state:" half of the cell space an attr program
     reads (state.pressed / dragging / open / hover): view-local, written by the gesture
     primitives (gestures.ts) outside edit mode, never synced — a pressed LOOK is this
     view's own; the pressed CONSEQUENCE comes back as a live cell like any other.
     A seat is the channel, plus `@<index>` where the element is one copy of a `repeat`:
     the copies of a repeated control are as separate as two controls are, and the whole
     of an instance's anatomy shares one seat because it is one control seen twice. */
  state: Record<string, Record<string, Json>>;
  faults: Record<number, string>;               /* worst compile grade, per instance */
  /* which side of every theme token this view paints: a local preview
     preference, persisted per browser, never synced */
  themeMode?: "dark" | "light";
}

/* The UNKNOWN mark: what every reader shows where a value could not be known. Never a
 * fabricated number, and never blank — blank reads as "empty", which is a different claim. */
export const UNKNOWN_TEXT = "--";

/* ONE ENTERED COMPONENT: the editor is inside a component's own context, editing the
 * component itself (every instance follows). A stack of these is the breadcrumb — a
 * component whose internals hold another instance can be entered again.
 *
 * `component` is the doc component's id; 0 means an UNFORKED BUILT-IN is being looked at
 * (named by `builtin`), whose nodes carry no document ids — which is exactly what makes
 * that context read-only until Override copies it into the document.
 *
 * `from` is the instance the author entered THROUGH. It is the context's data owner —
 * the preview reads that instance's live cells and slot values, so the component is
 * edited while behaving as that placement does — and its rendered box seeds `w`/`h`.
 *
 * `w`/`h` are the PREVIEW size in artboard px: session-local, resized freely to try the
 * component at other sizes, never written anywhere. `w0`/`h0` remember the seed. */
export interface StageContext {
  component: number;
  builtin: string;
  from: number;
  w: number;
  h: number;
  w0: number;
  h0: number;
}

/* ---- the standing aggregate cells ----
 *
 * One standing copy per list/map cell, folded from the `aggs` lane the wire carries
 * (types.ts, AggFrame). The shell owns the store; a `slot:` read serves from it before
 * anything else (stage.ts), and the inspector's variable rows read the same copies.
 *
 * ERASE AND REBASELINE, never bridge a hole. A list frame's `from` says which absolute
 * element it starts at on the cell's ever-appended cursor: exactly at ours and it
 * appends, anywhere else -- or a `gen` this copy has not seen, which is a whole-store, a
 * clear or a recompile -- and the local copy is thrown away and the frame becomes the
 * whole of it. Bridging a gap with increments would show a list that never existed. */
export interface AggEntry {
  /* the backend's generation for this cell: a frame with a different one REPLACES */
  gen: number;
  /* lists: the absolute index one PAST the last element held -- what a frame's `from`
     must equal for it to be the continuation of this copy. Maps have no cursor. */
  end: number;
  /* the elements (a list), the sorted object (a map), or null while the cell is Nil */
  values: Json[] | Record<string, Json> | null;
  /* a mutation counter, so a reader can tell "this moved" from "this is the same list"
     without comparing thousands of elements */
  version: number;
}

/* is this entry readable at all? A frame the view cannot read says nothing about what
   the cell holds, so it is dropped rather than allowed to erase good elements */
function readableAgg(frame: Json): frame is AggFrame {
  if (!frame || typeof frame !== "object" || !Number.isFinite(frame.gen)) return false;
  if (frame.nil === true) return true;
  if (frame.map === true)
    return !!frame.values && typeof frame.values === "object" && !Array.isArray(frame.values);
  return Array.isArray(frame.values) &&
         Number.isInteger(frame.from) && frame.from >= 0 &&
         Number.isInteger(frame.len) && frame.len >= 0;
}

/* fold one frame's aggregate entries into the standing copies: a live frame's deltas,
   or a snapshot's full blocks after the store has been cleared */
export function foldAggs(store: Map<string, AggEntry>, aggs: Live["aggs"]): void {
  for (const [key, frame] of Object.entries(aggs ?? {})) {
    if (!readableAgg(frame)) continue;
    const held = store.get(key);
    const entry: AggEntry = held ?? { gen: frame.gen, end: 0, values: null, version: 0 };
    if (frame.nil === true) {
      entry.values = null;
      entry.end = 0;
    } else if (frame.map === true) {
      /* a map rides whole on any change; there is nothing to append */
      entry.values = frame.values as Record<string, Json>;
      entry.end = 0;
    } else {
      const values = frame.values as Json[];
      const from = frame.from as number;
      const len = frame.len as number;
      const continues = Array.isArray(entry.values) &&
                        entry.gen === frame.gen && entry.end === from;
      if (continues) for (const value of values) (entry.values as Json[]).push(value);
      /* not a continuation: the frame's own elements are the whole of what is known --
         a hole's missing elements are behind us and age out, never invented */
      else entry.values = values.slice();
      entry.end = from + values.length;
      /* the front falls off to what the backend holds: `len` is the count after its
         own keep-trim, and the absolute cursor is unaffected by what drops */
      const over = (entry.values as Json[]).length - len;
      if (over > 0) (entry.values as Json[]).splice(0, over);
    }
    entry.gen = frame.gen;
    entry.version++;
    store.set(key, entry);
  }
}

export interface Editor {
  store: DocStore;
  registry: Registry | null;
  live: Live | null;
  /* the reflected mesh (the "rant" root of the source picker); empty when offline */
  mesh: Mesh;
  /* the served expression vocabulary (builtins + shape-scoped methods) */
  lang: Lang | null;
  /* the closed attr vocabulary: common attrs plus each element kind's own,
     with the renderer's own defaults — what the element inspector's Attrs section lists
     in full, set or not. Snapshot-only, like `lang` and `builtins`. */
  attrTable: AttrTable | null;
  /* every PAGE node's compiled attrs, keyed by node id. The document says what the tree
     IS; this says what each node's fields evaluate to, and the renderer needs both. */
  nodeAttrs: Record<string, NodeAttrs>;
  /* the built-in components' editable document form (no ids): what the Components
     tree browses and what a fork copies into doc.components */
  builtins: BuiltinDef[];
  /* the component-edit selection, SEPARATE from the instance selection (the two are
     mutually exclusive): `node` is the component id itself, or an element node id in it */
  componentSel: { component: number; node: number } | null;
  /* the built-in being BROWSED. A built-in is not in the document and carries no ids,
     so it cannot be addressed the way componentSel addresses an editable one: it is
     named, plus a CHILD-INDEX PATH into its elements ("" = the component itself, "0" =
     its root element, "0.1" = that element's second child). Index rather than name
     because this addresses the definition's own tree, where an unnamed node is still a
     node — unlike an element path, which addresses only what a property can hang off.
     Read-only, and mutually exclusive with both other selections. */
  builtinSel: { name: string; path: string } | null;
  view: ViewState;
  /* the entered-component stack, outermost first; empty = editing the page itself */
  contexts: StageContext[];
  /* one aggregate cell's standing copy, or null where nothing has arrived for it. The
     frames are deltas, so this -- not `live` -- is where a list or a map is read from. */
  agg(key: string): AggEntry | null;
  page(): Page | null;
  /* THE EDITING ROOT the stage, the Layers tree and every structural verb operate on:
     the current page, or — inside a context — the component shaped as one (a
     ComponentDef is {id, name, children} too). Null while looking at an unforked
     built-in, whose nodes are nobody's to edit. */
  root(): Page | null;
  /* the artboard's current dimensions in artboard px: the fixed canvas on a page, the
     preview size inside a context. Gestures divide the screen by this. */
  artboard(): { w: number; h: number };
  /* ENTER A COMPONENT: push the instance's component onto the context stack */
  enterComponent(id: number): void;
  /* step out to `depth` contexts (0 = the page), selecting the instance stepped out of */
  exitTo(depth: number): void;
  /* resize the current context's preview box: session-local, never written */
  resizePreview(w: number, h: number): void;
  /* WHATEVER IS SELECTED: one kind of node, so one accessor. From its Layers row, or from
     its own pixels on the stage — for a frame, the padding, gaps and empty room its
     children do not cover. */
  selectedNode(): Node | null;
  /* the same node, but only when it is an INSTANCE (a frame naming a component): the
     inspector's data/behavior/appearance sections are about the component's slots, so
     they ask this rather than testing a kind themselves */
  selectedInstance(): Node | null;
  apply(ops: Op[]): void;
  /* post one gesture event (sequenced per session): the view reports what the pointer
     did — the canonical gesture name, its fixed payload (nothing for a moment like
     tap), WHICH ELEMENT raised it, and WHICH COPY of a `repeat` it was on — and the
     backend runs every flow it reaches, identically for every view, which is the
     product's own rule. The copy is null outside a repeat, and the whole reason it
     travels: the backend draws no pictures, so the copy exists only on the event. */
  input(node: number, event: string, value?: Json, element?: string,
        repeat?: RepeatCopy | null): void;
  setPage(id: number): void;
  /* insert a fresh page and switch to it once the echo issues its id (the topbar page
     selector's "+ New page") */
  addPage(): void;
  /* land the author on a consumer found elsewhere (the Data workspace's where-used):
     switch to the instance's page, select it, and show the content workspace */
  reveal(instance: number): void;
  select(ids: number[]): void;
  /* WHAT THE POINTER IS ON, wherever the pointer is: a Layers row and the node it stands
     for are one thing seen twice, so both surfaces write this and both read it (0 = none).
     It is a highlight, so it costs a ring and a class — never a sidebar rebuild. */
  setHover(id: number): void;
  /* THE DROP PREVIEW, fed by whichever drag is live — the stage's own pointer gestures or
     the Layers tree's row drag. The page renders as if `node` were already at `plan`, so the
     reflow is the preview and there is nothing to keep in step with it. A null plan puts the
     document back on screen (which is also how a cancelled resize drops its inline styles).
     Nothing here reaches the store: a preview is a rendering. */
  previewMove(node: number, plan: DropPlan | null): void;
  /* the verbs of ONE node (an instance's or a frame's), opened at a screen position. The
     stage's right-click and the Layers tree's are the same menu over the same node: the
     tree is the only place a frame can be right-clicked at all, since on the stage its
     own children cover it. */
  openNodeMenu(x: number, y: number, node: number): void;
  /* select a document component (or one element node in it) for editing; clears the
     instance selection, as selecting an instance clears this */
  selectComponent(component: number, node: number): void;
  /* browse a built-in (or one element node inside it, by child-index path): the inspector
     shows the definition READ-ONLY, since nothing in the document owns it until it is
     overridden. This is how the shipped types are read before forking one. */
  selectBuiltin(name: string, path: string): void;
  /* the "Override <Name>" verb: copy a built-in's document form
     into doc.components under its OWN name (ONE insert op; the backend issues ids),
     which shadows it so every existing instance follows the override automatically.
     Select the override once its echo lands. */
  forkBuiltin(name: string): void;
  /* the "Duplicate as…" verb: copy a built-in or an existing doc component under a
     FRESH name, leaving the source and its instances untouched — the verb "fork"
     never was, since forkBuiltin always shadows. Select the copy once its echo lands. */
  duplicateComponent(name: string): void;
  /* insert a minimal fresh component (unique name) and select it */
  addComponent(): void;
  /* the theme preview mode: sets view.themeMode, persists it locally and
     repaints the artboard; the Style workspace's toggle is the only caller for now */
  setThemeMode(mode: "dark" | "light"): void;
  /* what the compiler said about this instance or anything inside it */
  diagFor(instance: number): Diag[];
  /* the findings pinned to one node, or to one field of it. No `where` asks for the node's own findings only. */
  diagAt(node: number, where?: string): Diag[];
  /* every finding about a node, whatever field of it they name. A summary line stands for
     the whole node, so it rolls these up; the form under it pins each one to its row. */
  diagNode(node: number): Diag[];
  /* re-render the sidebars: a fold or a menu changed, not the document */
  refresh(): void;
}

/* The inline finding mark: a small icon on the offending row, its popover on hover. The
 * popover is one shared element on the body, so a sidebar rebuild can never strand it —
 * but a rebuild replacing the hovered icon fires no mouseleave on the detached element,
 * so the popover watches its anchor while shown and leaves the moment the anchor did. */
let pop: HTMLElement | null = null;

function showPop(anchor: HTMLElement, diags: Diag[]): void {
  hidePop();
  pop = el(
    "div",
    { class: "diag-pop" },
    diags.map((row) =>
      el("div", { class: "diag-pop-row " + row.grade }, [
        el("span", { class: "grade", text: row.grade }),
        /* the span rides as data; the pop renders the position the way the old
           messages spelled it */
        el("span", { class: "message",
                     text: row.message +
                           (row.at !== undefined ? ` at column ${row.at + 1}` : "") }),
      ]),
    ),
  );
  document.body.appendChild(pop);
  placeBox(pop, anchor.getBoundingClientRect(), { exact: true, gap: 6 });
  const mine = pop;
  const watch = () => {
    if (pop !== mine) return;
    if (!anchor.isConnected) hidePop();
    else requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

function hidePop(): void {
  pop?.remove();
  pop = null;
}

export function diagIcon(diags: Diag[]): HTMLElement | null {
  if (!diags.length) return null;
  const worst = diags.some((d) => d.grade === "error")
    ? "error"
    : diags.some((d) => d.grade === "warning")
      ? "warning"
      : "info";
  const dot = el("span", {
    class: "icon-btn diag-dot " + worst,
    html: iconMarkup("alert", 16, 2),
  });
  dot.addEventListener("mouseenter", () => showPop(dot, diags));
  dot.addEventListener("mouseleave", hidePop);
  return dot;
}

/* the sections' shared instance of the one fold store (fold.ts): keys survive selection
 * changes, and revision() goes unread because a section never rebuilds */
const folds = makeFolds();

/* the header is the whole row, the caret rotates rather than swapping glyph, and the state
 * is remembered per section key across selection changes. Folding is a pure
 * view act: it toggles one style and never asks for a rebuild. */
export function section(
  key: string,
  title: string,
  badge: string | null,
  body: () => (HTMLElement | null)[],
): HTMLElement[] {
  const open = folds.open(key, true);
  const panel = el(
    "div",
    { class: "section-body" },
    body().filter(Boolean) as HTMLElement[],
  );
  if (!open) panel.style.display = "none";
  const head = el("button", { class: "section-head" }, [
    el("span", { class: "icon-mark caret", html: iconMarkup("chevron-down", 10, 2) }),
    el("span", { class: "section-title", text: title }),
    badge !== null ? el("span", { class: "badge", text: badge }) : null,
    el("span", { class: "rule" }),
  ]);
  if (open) head.classList.add("open");
  head.addEventListener("click", () => {
    const opening = panel.style.display === "none";
    panel.style.display = opening ? "" : "none";
    head.classList.toggle("open", opening);
    folds.set(key, opening);
  });
  return [head, panel];
}

/* a live value, or the UNKNOWN mark: never a fabricated number */
function liveText(live: Live | null, cell: string): string {
  const value = live?.values?.[cell];
  if (value === undefined || value === null) return "--";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "object") {
    /* a timer reads as its time left, derived from the served deadline (the record
       is {running, deadline, duration} now); the card's `on` treatment says running */
    const deadline = (value as Json).deadline;
    if (typeof deadline === "number") {
      const left = (value as Json).running === true
        ? Math.max(0, deadline - Date.now()) / 1000 : 0;
      return String(Math.round(left * 1000) / 1000) + " s";
    }
    return "--";
  }
  return String(value);
}

/* the same, through the standing aggregate copies first: list and map cells ride the
   `aggs` lane, not `values`, and a card's readout wants the shape, not the elements --
   the picture is where a list is LOOKED at, the card only says it is alive */
export function cellText(editor: Editor, cell: string): string {
  const held = editor.agg?.(cell) ?? null;
  if (held) {
    if (held.values === null) return "--";
    if (Array.isArray(held.values)) return held.values.length + " items";
    return Object.keys(held.values).length + " keys";
  }
  return liveText(editor.live, cell);
}

export function liveIsOn(live: Live | null, cell: string): boolean {
  const value = live?.values?.[cell];
  if (value === true) return true;
  return typeof value === "object" && value !== null && (value as Json).running === true;
}
