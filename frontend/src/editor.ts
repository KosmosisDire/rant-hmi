/* What the sidebars need from the shell, plus the two things every panel shares: the fold
 * state (per view, never synced) and the section header.
 *
 * There is no separate "live" update path any more. A live frame and a document echo are
 * the same event to a sidebar: the shape is unchanged, so every binding re-reads and assigns.
 * One reconciliation path with two triggers (reconcile.ts). */

import { DropPlan } from "./arrange.js";
import { DocStore } from "./doc.js";
import { el } from "./dom.js";
import { iconMarkup } from "./icons.js";
import { AttrTable, BuiltinDef, Diag, Frame, Json, Lang, Live, Mesh, Op, Page, Registry, Var, Widget } from "./types.js";

export type Mode = "edit" | "test" | "operate";

/* What the view is currently SHOWING, as opposed to what the document says: none of it is
 * synced and none of it survives a reload. It used to live in canvas.ts, next to the
 * renderer that read it; with the artboard's own coordinate space gone, so are the fields
 * that only made sense inside one (`scale` in px-per-canvas-unit, and the `ghost` rect a
 * drag painted). What is left is selection and presentation. */
export interface ViewState {
  mode: Mode;
  /* the selected PART of the selected widget: a part path into its template, "" = none */
  part: string;
  selection: number[];
  hover: number;
  /* per-widget interaction state, the "state:" half of the cell space an attr program
     reads. Nothing writes it and nothing reads it: the gesture primitives that set it and
     the cell reader that served it are both gone, so it stands empty until the rebuild. */
  state: Record<number, Record<string, Json>>;
  faults: Record<number, string>;               /* worst compile grade, per widget */
  /* which side of every theme token this view paints (spec 2.10): a local preview
     preference, persisted per browser, never synced */
  themeMode?: "dark" | "light";
}

/* The UNKNOWN mark: what every reader shows where a value could not be known. Never a
 * fabricated number, and never blank — blank reads as "empty", which is a different claim. */
export const UNKNOWN_TEXT = "--";

export interface Editor {
  store: DocStore;
  registry: Registry | null;
  live: Live | null;
  /* the reflected mesh (the "dart" root of the source picker); empty when offline */
  mesh: Mesh;
  /* the served expression vocabulary (builtins + shape-scoped methods) */
  lang: Lang | null;
  /* the closed attr vocabulary (spec 2.3): common attrs plus each part kind's own,
     with the renderer's own defaults — what the part inspector's Attrs section lists
     in full, set or not. Snapshot-only, like `lang` and `builtins`. */
  attrTable: AttrTable | null;
  /* the built-in components' editable document form (no ids): what the Components
     tree browses and what a fork copies into doc.components */
  builtins: BuiltinDef[];
  /* the component-edit selection, SEPARATE from the widget selection (the two are
     mutually exclusive): `node` is the component id itself, or a Part node id in it */
  componentSel: { component: number; node: number } | null;
  /* the built-in being BROWSED. A built-in is not in the document and carries no ids,
     so it cannot be addressed the way componentSel addresses an editable one: it is
     named, plus a CHILD-INDEX PATH into its parts ("" = the component itself, "0" =
     its root part, "0.1" = that part's second child). Index rather than name because
     this addresses the definition's own tree, where an unnamed node is still a node —
     unlike a part path, which addresses only what a property can hang off (spec 2.3).
     Read-only, and mutually exclusive with both other selections. */
  builtinSel: { name: string; path: string } | null;
  view: ViewState;
  page(): Page | null;
  selectedWidget(): Widget | null;
  /* the selected FRAME, when the (single) selection names one (spec 2.8): from its Layers
     row, or from its own pixels on the stage — the padding, gaps and empty room its
     children do not cover */
  selectedFrame(): Frame | null;
  apply(ops: Op[]): void;
  setPage(id: number): void;
  /* insert a fresh page and switch to it once the echo issues its id (the topbar page
     selector's "+ New page") */
  addPage(): void;
  /* land the author on a consumer found elsewhere (the Data workspace's where-used):
     switch to the widget's page, select it, and show the content workspace */
  reveal(widget: number): void;
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
  /* the verbs of ONE node (a widget's or a frame's), opened at a screen position. The
     stage's right-click and the Layers tree's are the same menu over the same node: the
     tree is the only place a frame can be right-clicked at all, since on the stage its
     own children cover it. */
  openNodeMenu(x: number, y: number, node: number): void;
  /* select one widget and narrow to one of its template parts (a part path, spec 2.3);
     "" steps back to the widget. `select` always clears any part. */
  selectPart(id: number, path: string): void;
  /* select a document component (or one part node in it) for editing; clears the
     widget selection, as selecting a widget clears this */
  selectComponent(component: number, node: number): void;
  /* browse a built-in (or one part node inside it, by child-index path): the inspector
     shows the definition READ-ONLY, since nothing in the document owns it until it is
     overridden. This is how the shipped types are read before forking one. */
  selectBuiltin(name: string, path: string): void;
  /* the "Override <Name>" verb (spec 2.3 Forking): copy a built-in's document form
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
  /* the theme preview mode (spec 2.10): sets view.themeMode, persists it locally and
     repaints the artboard; the Style workspace's toggle is the only caller for now */
  setThemeMode(mode: "dark" | "light"): void;
  /* what the compiler said about this widget or anything inside it */
  diagFor(widget: number): Diag[];
  /* the findings pinned to one node, or to one field of it (spec 3.8: a finding sits on
     the row that is wrong). No `where` asks for the node's own findings only. */
  diagAt(node: number, where?: string): Diag[];
  /* every finding about a node, whatever field of it they name. A summary line stands for
     the whole node, so it rolls these up; the form under it pins each one to its row. */
  diagNode(node: number): Diag[];
  /* re-render the sidebars: a fold or a menu changed, not the document */
  refresh(): void;
}

