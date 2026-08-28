/* The two sidebars. Both are generated from the served tables: the section order is fixed
 *, a slot's group decides whether its row lives in Data in or Appearance
 *, and every editor comes from the slot's shape.
 *
 * Each sidebar is declared twice, and the split is the point. `*Shape` projects the document
 * down to what decides which controls EXIST; `render*` builds those controls once and binds
 * each one to a reader for what it SHOWS. A sidebar is rebuilt only when its shape string
 * changes, so an arriving value (a document echo, a live frame at 30 Hz) is an assignment
 * into standing nodes and nothing else (reconcile.ts).
 *
 * Every reader looks its node up in the store by id rather than closing over the object it
 * was built from. Op application mutates nodes in place, but a snapshot replaces them
 * wholesale, and a binding holding the old object would then quietly show a document that
 * no longer exists. */

import { DropPlan, dropAtPageEnd, dropPlan, dropZone, holds } from "../arrange.js";
import { clear, commitInput, el, iconButton } from "../dom.js";
import { diagIcon, Editor, section, StageContext } from "../editor.js";
import { ICONS, iconMarkup } from "../icons.js";
import { openMenu } from "../menu.js";
import { ownedSlots, elementIndex, slotLeaf } from "../elements.js";
import { bindField, bindFlag, bindText } from "../reconcile.js";
import { authoredSlot, boundSlots, eachAuthoredSlot, ownSlot, slotCell,
         slotText, spellSlotText, typeOf, withSlot, withoutSlot } from "../slots.js";
import { makeFold, treeRow } from "../tree.js";
import { ComponentDef, Flow, isInstance, Json, Node, SlotSpec, TemplateNode,
         Var, ComponentType } from "../types.js";

import { casesRows, casesSig } from "./casesrow.js";
import { attrsSection, attrsShape, chassisRow, componentVarsSection, componentViewShape,
         interactSection, ownedShape, renderBuiltinComponent,
         renderComponentView } from "./components.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { constScope, optionsSlotScope, Scope, slotScope } from "./scope.js";
import { BoxType, valueBox } from "./valuebox.js";
import { newVariable, varCard, varShape } from "./vars.js";

/* ---- left sidebar: the Layers tree, which is PAGE COMPOSITION — every node of the
 * current page, one row per node, whatever it draws (pages live in the topbar selector;
 * globals live in Data).
 *
 * An INSTANCE is a leaf here even though it holds a whole tree: what is inside it belongs
 * to the component it names, which is a different thing with a different lifetime, edited
 * in the Design workspace (workspaces/design.ts). Unfolding it here would offer to edit
 * every placement at once while looking at one. ---- */

/* the Layers tree's own expansion state, independent of the Design tree's.
 *
 * A ROW STARTS SHUT. This tree is page COMPOSITION, and a page unfolded to every leaf is a
 * wall of rows nobody asked to read; opening one is one click on its caret. The single
 * exception is a row HOLDING THE SELECTION — picking a nested node off the stage has to
 * show it here, or the tree is lying about where you are — so "contains what is selected"
 * is what an untouched caret means, and an explicit fold (which records a state) still
 * wins over it afterwards. Both the render and the drag helpers ask through `layerOpen`
 * and `toggleLayer` so the two can never disagree about what a caret is currently saying. */
const fold = makeFold();

/* is anything selected inside this node? — never the node itself: a row's caret is about
   what is UNDER it. An instance is a leaf here (its subtree belongs to its component), so
   this walks the document's children alone and an instance's fenced rows never open one. */
function holdsSelection(editor: Editor, node: Node | null): boolean {
  const selection = editor.view.selection;
  const walk = (kids: Node[]): boolean =>
    kids.some((kid) => selection.indexOf(kid.id) >= 0 || walk(kid.children ?? []));
  return node ? walk(node.children ?? []) : false;
}

function layerDefault(editor: Editor, id: number): boolean {
  return holdsSelection(editor, editor.store.nodeAt(id));
}

function layerOpen(editor: Editor, id: number): boolean {
  return fold.open("n" + id, layerDefault(editor, id));
}

function toggleLayer(editor: Editor, id: number): void {
  fold.toggle("n" + id, layerDefault(editor, id), () => editor.refresh());
}

/* every node on the page, wherever it nests, pre-order — which is document order, which
   is z-order and flow order too, because there is only one list */
function flattenPage(children: Node[]): Node[] {
  const out: Node[] = [];
  for (const node of children) {
    out.push(node);
    out.push(...flattenPage(node.children ?? []));
  }
  return out;
}

export function leftShape(editor: Editor): string {
  const root = editor.root();
  const nodes = flattenPage(root?.children ?? []);
  const instances = nodes.filter(isInstance);
  return JSON.stringify({
    /* the CURRENT page's tree only: pages live in the topbar selector */
    page: editor.page()?.id ?? 0,
    /* the editing root — the page, or the entered component — and the crumb trail down
       to it, names included so a rename redraws the strip */
    root: root ? root.id : 0,
    ctx: editor.contexts.map((c) => [c.component, c.builtin, c.from]),
    names: [editor.page()?.name ?? "", ...editor.contexts.map((c) =>
      c.component ? String((editor.store.node(c.component) as Json)?.name ?? "") : c.builtin)],
    nodes: nodes.map((n) => [n.id, n.kind, n.type || n.name]),
    /* the tree highlights the selection and lists rows per expansion state */
    selection: editor.view.selection,
    element: editor.view.element,
    /* a switched-off node wears a different icon and a dimmed row, so which ones are
       hidden decides what the rows ARE */
    hidden: instances.flatMap((w) => {
      const type = typeOf(editor.registry, w.type ?? "");
      return (type?.slots ?? [])
        .filter((s) => s.name.endsWith(".shown") && authoredSlot(w, type, s.name) === false)
        .map((s) => w.id + ":" + s.name);
    }),
    fold: fold.revision(),
    /* the instance rows list their component's own subtree, so a recompiled registry
       (a component edited, a built-in forked) is new rows */
    registry: editor.registry?.version ?? 0,
    /* findings pin icons on rows and cards, so their coming and going is structure */
    wdiag: instances.flatMap((w) =>
      editor.diagFor(w.id).map((d) => w.id + ":" + d.code + ":" + d.message),
    ),
  });
}

