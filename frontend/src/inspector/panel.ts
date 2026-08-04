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
import { diagIcon, Editor, section } from "../editor.js";
import { ICONS, iconMarkup } from "../icons.js";
import { ownedSlots, partIndex, slotLeaf } from "../parts.js";
import { bindField, bindText } from "../reconcile.js";
import { authoredSlot, editedSlot, fedSlots, runtimeSlots, slotCell, typeOf, withSlot } from "../slots.js";
import { makeFold, treeRow } from "../tree.js";
import { ComponentDef, isInstance, Json, Node, PropDef, SlotSpec, TemplateNode,
         WidgetType } from "../types.js";

import { attrsSection, attrsShape, componentViewShape, interactSection, ownedShape,
         propsSection, renderBuiltinComponent, renderComponentView } from "./components.js";
import { valueEditor } from "./editors.js";
import { feedCard, feedShape } from "./feeds.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { newVariable, varCard, varShape } from "./vars.js";

/* ---- left sidebar: the Layers tree, which is PAGE COMPOSITION — every node of the
 * current page, one row per node, whatever it draws (pages live in the topbar selector;
 * globals live in Data).
 *
 * An INSTANCE is a leaf here even though it holds a whole tree: what is inside it belongs
 * to the component it names, which is a different thing with a different lifetime, edited
 * in the Design workspace (workspaces/design.ts). Unfolding it here would offer to edit
 * every placement at once while looking at one. ---- */

/* the Layers tree's own expansion state, independent of the Design tree's */
const fold = makeFold();

function layerOpen(key: string, dflt: boolean): boolean {
  return fold.open(key, dflt);
}

function toggleLayer(editor: Editor, key: string, dflt: boolean): void {
  fold.toggle(key, dflt, () => editor.refresh());
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
  const widgets = nodes.filter(isInstance);
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
    part: editor.view.part,
    /* a switched-off node wears a different icon and a dimmed row, so which ones are
       hidden decides what the rows ARE */
    hidden: widgets.flatMap((w) => {
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
    wdiag: widgets.flatMap((w) =>
      editor.diagFor(w.id).map((d) => w.id + ":" + d.code + ":" + d.message),
    ),
  });
}

/* ---- the breadcrumb strip: where the editor is standing ----
 *
 * Always over the tree: the page's name alone on a page, then one crumb per entered
 * widget. Every crumb but the last steps back OUT to that level. Inside a component the
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
      .flatMap((c) => readonlyRows(c, 0, "ro" + ctx.builtin));
    empty = "this component is its box alone";
  } else if (root) {
    rows = (root.children ?? []).flatMap((n) => nodeRows(editor, n, 0));
    if (ctx) empty = "this component is empty — right-click the artboard to add";
  }
  const tree = el("div", { class: "layers" }, rows);
  armTree(tree, editor);
  host.appendChild(tree);
  if (!rows.length) host.appendChild(el("p", { class: "empty", text: empty }));
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
 * rather than themselves, and editing them means entering the widget's own context
 * (which edits every placement at once, and will say so). Showing the whole tree while
 * fencing the selection is the difference between hiding structure and protecting it. */