/* The inline finding mark: a small icon on the offending row, its popover on hover. The
 * popover is one shared element on the body, so a sidebar rebuild can never strand it. */
let pop: HTMLElement | null = null;

function showPop(anchor: HTMLElement, diags: Diag[]): void {
  hidePop();
  pop = el(
    "div",
    { class: "diag-pop" },
    diags.map((row) =>
      el("div", { class: "diag-pop-row " + row.grade }, [
        el("span", { class: "grade", text: row.grade }),
        el("span", { class: "message", text: row.message }),
      ]),
    ),
  );
  document.body.appendChild(pop);
  const at = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - box.width - 8));
  const top = at.bottom + box.height + 8 > window.innerHeight ? at.top - box.height - 6 : at.bottom + 6;
  pop.style.left = left + "px";
  pop.style.top = top + "px";
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
    class: "diag-dot " + worst,
    html: iconMarkup("alert", 11, 2),
  });
  dot.addEventListener("mouseenter", () => showPop(dot, diags));
  dot.addEventListener("mouseleave", hidePop);
  return dot;
}

const folded = new Map<string, boolean>();

/* the header is the whole row, the caret rotates rather than swapping glyph, and the state
 * is remembered per section key across selection changes (spec 3.2). Folding is a pure
 * view act: it toggles one style and never asks for a rebuild. */
export function section(
  key: string,
  title: string,
  badge: string | null,
  body: () => (HTMLElement | null)[],
): HTMLElement[] {
  const open = !folded.get(key);
  const panel = el(
    "div",
    { class: "section-body" },
    body().filter(Boolean) as HTMLElement[],
  );
  if (!open) panel.style.display = "none";
  const head = el("button", { class: "section-head" }, [
    el("span", { class: "caret", html: iconMarkup("chevron-down", 10, 2) }),
    el("span", { class: "section-title", text: title }),
    badge !== null ? el("span", { class: "badge", text: badge }) : null,
    el("span", { class: "rule" }),
  ]);
  if (open) head.classList.add("open");
  head.addEventListener("click", () => {
    const opening = panel.style.display === "none";
    panel.style.display = opening ? "" : "none";
    head.classList.toggle("open", opening);
    folded.set(key, !opening);
  });
  return [head, panel];
}

/* a live value, or the UNKNOWN mark: never a fabricated number */
export function liveText(live: Live | null, cell: string): string {
  const value = live?.values?.[cell];
  if (value === undefined || value === null) return "--";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "object") {
    /* a timer reads as its time left; the card's `on` treatment says running */
    const remaining = (value as Json).remaining;
    if (typeof remaining === "number")
      return String(Math.round(remaining * 1000) / 1000) + " s";
    return "--";
  }
  return String(value);
}

export function liveIsOn(live: Live | null, cell: string): boolean {
  const value = live?.values?.[cell];
  if (value === true) return true;
  return typeof value === "object" && value !== null && (value as Json).running === true;
}

/* every variable a widget's flows can name: its own locals shadow the globals */
export function variablesInScope(editor: Editor, widget: Widget | null): Var[] {
  const locals = widget?.locals ?? [];
  const shadowed = new Set(locals.map((v) => v.name));
  return locals.concat(editor.store.globals().filter((v) => !shadowed.has(v.name)));
}