/* ---- the breadcrumb strip: where the editor is standing ----
 *
 * Always over the tree: the page's name alone on a page, then one crumb per entered
 * component. Every crumb but the last steps back OUT to that level. Inside a component the
 * strip also carries the honesty line — the edit is to the COMPONENT, and every instance
 * follows — or, over an unforked built-in, the read-only notice and the Override verb.
 * The preview size reads here too, with a reset back to the entered instance's box. */
function breadcrumbs(editor: Editor): HTMLElement {
  const page = editor.page();
  const inside = editor.contexts.length > 0;
  const crumb = (label: string, current: boolean, jump: (() => void) | undefined) =>
    el("button", { class: "crumb" + (current ? " current" : ""), text: label,
                   onclick: current ? undefined : jump });
  const row = el("div", { class: "crumbs" }, [
    crumb(page?.name || "Page", !inside, () => editor.exitTo(0)),
    ...editor.contexts.flatMap((ctx, i) => {
      const name = ctx.component
        ? String((editor.store.node(ctx.component) as Json)?.name ?? "?")
        : ctx.builtin;
      const last = i === editor.contexts.length - 1;
      return [el("span", { class: "crumb-sep", text: "›" }),
              crumb(name, last, () => editor.exitTo(i + 1))];
    }),
  ]);
  if (!inside) return el("div", { class: "context-strip" }, [row]);

  const ctx = editor.contexts[editor.contexts.length - 1];
  const note = ctx.component
    ? el("p", { class: "crumb-note",
                text: "editing the component — every instance follows" })
    : el("p", { class: "crumb-note ro" }, [
        el("span", { text: "built-in — read-only" }),
        el("button", {
          class: "crumb-override", text: "Override",
          title: "copy " + ctx.builtin + " into this document and edit it; " +
                 "every instance follows the override",
          onclick: () => editor.forkBuiltin(ctx.builtin),
        }),
      ]);
  const size = el("span", { class: "crumb-size",
                            title: "the preview box: drag the grips on the artboard's " +
                                   "edge to try the component at other sizes" });
  bindText("ctx:size", size, () => {
    const at = editor.contexts[editor.contexts.length - 1];
    return at ? at.w + " × " + at.h : "";
  });
  const reset = iconButton("rotate-ccw", "reset the preview to the entered instance's size",
    () => {
      const at = editor.contexts[editor.contexts.length - 1];
      if (at) editor.resizePreview(at.w0, at.h0);
    });
  return el("div", { class: "context-strip on" }, [
    row, note, el("div", { class: "crumb-size-row" }, [size, reset]),
  ]);
}

export function renderLeftSidebar(host: HTMLElement, editor: Editor): void {
  clear(host);
  host.appendChild(breadcrumbs(editor));
  const ctx = editor.contexts[editor.contexts.length - 1] ?? null;
  const root = editor.root();
  let rows: HTMLElement[] = [];
  let empty = "nothing on this page yet";
  if (ctx && !ctx.component) {
    /* an unforked built-in: the served template's rows, read-only until Override */
    const type = typeOf(editor.registry, ctx.builtin);
    rows = (type?.template?.children ?? [])
      .flatMap((c) => readonlyRows(c, 1, "ro" + ctx.builtin));
    empty = "this component is its box alone";
  } else if (root) {
    rows = (root.children ?? []).flatMap((n) => nodeRows(editor, n, ctx ? 1 : 0));
    if (ctx) empty = "this component is empty — right-click the artboard to add";
  }
  const bare = !rows.length;
  /* inside a component the tree is headed by the component ITSELF, indenting its
     children one step under it */
  if (ctx) rows.unshift(contextRootRow(editor, ctx));
  const tree = el("div", { class: "layers" }, rows);
  armTree(tree, editor);
  host.appendChild(tree);
  if (bare) host.appendChild(el("p", { class: "empty", text: empty }));
}

/* THE ROOT'S OWN ROW: the entry that selects the component being edited. Clicking it
 * EMPTIES the selection, which the inspector already reads as the component itself (its
 * events, properties, behavior) — Escape says the same thing, and now the tree can too.
 * The key is no node's ("root"), so the drag, the row menu and the enter-on-double-click
 * all pass it by; dropping a carried row on it falls through to the end-of-page drop. */
function contextRootRow(editor: Editor, ctx: StageContext): HTMLElement {
  const nameNow = () => ctx.component
    ? String((editor.store.node(ctx.component) as Json)?.name ?? "?")
    : ctx.builtin;
  const label = el("span", { class: "layer-label" });
  bindText((ctx.component || "b:" + ctx.builtin) + ":name.ctxroot", label, nameNow);
  const name = nameNow();
  return treeRow(
    "root",
    0,
    "root" + (editor.view.selection.length ? "" : " current"),
    null,
    [
      el("span", { class: "icon-mark layer-glyph",
                   html: iconMarkup(ICONS[name] ? name : "layers", 16, 1.5) }),
      label,
    ],
    () => editor.select([]),
    "the component itself — its events, properties and behavior",
  );
}

/* A row and the node it stands for are one thing seen twice, so pointing at either
 * highlights both (editor.setHover). The leave clears it: a leave with no enter after it —
 * the pointer going straight out of the sidebar — would otherwise leave a ring standing on
 * the stage with nothing under the pointer. */
function hoverable(editor: Editor, row: HTMLElement, id: number): HTMLElement {
  /* a row crossed while one is being CARRIED is not a row being pointed at: the drop line
     and the page's own reflow already say where the pointer is */
  row.addEventListener("mouseenter", () => editor.setHover(drag ? 0 : id));
  row.addEventListener("mouseleave", () => editor.setHover(0));
  return row;
}