function nodeRows(editor: Editor, node: Node, depth: number): HTMLElement[] {
  const key = "n" + node.id;
  const instance = isInstance(node);
  const kids = instance ? [] : node.children ?? [];
  const template = instance
    ? (typeOf(editor.registry, node.type ?? "")?.template?.children ?? [])
    : [];
  const open = layerOpen(key, true);
  const current =
    editor.view.selection.indexOf(node.id) >= 0 && (!editor.view.part || !instance);
  const label = el("span", { class: "layer-label" });
  bindText(node.id + ":label.layer", label, () => {
    const at = editor.store.nodeAt(node.id) ?? node;
    return at.name || at.type || at.kind;
  });
  const row = hoverable(editor, treeRow(
    key,
    depth,
    (instance ? "widget" : node.kind) + (current ? " current" : ""),
    kids.length || template.length
      ? { open, toggle: () => toggleLayer(editor, key, true) }
      : null,
    [
      el("span", { class: "layer-glyph", html: iconMarkup(glyphOf(node), 16, 1.5) }),
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
 * say it is being looked at rather than held. Double-clicking one ENTERS the widget and
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
      el("span", { class: "layer-glyph",
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
      el("span", { class: "layer-glyph",
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

    /* ENTER A WIDGET on a double press: an instance row from itself, a fenced `.tpl`
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
        editor.enterWidget(inst, fenced ? fenced[2] : undefined);
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
    toggleLayer(editor, "n" + id, true);
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
    const open = frame && layerOpen("n" + id, true);
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
  if (page && plan.parent !== page.id && !layerOpen("n" + plan.parent, true))
    toggleLayer(held.editor, "n" + plan.parent, true);
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

/* PART ROWS have left this tree. Layers is page composition — which frames and widgets
   sit where — and a widget's internals belong to the component that defines them, which
   is the Design workspace's tree, not this one. The per-part eye that hid one went with
   them; per-instance part visibility comes back as an instance-inspector concern, since
   that is what it always was: an override on one placement, not a fact about the page.

/* ---- inspector ---- */

/* the selected part, but only when this type can actually name it; anything else (a
 * stale path, an unknown type) falls back to the widget view */
function selectedPart(editor: Editor, type: WidgetType | null): string {
  const path = editor.view.part;
  return path && type && partIndex(type).byPath.has(path) ? path : "";
}

/* The CONTENT inspector, routed by WHAT THE NODE IS rather than by which of three kinds
   it used to be: an instance shows the component's own vocabulary (data in, behavior,
   locals, appearance), and any other node shows its name, its kind and its attrs. */
export function inspectorShape(editor: Editor): string {
  const node = editor.selectedNode();
  const ctx = editor.contexts[editor.contexts.length - 1];
  if (!node && ctx) {
    /* nothing selected inside an entered widget: the inspector stands on the
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
      /* inside a context the node's own declarations get sections of their own */
      own: ctx ? ownedShape(node) : null,
      diag: editor.diagNode(node.id).map((d) => (d.where ?? "") + ":" + d.code + ":" + d.message)
        .concat((node.props ?? []).flatMap((p) =>
          editor.diagNode(p.id).map((d) => p.id + ":" + d.code + ":" + d.message))),
    });
  const widget = node;
  const type = typeOf(editor.registry, widget.type ?? "");
  const fed = fedSlots(widget);
  const template = JSON.stringify(type?.template ?? null);
  return JSON.stringify({
    id: widget.id,
    type: widget.type,
    part: selectedPart(editor, type),
    slots: (type?.slots ?? []).map((s) => [
      s.name, s.shape, s.group, s.editor ?? "", (s.variants ?? []).join("|"),
    ]),
    fed: Array.from(fed).sort(),
    /* which slots read live decides what each field IS, so it is structure */
    runtime: Array.from(runtimeSlots(widget, type)).sort(),
    align: template.includes("slot:align"),
    textScale: template.includes("slot:text_scale"),
    /* the aspect slot decides whether align has anywhere to apply, so this one VALUE is
       genuinely structural; it is a boolean, and it moves only when an aspect is authored */
    aspect: String(authoredSlot(widget, type, "aspect") ?? "") !== "",
    feeds: (widget.feeds ?? []).map(feedShape),
    flows: (widget.flows ?? []).map(flowShape),
    locals: (widget.locals ?? []).map(varShape),
    diag: editor.diagFor(widget.id).map((d) => d.node + ":" + d.code + ":" + d.message),
  });
}

export function renderInspector(host: HTMLElement, editor: Editor): void {
  clear(host);
  const node = editor.selectedNode();
  if (node && !isInstance(node)) {
    renderNodeInspector(host, editor, node);
    return;
  }
  const widget = node;
  if (!widget) {
    /* inside an entered widget, nothing selected IS a selection: the component. The
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
        el("p", { class: "empty", text: "pick a widget on the page" }),
      ]),
    );
    return;
  }

  const at = () => editor.store.widget(widget.id) ?? widget;
  const type = typeOf(editor.registry, widget.type ?? "");
  const part = selectedPart(editor, type);
  if (part && type) {
    renderPartInspector(host, editor, widget, type, part);
    return;
  }
  const fed = fedSlots(widget);
  const feeds = widget.feeds ?? [];
  /* ONLY the widget's own properties: what a part declares is edited by
     selecting that part, and appears nowhere else. This is the whole point of parts
     owning properties — a Slider's inspector is its value, its range and its frame,
     not every colour of every shape inside it. */
  const own = ownedSlots(type, "");
  const valueSlots = own.filter((s) => s.group === "value");
  const otherSlots = own.filter((s) => s.group !== "value");

  const label = commitInput(
    widget.name,
    (text) => editor.apply([{ op: "set_prop", node: widget.id, key: "label", value: text }]),
    { class: "field title", title: "the widget's label" },
  );
  bindField(widget.id + ":label", label, () => at().name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      label,
      /* a finding that names the widget itself and no field within it (an unknown type,
         say) has no better row to sit on than the head */
      diagIcon(editor.diagAt(widget.id)),
    ]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  /* 1. Data in, and ONLY where the type takes values: what a widget consumes is its
   *    value-group slots, so a Button (which consumes nothing) shows no such section.
   *    A fed slot is a card, an unfed one a row with a bind button. */
  if (valueSlots.length)
    body.append(
      ...section("data-in", "Data in", String(feeds.length), () =>
        valueSlots.map((spec) => slotRow(editor, widget, type, fed, spec)),
      ),
    );

  /* 2. Behavior: what this instance authors. The type's built-in defaults (a Toggle
   *    toggles) are the control working as expected, not authored behavior, so they are
   *    not listed; authoring a flow on the same slot takes over automatically. */
  body.append(
    ...section("behavior", "Behavior", String((widget.flows ?? []).length), () => [
      ...(widget.flows ?? []).map((flow) => flowCard(editor, widget, type, flow)),
      (widget.flows ?? []).length
        ? null
        : el("p", { class: "empty", text: "no behavior yet" }),
      addFlowButton(editor, widget, type),
    ]),
  );

  /* 3. Local variables */
  body.append(
    ...section("locals", "Local Variables", String((widget.locals ?? []).length), () => [
      ...(widget.locals ?? []).map((variable) => varCard(editor, variable, "local")),
      el("button", {
        class: "dashed-btn",
        text: "+ Variable",
        onclick: () => newVariable(editor, widget.id, "locals", widget.locals ?? []),
      }),
    ]),
  );

  /* 4. Appearance: the CONTENT's properties (colors, text, per-type config). RELATED
   *    properties sit together, in ONE canonical order on every type (the semantic
   *    contract extended to position): colors, text, the control's own shape, range, the
   *    scale, options, sampling, then state. A name outside the table keeps its
   *    declaration order at the end. */
  body.append(
    ...section("appearance", "Appearance", String(fed.size), () => [
      el("div", { class: "prop-grid" }, [
        ...otherSlots
          .filter((s) => s.group === "appearance" || s.group === "config")
          .sort((a, b) => slotRank(a.name) - slotRank(b.name))
          .flatMap((spec) => slotCells(editor, widget, type, fed, spec)),
      ]),
    ]),
  );

  /* 5. Panel: the box around the content — the frame-group SLOTS the component declares
   *    (surface, border, radius, pad: bindable, which is what makes a bound surface a
   *    lamp), and then how this placement is placed.
   *
   *    PLACE IS ATTRS, not props: an instance is a node, and a node's fields are
   *    expression text, so these are the very same rows a plain frame gets and they go
   *    through the very same commit. There is no instance-shaped copy of them. */
  body.append(
    ...section("panel", "Panel", null, () => [
      el("div", { class: "prop-grid" }, [
        ...otherSlots
          .filter((s) => s.group === "frame")
          .flatMap((spec) => slotCells(editor, widget, type, fed, spec)),
      ]),
    ]),
  );
  body.append(...attrsSection(editor, widget));
}

/* the canonical property order (see the Appearance section): clusters of related names,
 * shared across every type so the same property is always found in the same place */
const SLOT_ORDER = [
  /* the node's own switch leads: whether it is drawn at all comes before how */
  "shown",
  /* the content colors */
  "fill_color", "track_color", "handle_color", "body_color",
  /* text */
  "text", "text_color", "text_size", "align",
  /* the control's own shape */
  "control_radius", "thickness", "start_angle", "sweep_angle",
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

/* ranked by the property's own name, not its address: `bar.fill_color` sorts as
   fill_color, so one part's rows read in the same order as any other's */
function slotRank(address: string): number {
  const at = SLOT_ORDER.indexOf(slotLeaf(address));
  return at < 0 ? SLOT_ORDER.length : at;
}

/* The part-scoped inspector: the head reads widget › part (the widget's name is the way
 * back), and ONE section lists exactly the properties THIS part owns — not its
 * children's, which have their own rows in the tree, and not the widget's, which are
 * one click up. Ownership is exclusive, so every property is editable in exactly one
 * place. Behavior, variables and placement belong to the widget view. */
function renderPartInspector(
  host: HTMLElement,
  editor: Editor,
  widget: Node,
  type: WidgetType,
  path: string,
): void {
  const node = partIndex(type).byPath.get(path)!;
  const back = el("button", {
    class: "part-back",
    title: "back to the widget",
    onclick: () => editor.select([widget.id]),
  });
  bindText(widget.id + ":label.part", back, () => {
    const at = editor.store.widget(widget.id);
    return at ? at.name || at.type || "" : "";
  });
  /* the whole path, not just the leaf: parts nest now (a knob's dot lives under its
     face), and "Knob › dot" would say nothing about where that dot actually is. Every
     ancestor is a step BACK to itself, so the head navigates as well as it reads. */
  const segments = path.split(".");
  const crumbs: (HTMLElement | null)[] = [back];
  segments.forEach((name, i) => {
    const upto = segments.slice(0, i + 1).join(".");
    const last = i === segments.length - 1;
    crumbs.push(el("span", { class: "part-sep", text: "›" }));
    crumbs.push(
      last
        ? el("span", { class: "part-name", text: name, title: path })
        : el("button", {
            class: "part-back",
            text: name,
            title: upto,
            onclick: () => editor.selectPart(widget.id, upto),
          }),
    );
  });
  host.appendChild(el("div", { class: "inspector-head" }, crumbs));

  const fed = fedSlots(widget);
  const specs = ownedSlots(type, path)
    .sort((a, b) => slotRank(a.name) - slotRank(b.name));
  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);
  body.append(
    ...section("part", node.name, String(specs.length), () => [
      specs.length
        ? el(
            "div",
            { class: "prop-grid" },
            specs.flatMap((spec) => slotCells(editor, widget, type, fed, spec)),
          )
        : el("p", {
            class: "empty",
            text: node.children.length
              ? "this part lays its children out; their properties are on them"
              : "this part has no properties of its own",
          }),
    ]),
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
  /* inside a component a node OWNS things a page node never does: the properties it
     declares (addressed under its name path) and the gesture it carries. The very
     sections the Design part view builds — same node, same rows. */
  if (editor.contexts.length)
    body.append(...propsSection(editor, node.id, "part-props",
                                () => (at().props ?? []) as PropDef[],
                                "no properties of its own"));
  body.append(...attrsSection(editor, node));
  if (editor.contexts.length) body.append(...interactSection(editor, node));
}

/* one Data-in row for a value slot, bound or not */
function slotRow(
  editor: Editor,
  widget: Node,
  type: ReturnType<typeof typeOf>,
  fed: Set<string>,
  spec: SlotSpec,
): HTMLElement {
  return el("div", { class: "prop-grid" }, slotCells(editor, widget, type, fed, spec));
}

/* a bound editor stays visible but inert: every control inside stops taking input */
function disableAll(node: HTMLElement): void {
  for (const inner of node.querySelectorAll("input, select, button"))
    (inner as HTMLInputElement).disabled = true;
}

/* label + editor + the bind chip: which property you are binding is answered by where
 * you are standing. A bound slot keeps its value editor, disabled, as a live
 * view of what the feed delivers (UNKNOWN until something arrives), and the feed's own
 * editor sits on a full-width row below it.
 *
 * Whether the slot is bound is STRUCTURE (it decides the chip, the disabling and the card
 * below); what it currently reads is VALUE, and goes into the editor built here. */
function slotCells(
  editor: Editor,
  widget: Node,
  type: ReturnType<typeof typeOf>,
  fed: Set<string>,
  spec: SlotSpec,
): HTMLElement[] {
  const bound = fed.has(spec.name);
  const runtime = runtimeSlots(widget, type);
  /* a slot the runtime writes but no feed owns: the field is live, and editable as the
     value the runtime starts from */
  const driven = !bound && runtime.has(spec.name);
  const at = () => editor.store.widget(widget.id) ?? widget;
  const read = () => editedSlot(at(), type, editor.live, runtime, spec.name);
  const commit = (next: Json) => {
    /* the address is the path into the instance's own nesting: a part's value is
       written under the part, beside nothing else the widget holds */
    const slots = withSlot(at().slots, spec.name, next);
    editor.apply([{ op: "set_prop", node: widget.id, key: "slots", value: slots }]);
  };
  const feed = (widget.feeds ?? []).find((f) => f.slot === spec.name);

  const control = el(
    "span",
    {
      class: "value-cell" + (bound ? " bound" : "") + (driven ? " driven" : ""),
      title: driven
        ? spec.name + " is written at runtime; this is the value it starts from"
        : undefined,
    },
    [valueEditor(spec, spec.shape, slotCell(widget, spec.name), read, commit, bound, editor)],
  );
  if (bound) disableAll(control);

  /* one link icon, two states: bound shows it lit and unbinds, unbound offers the feed */
  const link = bound
    ? iconButton("unlink", "unbind " + spec.name, () => {
        if (feed) editor.apply([{ op: "remove", node: feed.id }]);
      })
    : iconButton("link", "feed " + spec.name + " from the mesh", () =>
        editor.apply([
          {
            op: "insert",
            parent: widget.id,
            list: "feeds",
            node: { slot: spec.name, src: { kind: "V", name: "" }, path: "", xf: "" },
          },
        ]),
      );
  if (bound) link.classList.add("on");

  /* the shape is what the editor and the compiler enforce, so the row does not spell it
     out; it is on the label's tooltip for when the user wants to know, beside the
     property's full address (where you are standing already says which part owns it).
     A finding about this slot's value sits right here on its label. */
  const cells = [
    el("label", { text: slotLeaf(spec.name), title: spec.name + ": " + spec.shape }, [
      diagIcon(editor.diagAt(widget.id, spec.name)),
    ]),
    control,
    link,
  ];
  if (bound && feed)
    cells.push(el("div", { class: "feed-below" }, [feedCard(editor, widget, type, feed)]));
  return cells;
}