/* ONE ROW FOR ONE NODE, whatever it is. An instance shows its type's glyph and its type
 * as the fallback label; a box shows the box glyph; a leaf shows its kind's.
 *
 * AN INSTANCE'S SUBTREE IS SHOWN — the component's own nodes, from the served template —
 * but it is not THIS page's to touch: the rows are dimmed, they select the instance
 * rather than themselves, and editing them means entering the component's own context
 * (which edits every placement at once, and will say so). Showing the whole tree while
 * fencing the selection is the difference between hiding structure and protecting it. */
function nodeRows(editor: Editor, node: Node, depth: number): HTMLElement[] {
  const key = "n" + node.id;
  const instance = isInstance(node);
  const kids = instance ? [] : node.children ?? [];
  const template = instance
    ? (typeOf(editor.registry, node.type ?? "")?.template?.children ?? [])
    : [];
  const open = layerOpen(editor, node.id);
  const current =
    editor.view.selection.indexOf(node.id) >= 0 && (!editor.view.element || !instance);
  const label = el("span", { class: "layer-label" });
  bindText(node.id + ":label.layer", label, () => {
    const at = editor.store.nodeAt(node.id) ?? node;
    return at.name || at.type || at.kind;
  });
  const row = hoverable(editor, treeRow(
    key,
    depth,
    (instance ? "instance" : node.kind) + (current ? " current" : ""),
    kids.length || template.length
      ? { open, toggle: () => toggleLayer(editor, node.id) }
      : null,
    [
      el("span", { class: "icon-mark layer-glyph", html: iconMarkup(glyphOf(node), 16, 1.5) }),
      label,
      diagIcon(instance ? editor.diagFor(node.id) : editor.diagAt(node.id)),
    ],
    () => editor.select([node.id]),
  ), node.id);
  const rows = [row];
  if (open) for (const child of kids) rows.push(...nodeRows(editor, child, depth + 1));
  if (open && instance)
    for (const child of template)
      rows.push(...templateRows(editor, node.id, child, depth + 1, "t" + node.id));
  return rows;
}

/* a component-internal row: real structure, not this page's. It carries no node id — the
 * component owns these — so it selects the INSTANCE, drags nowhere, and wears `.tpl` to
 * say it is being looked at rather than held. Double-clicking one ENTERS the component and
 * lands selected on this very node (armTree below): the fence is an invitation, not only
 * a refusal. The row's KEY carries the whole name path for exactly that. */
function templateRows(editor: Editor, instanceId: number, node: TemplateNode,
                      depth: number, prefix: string): HTMLElement[] {
  const name = node.name || node.kind;
  const key = prefix + "." + name;
  const row = hoverable(editor, treeRow(
    key,
    depth,
    "tpl " + node.kind,
    null,
    [
      el("span", { class: "icon-mark layer-glyph",
                   html: iconMarkup(node.kind === "frame" ? "frame-free" : "node-" + node.kind,
                                    16, 1.5) }),
      el("span", { class: "layer-label", text: name }),
    ],
    () => editor.select([instanceId]),
  ), instanceId);
  const rows = [row];
  for (const child of node.children ?? [])
    rows.push(...templateRows(editor, instanceId, child, depth + 1, key));
  return rows;
}

/* an unforked BUILT-IN's rows, inside its own context: the served template with nothing
 * to select, drag or rename — the tree half of read-only, worn honestly */
function readonlyRows(node: TemplateNode, depth: number, prefix: string): HTMLElement[] {
  const name = node.name || node.kind;
  const key = prefix + "." + name;
  const row = treeRow(
    key,
    depth,
    "tpl " + node.kind,
    null,
    [
      el("span", { class: "icon-mark layer-glyph",
                   html: iconMarkup(node.kind === "frame" ? "frame-free" : "node-" + node.kind,
                                    16, 1.5) }),
      el("span", { class: "layer-label", text: name }),
    ],
    () => {},
  );
  const rows = [row];
  for (const child of node.children ?? [])
    rows.push(...readonlyRows(child, depth + 1, key));
  return rows;
}

/* which icon stands for a node: its component's, or its kind's — a frame is a box, and
   there is one box glyph because there is one kind of box */
function glyphOf(node: Node): string {
  if (isInstance(node)) return ICONS[node.type ?? ""] ? node.type ?? "" : "layers";
  if (node.kind === "frame") return "frame-free";
  return "node-" + node.kind;
}

/* ---- dragging a row somewhere else: the only way to reparent ----
 *
 * Pointer events, never the HTML5 drag API: that one owns the drag image and hands back a
 * drop target, when what this needs is the opposite — our own insertion line, and a target
 * we compute. The state lives in this module and its listeners on the window, because an
 * echo (or the auto-expand below) rebuilds these rows MID-DRAG: nothing here holds a row
 * element, and every move re-reads what is under the pointer. The arithmetic — which parent,
 * which index, whether the drop is legal — is all arrange.ts; this half feeds it geometry
 * and paints the answer. */

const DRAG_SLOP = 4;
const EXPAND_MS = 500;

interface Drag {
  editor: Editor;
  id: number;
  ghost: HTMLElement;
  line: HTMLElement;
  into: HTMLElement | null;   /* the frame row lit for a drop INSIDE it */
  over: number;               /* the row the pointer is on, so the expand timer knows to reset */
  timer: number;
  plan: DropPlan | null;
}

let armed: { editor: Editor; id: number; x: number; y: number } | null = null;
let drag: Drag | null = null;
/* a press and release on one row fires a click even when a drag happened in between */
let swallow = false;
/* DOUBLE-CLICK BY KEY, not by element: the first click SELECTS, selection rebuilds this
   very tree, and the replaced row resets the browser's own dblclick counter — so a
   double-click on a row would never fire natively. The row's key survives the rebuild;
   two presses on one key inside the window are the double. */
let lastPress = { key: "", time: 0, x: 0, y: 0 };
const DOUBLE_MS = 450;
const DOUBLE_SLOP = 6;
/* the drop the STAGE is currently showing: the tree's line says where the node would land,
   and the page behind it reflows into that arrangement (stage.ts owns the mechanism, and the
   stage's own drag feeds it the same way). Fed on CHANGE alone — a rebuild per pointermove
   would be a rebuild per pixel. */
let shown: DropPlan | null = null;

function preview(editor: Editor, id: number, plan: DropPlan | null): void {
  const same = plan && shown ? plan.parent === shown.parent && plan.index === shown.index
                             : plan === shown;
  if (same) return;
  shown = plan;
  editor.previewMove(id, plan);
}

function rowId(row: Element | null): number {
  const key = row?.getAttribute("data-key") ?? "";
  return /^n[0-9]+$/.test(key) ? Number(key.slice(1)) : 0;
}

/* the tree as it stands NOW: a rebuild replaces the element the drag started over */
function layersHost(): HTMLElement | null {
  return document.querySelector(".layers");
}

function labelOf(node: Node): string {
  return node.name || node.type || node.kind;
}

function armTree(tree: HTMLElement, editor: Editor): void {
  tree.addEventListener("pointerdown", (ev) => {
    swallow = false;
    if (ev.button !== 0) return;
    const at = ev.target as HTMLElement | null;
    if (at?.closest?.(".layer-caret")) return;   /* the caret owns folding */
    const keyed = at?.closest?.("[data-key]") as HTMLElement | null;

    /* ENTER A COMPONENT on a double press: an instance row from itself, a fenced `.tpl`
       row from its key — `t<instance>.<name path>` — landing selected on that very
       node. The click that follows is eaten (`swallow`): it would land on whichever
       row the fresh context tree put under the pointer. */
    const key = keyed?.getAttribute("data-key") ?? "";
    const twice = key !== "" && key === lastPress.key &&
      ev.timeStamp - lastPress.time < DOUBLE_MS &&
      Math.abs(ev.clientX - lastPress.x) < DOUBLE_SLOP &&
      Math.abs(ev.clientY - lastPress.y) < DOUBLE_SLOP;
    lastPress = { key, time: ev.timeStamp, x: ev.clientX, y: ev.clientY };
    if (twice) {
      const fenced = /^t(\d+)\.(.+)$/.exec(key);
      const plain = /^n(\d+)$/.exec(key);
      const inst = fenced ? Number(fenced[1])
        : plain && isInstance(editor.store.nodeAt(Number(plain[1]))) ? Number(plain[1])
        : 0;
      if (inst) {
        lastPress = { key: "", time: 0, x: 0, y: 0 };
        swallow = true;
        editor.enterComponent(inst, fenced ? fenced[2] : undefined);
        return;
      }
    }

    const id = rowId(keyed);
    if (!id) return;
    armed = { editor, id, x: ev.clientX, y: ev.clientY };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
  });
  /* the click that closes a real drag: eaten here, before the row it lands on selects */
  tree.addEventListener("click", (ev) => {
    if (!swallow) return;
    swallow = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
  /* a row's own verbs, the same menu the stage opens over the same node */
  tree.addEventListener("contextmenu", (ev) => {
    const id = rowId((ev.target as HTMLElement | null)?.closest?.("[data-key]") ?? null);
    if (!id) return;
    ev.preventDefault();
    editor.openNodeMenu(ev.clientX, ev.clientY, id);
  });
}

function begin(): void {
  if (!armed) return;
  const editor = armed.editor;
  const node = editor.store.nodeAt(armed.id);
  if (!node) {
    armed = null;
    return;
  }
  const ghost = el("div", { class: "layer-ghost", text: labelOf(node) });
  document.body.appendChild(ghost);
  drag = {
    editor,
    id: armed.id,
    ghost,
    line: el("div", { class: "layer-drop-line" }),
    into: null,
    over: 0,
    timer: 0,
    plan: null,
  };
  armed = null;
  layersHost()?.classList.add("dragging");
}

function unmark(): void {
  if (!drag) return;
  drag.line.remove();
  drag.into?.classList.remove("drop-into");
  drag.into = null;
}

function markLine(host: HTMLElement, rect: DOMRect, after: boolean): void {
  if (!drag) return;
  /* a rebuild orphans the line, so it is re-hung rather than kept */
  if (drag.line.parentElement !== host) host.appendChild(drag.line);
  drag.line.style.top = (after ? rect.bottom : rect.top) - host.getBoundingClientRect().top + "px";
}

/* hovering a FOLDED frame opens it, so a drop can reach what is inside without letting go */
function autoExpand(id: number, frame: boolean, open: boolean): void {
  if (!drag || id === drag.over) return;
  drag.over = id;
  if (drag.timer) window.clearTimeout(drag.timer);
  drag.timer = 0;
  if (!id || !frame || open) return;
  const editor = drag.editor;
  drag.timer = window.setTimeout(() => {
    if (drag) drag.timer = 0;
    toggleLayer(editor, id);
  }, EXPAND_MS);
}

function onMove(ev: PointerEvent): void {
  if (armed) {
    if (Math.abs(ev.clientX - armed.x) < DRAG_SLOP && Math.abs(ev.clientY - armed.y) < DRAG_SLOP)
      return;
    begin();
  }
  if (!drag) return;
  ev.preventDefault();
  drag.ghost.style.left = ev.clientX + 14 + "px";
  drag.ghost.style.top = ev.clientY + 12 + "px";

  /* the editing root, page or entered component: the same drop arithmetic serves both */
  const page = drag.editor.root();
  const host = layersHost();
  unmark();
  drag.plan = null;
  if (!page || !host) return;

  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const row = (under?.closest?.("[data-key]") ?? null) as HTMLElement | null;
  const id = row && host.contains(row) ? rowId(row) : 0;

  if (id) {
    const node = drag.editor.store.nodeAt(id);
    const rect = row!.getBoundingClientRect();
    /* only a node that can HOLD one has an inside to drop into (arrange.ts): an instance
       and a leaf both split at the halfway mark, and every position names a gap */
    const frame = holds(node);
    const open = frame && layerOpen(drag.editor, id);
    const zone = dropZone(frame, rect.height ? (ev.clientY - rect.top) / rect.height : 0);
    drag.plan = dropPlan(page, drag.id, id, zone, open);
    if (drag.plan && zone === "into") {
      row!.classList.add("drop-into");
      drag.into = row;
    } else if (drag.plan) {
      markLine(host, rect, zone === "after");
    }
    autoExpand(id, frame, open);
  } else {
    autoExpand(0, false, false);
    const box = host.getBoundingClientRect();
    const below = ev.clientX >= box.left && ev.clientX <= box.right && ev.clientY > box.top;
    /* the empty room under the last row is the end of the page, and says so */
    if (!below) return;
    drag.plan = dropAtPageEnd(page, drag.id);
    const rows = host.querySelectorAll(".layer-row");
    const last = rows[rows.length - 1];
    if (drag.plan && last) markLine(host, last.getBoundingClientRect(), true);
  }
  drag.ghost.classList.toggle("no", !drag.plan);
  preview(drag.editor, drag.id, drag.plan);
}

function onUp(): void {
  const held = drag;
  end();
  if (!held) return;
  swallow = true;
  /* the caret goes at the release, plan or no plan: it promised where the node would land,
     and the answer is about to be on screen. (It used to stay until the echo retired it,
     which was right when the preview WAS the arrangement — a line has nothing to hand
     over to.) */
  held.editor.previewMove(0, null);
  const plan = held.plan;
  if (!plan) return;
  /* the client always sends the whole placement, reparent or reorder: one path */
  held.editor.apply([
    { op: "move", node: held.id, parent: plan.parent, list: "children", index: plan.index },
  ]);
  held.editor.select([held.id]);
  /* dropped into a frame that was folded shut: open it, or it lands out of sight */
  const page = held.editor.root();
  if (page && plan.parent !== page.id && !layerOpen(held.editor, plan.parent))
    toggleLayer(held.editor, plan.parent);
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") cancel();
}

function cancel(): void {
  const held = drag;
  end();
  if (held) held.editor.previewMove(0, null);
}

function end(): void {
  armed = null;
  if (drag) {
    if (drag.timer) window.clearTimeout(drag.timer);
    unmark();
    drag.ghost.remove();
    layersHost()?.classList.remove("dragging");
    drag = null;
  }
  /* what the stage is showing is the stage's from here: a drop leaves its preview standing
     until the echo retires it, and every other end path has already put the document back */
  shown = null;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", cancel);
  window.removeEventListener("keydown", onKey);
}

/* ELEMENT ROWS have left this tree. Layers is page composition — which frames and
   instances sit where — and a component's internals belong to the component that defines
   them, which is the Design workspace's tree, not this one. The per-element eye that hid
   one went with them; per-instance element visibility comes back as an
   instance-inspector concern, since
   that is what it always was: an override on one placement, not a fact about the page.

/* ---- inspector ---- */

/* the selected element, but only when this component can actually name it; anything else
 * (a stale path, an unknown component) falls back to the instance view */
function selectedElement(editor: Editor, type: ComponentType | null): string {
  const path = editor.view.element;
  return path && type && elementIndex(type).byPath.has(path) ? path : "";
}

/* The CONTENT inspector, routed by WHAT THE NODE IS rather than by which of three kinds
   it used to be: an instance shows the component's own vocabulary (data in, behavior,
   locals, appearance), and any other node shows its name, its kind and its attrs. */
export function inspectorShape(editor: Editor): string {
  const node = editor.selectedNode();
  const ctx = editor.contexts[editor.contexts.length - 1];
  if (!node && ctx) {
    /* nothing selected inside an entered component: the inspector stands on the
       COMPONENT itself — its events, properties, behavior and design frame */
    const comp = ctx.component
      ? (editor.store.node(ctx.component) as ComponentDef | null) : null;
    if (comp) return "ctx-comp:" + componentViewShape(editor, comp);
    if (ctx.builtin) return "ctx-builtin:" + ctx.builtin;
  }
  if (!node) return "empty";
  if (!isInstance(node))
    return JSON.stringify({
      node: node.id,
      kind: node.kind,
      attrs: attrsShape(editor, node),
      /* what this element declares: inside a component its variables are also its
         PUBLIC interface (a page element has no placement to offer one to), its gesture
         and its behavior anywhere */
      own: ctx ? ownedShape(node) : null,
      interact: ownedShape(node).interact,
      flows: (node.flows ?? []).map(flowShape),
      locals: (node.locals ?? []).map(varShape),
      diag: editor.diagNode(node.id).map((d) => (d.where ?? "") + ":" + d.code + ":" + d.message)
        .concat((node.locals ?? []).flatMap((v) =>
          editor.diagNode(v.id).map((d) => v.id + ":" + d.code + ":" + d.message))),
    });
  const instance = node;
  const type = typeOf(editor.registry, instance.type ?? "");
  const fed = boundSlots(instance);
  const template = JSON.stringify(type?.template ?? null);
  return JSON.stringify({
    id: instance.id,
    type: instance.type,
    element: selectedElement(editor, type),
    slots: (type?.slots ?? []).map((s) => [
      s.name, s.shape, s.group, s.editor ?? "", (s.variants ?? []).join("|"),
    ]),
    fed: Array.from(fed).sort(),
    /* which affordances a slot row carries (the cases disclosure, its open rows, the
       poll button) follows the authored text, so it is structure — and an instance's
       ATTR rows carry the cases disclosure too */
    slotsig: slotRowSig(editor, instance),
    attrsig: attrsShape(editor, instance),
    align: template.includes("slot:align"),
    textScale: template.includes("slot:textScale"),
    /* the aspect slot decides whether align has anywhere to apply, so this one VALUE is
       genuinely structural; it is a boolean, and it moves only when an aspect is authored */
    aspect: String(authoredSlot(instance, type, "aspect") ?? "") !== "",
    flows: (instance.flows ?? []).map(flowShape),
    locals: (instance.locals ?? []).map(varShape),
    diag: editor.diagFor(instance.id).map((d) => d.node + ":" + d.code + ":" + d.message),
  });
}

export function renderInspector(host: HTMLElement, editor: Editor): void {
  clear(host);
  const node = editor.selectedNode();
  if (node && !isInstance(node)) {
    renderNodeInspector(host, editor, node);
    return;
  }
  const instance = node;
  if (!instance) {
    /* inside an entered component, nothing selected IS a selection: the component. The
       very views the Design workspace edits it with, so the two places cannot drift. */
    const ctx = editor.contexts[editor.contexts.length - 1];
    const comp = ctx?.component
      ? (editor.store.node(ctx.component) as ComponentDef | null) : null;
    if (comp) {
      renderComponentView(host, editor, comp);
      return;
    }
    if (ctx?.builtin && renderBuiltinComponent(host, editor, ctx.builtin)) return;
    host.appendChild(
      el("div", { class: "inspector-head" }, [
        el("span", { class: "type", text: "nothing selected" }),
      ]),
    );
    host.appendChild(
      el("div", { class: "inspector-body" }, [
        el("p", { class: "empty", text: "pick an element on the page" }),
      ]),
    );
    return;
  }

  const at = () => editor.store.instance(instance.id) ?? instance;
  const type = typeOf(editor.registry, instance.type ?? "");
  const element = selectedElement(editor, type);
  if (element && type) {
    renderElementInspector(host, editor, instance, type, element);
    return;
  }
  const fed = boundSlots(instance);
  /* ONLY the component's own properties: what an element declares is edited by
     selecting that element, and appears nowhere else. This is the whole point of elements
     owning properties — a Slider's inspector is its value, its range and its frame,
     not every colour of every shape inside it. */
  const own = ownedSlots(type, "");
  const valueSlots = own.filter((s) => s.group === "value");
  const otherSlots = own.filter((s) => s.group !== "value");
  /* ONE scope for every slot row: a slot expression's universe is the instance's, not
     the row's; the options slot alone adds the schema's enum types to its browse */
  const scope = slotScope(editor, instance);
  const rowsFor = (spec: SlotSpec) =>
    slotRows(editor, instance, spec,
             spec.editor === "enum-type" ? optionsSlotScope(editor, instance) : scope);

  const label = commitInput(
    instance.name,
    (text) => editor.apply([{ op: "set_prop", node: instance.id, key: "label", value: text }]),
    { class: "field title", title: "the instance's label" },
  );
  bindField(instance.id + ":label", label, () => at().name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      label,
      /* a finding that names the instance itself and no field within it (an unknown type,
         say) has no better row to sit on than the head */
      diagIcon(editor.diagAt(instance.id)),
    ]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  /* 1. Data in, and ONLY where the component takes values: what an instance consumes is its
   *    value-group slots, so a Button (which consumes nothing) shows no such section.
   *    Every value is an expression box; a literal is just a short expression. */
  if (valueSlots.length)
    body.append(
      ...section("data-in", "Data in",
        String(valueSlots.filter((s) => fed.has(s.name)).length), () =>
        valueSlots.flatMap(rowsFor),
      ),
    );

  /* 2. Behavior: what this instance authors. The type's built-in defaults (a Toggle
   *    toggles) are the control working as expected, not authored behavior, so they are
   *    not listed; authoring a flow on the same slot takes over automatically. */
  body.append(
    ...section("behavior", "Behavior", String((instance.flows ?? []).length), () => [
      ...(instance.flows ?? []).map((flow) => flowCard(editor, instance, type, flow)),
      (instance.flows ?? []).length
        ? null
        : el("p", { class: "empty", text: "no behavior yet" }),
      addFlowButton(editor, instance, type),
    ]),
  );

  /* 3. Local variables */
  body.append(
    ...section("locals", "Local Variables", String((instance.locals ?? []).length), () => [
      ...(instance.locals ?? []).map((variable) => varCard(editor, variable, "local")),
      el("button", {
        class: "dashed-btn",
        text: "+ Variable",
        onclick: () => newVariable(editor, instance.id, "locals", instance.locals ?? []),
      }),
    ]),
  );

  /* 4. Appearance: the CONTENT's properties (colors, text, per-type config). RELATED
   *    properties sit together, in ONE canonical order on every type (the semantic
   *    contract extended to position): colors, text, the control's own shape, range, the
   *    scale, options, sampling, then state. A name outside the table keeps its
   *    declaration order at the end. */
  body.append(
    ...section("appearance", "Appearance", String(fed.size), () =>
      otherSlots
        .filter((s) => s.group === "appearance" || s.group === "config")
        .sort((a, b) => slotRank(a.name) - slotRank(b.name))
        .flatMap(rowsFor),
    ),
  );

  /* 5. Panel: the box around the content — the frame-group SLOTS the component declares
   *    (surface, border, radius, pad: bindable, which is what makes a bound surface a
   *    lamp), and then how this placement is placed.
   *
   *    PLACE IS ATTRS, not props: an instance is a node, and a node's fields are
   *    expression text, so these are the very same rows a plain frame gets and they go
   *    through the very same commit. There is no instance-shaped copy of them. */
  body.append(
    ...section("panel", "Panel", null, () =>
      otherSlots.filter((s) => s.group === "frame").flatMap(rowsFor),
    ),
  );
  body.append(...attrsSection(editor, instance));
}

/* the canonical property order (see the Appearance section): clusters of related names,
 * shared across every type so the same property is always found in the same place */
const SLOT_ORDER = [
  /* the node's own switch leads: whether it is drawn at all comes before how */
  "shown",
  /* the content colors */
  "fillColor", "trackColor", "handleColor", "bodyColor",
  /* text */
  "text", "textColor", "textSize", "align",
  /* the control's own shape */
  "controlRadius", "thickness", "startAngle", "sweepAngle",
  /* range + gesture */
  "min", "max", "step", "drag",
  /* the scale */
  "divisions", "decimals", "labels",
  /* options */
  "options",
  /* sampling (Trend): read by the backend to size the ring, not by any attr */
  "rate", "window",
  /* state, last: interlocks, not styling */
  "visible", "enabled",
];

/* ranked by the property's own name, not its address: `bar.fillColor` sorts as
   fillColor, so one element's rows read in the same order as any other's */
function slotRank(address: string): number {
  const at = SLOT_ORDER.indexOf(slotLeaf(address));
  return at < 0 ? SLOT_ORDER.length : at;
}

/* The element-scoped inspector: the head reads instance › element (the instance's name
 * is the way back), and ONE section lists exactly the properties THIS element owns — not
 * its children's, which have their own rows in the tree, and not the component's, which are
 * one click up. Ownership is exclusive, so every property is editable in exactly one
 * place. Behavior, variables and placement belong to the instance view. */
function renderElementInspector(
  host: HTMLElement,
  editor: Editor,
  instance: Node,
  type: ComponentType,
  path: string,
): void {
  const node = elementIndex(type).byPath.get(path)!;
  const back = el("button", {
    class: "element-back",
    title: "back to the instance",
    onclick: () => editor.select([instance.id]),
  });
  bindText(instance.id + ":label.element", back, () => {
    const at = editor.store.instance(instance.id);
    return at ? at.name || at.type || "" : "";
  });
  /* the whole path, not just the leaf: elements nest now (a knob's dot lives under its
     face), and "Knob › dot" would say nothing about where that dot actually is. Every
     ancestor is a step BACK to itself, so the head navigates as well as it reads. */
  const segments = path.split(".");
  const crumbs: (HTMLElement | null)[] = [back];
  segments.forEach((name, i) => {
    const upto = segments.slice(0, i + 1).join(".");
    const last = i === segments.length - 1;
    crumbs.push(el("span", { class: "element-sep", text: "›" }));
    crumbs.push(
      last
        ? el("span", { class: "element-name", text: name, title: path })
        : el("button", {
            class: "element-back",
            text: name,
            title: upto,
            onclick: () => editor.selectElement(instance.id, upto),
          }),
    );
  });
  host.appendChild(el("div", { class: "inspector-head" }, crumbs));

  const specs = ownedSlots(type, path)
    .sort((a, b) => slotRank(a.name) - slotRank(b.name));
  const scope = slotScope(editor, instance);
  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);
  body.append(
    ...section("element", node.name, String(specs.length), () =>
      specs.length
        ? specs.flatMap((spec) =>
            slotRows(editor, instance, spec,
                     spec.editor === "enum-type" ? optionsSlotScope(editor, instance) : scope))
        : [el("p", {
            class: "empty",
            text: node.children.length
              ? "this element lays its children out; their properties are on them"
              : "this element has no properties of its own",
          })],
    ),
  );
}

/* THE NODE INSPECTOR: a box, a text, an icon or a path on the page — its name, what it
 * is, and its attrs. There is no hand-written field list any more: `attrsSection` (the
 * Design inspector's own) generates every row from the served vocabulary, so a page's
 * box and a component's box edit identically because they are the same node. */
function renderNodeInspector(host: HTMLElement, editor: Editor, node: Node): void {
  const at = () => editor.store.nodeAt(node.id) ?? node;

  const name = commitInput(
    node.name,
    (text) => editor.apply([{ op: "set_prop", node: node.id, key: "name", value: text }]),
    { class: "field title", title: "what the tree calls it" },
  );
  bindField(node.id + ":name", name, () => at().name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [name, diagIcon(editor.diagAt(node.id))]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  /* the one structural fact: WHAT it is. Everything else is an expression in the table. */
  const kindRow: (HTMLElement | null)[] = [
    el("label", { text: "kind" }),
    el("span", { class: "kw", text: node.kind }),
    el("span"),
  ];
  body.append(
    ...section("node", "Node", null, () => [el("div", { class: "prop-grid" }, kindRow)]),
  );
  /* EVERY ELEMENT AUTHORS BEHAVIOR AND HOLDS VARIABLES. What an element declares is not
     a fact about being a box or about naming a component — the same two sections an
     instance shows, on the same lists, through the same cards. The gesture it triggers on
     is its own `interact`, which is why the gesture picker sits right beside them. */
  body.append(
    ...section("behavior", "Behavior", String((at().flows ?? []).length), () => [
      ...((at().flows ?? []) as Flow[]).map((flow) => flowCard(editor, at(), null, flow)),
      (at().flows ?? []).length
        ? null
        : el("p", { class: "empty", text: "no behavior yet" }),
      addFlowButton(editor, at(), null),
    ]),
  );
  /* ONE LIST, WHEREVER THE ELEMENT LIVES. Inside a component this is also where its
     properties are declared — a variable marked `public` is addressed under this
     element's name path and every instance fills it in — so the section that used to sit
     above this one is this one. The card knows which it is from the scope it is given. */
  if (editor.contexts.length)
    body.append(...componentVarsSection(editor, node.id, "element-vars",
                                        () => (at().locals ?? []) as Var[],
                                        "no variables of its own"));
  else
    body.append(
      ...section("locals", "Local Variables", String((at().locals ?? []).length), () => [
        ...((at().locals ?? []) as Var[]).map((variable) =>
          varCard(editor, variable, "local", node.id)),
        el("button", {
          class: "dashed-btn",
          text: "+ Variable",
          onclick: () => newVariable(editor, node.id, "locals", at().locals ?? []),
        }),
      ]),
    );
  body.append(...attrsSection(editor, node));
  /* the gesture an element carries: authored inside a component (where an instance
     serves it) and on a page alike, since a page element's own interact is compiled,
     served and armed the same way */
  body.append(...interactSection(editor, node));
}

/* ---- SLOT ROWS: chassis + value box (phase 4a) ----
 *
 * Every slot row is the attr row's own anatomy — label | value box | trail — through
 * the one chassis. The box's text IS the document encoding (slots.ts: raw number/bool
 * literals, strings as expressions), so a slot holding a non-literal expression shows
 * exactly like an attr holding one: the icon dims for gestures, the preview goes
 * unknown, and there is no bound or driven cell state any more. Empty means unset —
 * the key is removed and the type default stands as the placeholder. */

/* Does this expression read a mesh FUNCTION — is a poll cadence worth offering? A
 * lexical scan over the '@' spellings against the mesh's F entities; the compiler's
 * dep scan stays the authority on what actually polls. */
function referencesFunction(editor: Editor, text: string): boolean {
  let fns: Set<string> | null = null;
  for (const hit of text.matchAll(/@([A-Za-z0-9_/]+)/g)) {
    fns ??= new Set(
      editor.mesh.entities.filter((e) => e.kind === "F").map((e) => e.name));
    if (fns.has(hit[1])) return true;
  }
  return false;
}

/* the slot affordances as SHAPE data: the OPEN cases disclosure (casesrow.ts) and
 * whether the poll button stands — exactly what decides which rows exist. A resting
 * row contributes nothing, so a value echo into one never moves the shape (the chip
 * arms by bind). The sig reads the box's TEXT encoding, so a raw number or bool slot
 * carries the affordance the same as a string one. */
function slotRowSig(editor: Editor, instance: Node): string {
  const rows: string[] = [];
  eachAuthoredSlot(instance, (address, value) => {
    const text = slotText(value);
    if (!text.trim()) return;
    const cases = casesSig(slotCell(instance, address), text);
    const poll = referencesFunction(editor, text) ? "p" : "";
    if (cases || poll) rows.push(address + ":" + cases + ":" + poll);
  });
  return rows.join("|");
}

/* which literal picker a slot's box gets, from the served spec: variants feed the enum
 * picker, min/max/step become the scrub grain hints */
function slotBoxType(spec: SlotSpec): BoxType {
  if (spec.editor === "align") return { shape: "Align" };
  if (spec.shape === "Enum") {
    const variants = spec.variants ?? [];
    return { shape: "Enum", variants: () => variants };
  }
  if (spec.shape === "Num") {
    const bounded = typeof spec.min === "number" && typeof spec.max === "number" &&
                    spec.max > spec.min;
    const step = spec.step ?? (bounded ? (spec.max! - spec.min!) / 100 : 0);
    return step ? { shape: "Num", step } : { shape: "Num" };
  }
  if (spec.shape === "Bool" || spec.shape === "Text" || spec.shape === "Color" ||
      spec.shape === "Icon" || spec.shape === "List" || spec.shape === "Map")
    return { shape: spec.shape };
  return { shape: "Text" };   /* anything unforeseen: the glyph alone */
}

/* one slot's row (and its open cases editor, when one stands) */
function slotRows(
  editor: Editor,
  instance: Node,
  spec: SlotSpec,
  scope: Scope,
): HTMLElement[] {
  const at = () => editor.store.instance(instance.id) ?? instance;
  const text = () => slotText(ownSlot(at(), spec.name));
  const commitText = (raw: string) => {
    /* the address is the path into the instance's own nesting: an element's value is
       written under it, beside nothing else the instance holds. Empty unsets. */
    const slots = raw.trim() === ""
      ? withoutSlot(at().slots, spec.name)
      : withSlot(at().slots, spec.name, spellSlotText(spec.shape, raw));
    editor.apply([{ op: "set_prop", node: instance.id, key: "slots", value: slots }]);
  };
  const boxType = slotBoxType(spec);

  const cases = casesRows(editor, slotCell(instance, spec.name), scope, boxType,
                          text, commitText);

  /* the chips and the diag mark ride INSIDE the box (BoxSpec.trail): they are
     metadata about the value, and the box is where the value lives */
  const box = valueBox({
    key: slotCell(instance, spec.name),
    read: text,
    commit: commitText,
    emptyMeans: "default",
    placeholder: slotText(spec.default),
    title: spec.name + ": " + spec.shape,
    type: boxType,
    scope,
    trail: [cases?.chip ?? null, pollChip(editor, instance, spec),
            diagIcon(editor.diagAt(instance.id, spec.name))],
  });

  const row = chassisRow({
    name: slotLeaf(spec.name),
    note: spec.name + ": " + spec.shape,
    box,
  });
  /* a slot row and an attr row may wear the same name (radius, surface — the deferred
     props-vs-attrs question); the class keeps them tellable apart */
  row.classList.add("slot-row");
  const rows = [row];
  if (cases?.editor) rows.push(cases.editor);
  return rows;
}

/* THE POLL SETTINGS, on exactly the rows whose expression reads a mesh function: the
 * menu-field popover with one HZ value box writing the instance's poll[slot] — metadata beside
 * the slot, as transitions ride attrs. Empty deletes the key; 2 Hz is the standing
 * default the placeholder shows. */
function pollChip(editor: Editor, instance: Node, spec: SlotSpec): HTMLElement | null {
  const authored = ownSlot(instance, spec.name);
  if (typeof authored !== "string" || !referencesFunction(editor, authored)) return null;
  const at = () => editor.store.instance(instance.id) ?? instance;
  const hzOf = () => ((at().poll ?? {}) as Record<string, number>)[spec.name];
  const chip = iconButton("timer",
    "poll: how often the function this slot reads is called, in Hz (empty = 2)", () => {
      const rect = chip.getBoundingClientRect();
      const box = valueBox({
        key: instance.id + ":poll." + spec.name,
        read: () => (hzOf() === undefined ? "" : String(hzOf())),
        commit: (raw) => {
          const next = { ...((at().poll ?? {}) as Record<string, number>) };
          const hz = Number(raw.trim());
          if (!raw.trim() || !Number.isFinite(hz) || hz <= 0) delete next[spec.name];
          else next[spec.name] = hz;
          editor.apply([{ op: "set_prop", node: instance.id, key: "poll", value: next }]);
        },
        emptyMeans: "default",
        placeholder: "2",
        title: "calls per second — a plain rate; empty falls back to 2 Hz",
        type: { shape: "Num" },
        scope: constScope(editor),
      });
      openMenu(rect.left, rect.bottom + 4, "poll " + slotLeaf(spec.name), [
        { node: el("div", { class: "menu-field" },
                   [el("span", { class: "row-label", text: "HZ" }), box]) },
      ]);
    });
  chip.classList.add("poll-chip");
  if (hzOf() !== undefined) chip.classList.add("on");
  bindFlag(instance.id + ":poll." + spec.name + ".on", chip, "on",
           () => hzOf() !== undefined);
  return chip;
}

/* THE CASES DISCLOSURE moved to casesrow.ts wholesale: the attr rows
 * (components.ts) carry it now too, and one module serves both. */

