/* The two sidebars. Both are generated from the served tables: the section order is fixed
 * (spec 3.2), a slot's group decides whether its row lives in Data in or Appearance
 * (spec 3.3), and every editor comes from the slot's shape.
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
import { isInstance, Json, Node, SlotSpec, WidgetType } from "../types.js";

import { attrsSection, attrsShape } from "./components.js";
import { valueEditor } from "./editors.js";
import { feedCard, feedShape } from "./feeds.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { newVariable, varCard, varShape } from "./vars.js";

/* ---- left sidebar: the Layers tree, which is PAGE COMPOSITION — the current page's
 * widgets (pages live in the topbar selector). What is inside a component is a different
 * tree with a different lifetime and lives in the Design workspace
 * (workspaces/design.ts); globals live in Data. ---- */

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
  const page = editor.page();
  const nodes = flattenPage(page?.children ?? []);
  const widgets = nodes.filter(isInstance);
  return JSON.stringify({
    /* the CURRENT page's tree only: pages live in the topbar selector */
    page: page ? page.id : 0,
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
    /* findings pin icons on rows and cards, so their coming and going is structure */
    wdiag: widgets.flatMap((w) =>
      editor.diagFor(w.id).map((d) => w.id + ":" + d.code + ":" + d.message),
    ),
  });
}

export function renderLeftSidebar(host: HTMLElement, editor: Editor): void {
  clear(host);
  const children = editor.page()?.children ?? [];
  const count = flattenPage(children).length;
  const tree = el("div", { class: "layers" }, children.flatMap((n) => nodeRows(editor, n, 0)));
  armTree(tree, editor);

  host.append(
    ...section("layers", "Layers", String(count), () => [
      tree,
      children.length ? null : el("p", { class: "empty", text: "nothing on this page yet" }),
    ]),
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
 * as the fallback label; a plain frame shows its layout glyph; a leaf shows its kind's.
 * An instance's own subtree belongs to the component it names, so it is not listed here —
 * it is entered (double-click) rather than unfolded, which is the difference between
 * editing this placement and editing every placement at once. */
function nodeRows(editor: Editor, node: Node, depth: number): HTMLElement[] {
  const key = "n" + node.id;
  const instance = isInstance(node);
  const kids = instance ? [] : node.children ?? [];
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
    kids.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [
      el("span", { class: "layer-glyph", html: iconMarkup(glyphOf(node), 16, 1.5) }),
      label,
      diagIcon(instance ? editor.diagFor(node.id) : editor.diagAt(node.id)),
    ],
    () => editor.select([node.id]),
  ), node.id);
  const rows = [row];
  if (open) for (const child of kids) rows.push(...nodeRows(editor, child, depth + 1));
  return rows;
}

/* which icon stands for a node: its component's, its layout's, or its kind's */
function glyphOf(node: Node): string {
  if (isInstance(node)) return ICONS[node.type ?? ""] ? node.type ?? "" : "layers";
  if (node.kind === "frame") return "frame-" + (node.layout ?? "free");
  return "node-" + node.kind;
}

/* ---- dragging a row somewhere else: the only way to reparent (spec 2.8) ----
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
    const id = rowId(at?.closest?.("[data-key]") ?? null);
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

  const page = drag.editor.page();
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
  const plan = held.plan;
  if (!plan) {
    held.editor.previewMove(0, null);
    return;
  }
  /* the client always sends the whole placement, reparent or reorder: one path */
  held.editor.apply([
    { op: "move", node: held.id, parent: plan.parent, list: "children", index: plan.index },
  ]);
  held.editor.select([held.id]);
  /* dropped into a frame that was folded shut: open it, or it lands out of sight */
  const page = held.editor.page();
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
   locals, appearance), and any other node shows its name, its layout and its attrs. */
export function inspectorShape(editor: Editor): string {
  const node = editor.selectedNode();
  if (!node) return "empty";
  if (!isInstance(node))
    return JSON.stringify({
      node: node.id,
      kind: node.kind,
      layout: node.layout ?? "",
      attrs: attrsShape(editor, node),
      diag: editor.diagAt(node.id).map((d) => d.code + ":" + d.message),
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
  /* ONLY the widget's own properties (spec 2.3): what a part declares is edited by
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

  /* 4. Appearance: the CONTENT's properties (colors, text, per-type config). A slot the
   *    template consumes nowhere is hidden rather than shown dead: align also counts
   *    the aspect-locked content box it places, so it stays once an aspect is set.
   *    RELATED properties sit together, in ONE canonical order on every type (the
   *    semantic contract extended to position): colors, text, the control's own shape,
   *    range, the scale, options, sampling, then state. A name outside the table keeps
   *    its declaration order at the end. */
  const template = JSON.stringify(type?.template ?? null);
  const usesAlign = template.includes("slot:align");
  const usesTextScale = template.includes("slot:text_scale");
  const hasAspect = String(authoredSlot(widget, type, "aspect") ?? "") !== "";
  body.append(
    ...section("appearance", "Appearance", String(fed.size), () => [
      el("div", { class: "prop-grid" }, [
        ...otherSlots
          .filter((s) => s.group === "appearance" || s.group === "config")
          .filter((s) => s.name !== "align" || usesAlign || hasAspect)
          .filter((s) => s.name !== "text_scale" || usesTextScale)
          .sort((a, b) => slotRank(a.name) - slotRank(b.name))
          .flatMap((spec) => slotCells(editor, widget, type, fed, spec)),
      ]),
    ]),
  );

  /* 5. Panel: placement plus the shared frame vocabulary (the box around the content:
   *    surface, border, radius, paddings, aspect). Separated from Appearance so the
   *    panel's dressing never mixes with the control's own. The two PLACE rows lead:
   *    they are document props on the instance, like its label — how the containing
   *    frame gives it room — not slots the type declares, so they are written straight
   *    with set_prop and never through the slot machinery. */
  body.append(
    ...section("panel", "Panel", null, () => [
      placeGrid(editor, widget.id),
      el("div", { class: "prop-grid" }, [
        ...otherSlots
          .filter((s) => s.group === "frame")
          .flatMap((spec) => slotCells(editor, widget, type, fed, spec)),
      ]),
    ]),
  );
}

/* the canonical property order (see the Appearance section): clusters of related names,
 * shared across every type so the same property is always found in the same place */
const SLOT_ORDER = [
  /* the part's own switch leads: whether it is drawn at all comes before how */
  "shown",
  /* the content colors */
  "fill_color", "track_color", "handle_color", "body_color",
  /* text */
  "text", "text_color", "text_scale", "align",
  /* the control's own shape */
  "control_radius", "thickness", "start_angle", "sweep_angle", "fit",
  /* range + gesture */
  "min", "max", "step", "drag",
  /* the scale */
  "show_scale", "scale_values", "scale_position", "divisions", "decimals",
  /* options */
  "shown_options",
  /* sampling + smoothing (Trend) */
  "rate", "window", "autoscale", "kalman", "smoothing",
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

/* THE NODE INSPECTOR: a frame, a text, an icon or a path on the page — its name, what it
 * is, and its attrs. There is no hand-written field list any more: `attrsSection` (the
 * Design inspector's own) generates every row from the served vocabulary, so a page's
 * frame and a component's frame edit identically because they are the same node.
 *
 * What used to be three little sections of typed props — Layout, Surface, Place — is one
 * table now, and the split between "arrangement" and "measurement" is the parent's
 * layout, said once in the vocabulary rather than mirrored here. */
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

  /* the two structural facts, side by side: WHAT it is, and — for a frame — how it places
     what is inside it. Everything else is an expression in the table below. */
  const kindRow: (HTMLElement | null)[] = [
    el("label", { text: "kind" }),
    el("span", { class: "kw", text: node.kind }),
    el("span"),
  ];
  if (node.kind === "frame")
    kindRow.push(
      el("label", { text: "layout", title: "free places children by their own x/y/w/h" }),
      nodeField(editor, node.id, "layout", "enum", "free", ["free", "row", "col", "grid"]),
      el("span"),
    );
  body.append(
    ...section("node", "Node", null, () => [el("div", { class: "prop-grid" }, kindRow)]),
  );
  body.append(...attrsSection(editor, node));
}

/* One editor over one PROP of one document node — not a registry slot, so it is written
 * with set_prop like a name or a label, and never through the slot machinery. The frame
 * inspector is built entirely from these; the widget inspector borrows two. */
function nodeField(editor: Editor, node: number, key: string, shape: string, def: Json,
                   variants?: string[], step?: number): HTMLElement {
  const spec: SlotSpec = { name: key, shape, default: def, group: "config",
                           ...(variants ? { variants } : {}), ...(step ? { step } : {}) };
  const read = () => (editor.store.node(node) ?? {})[key];
  return valueEditor(spec, shape, node + ":" + key, read,
                     (v) => editor.apply([{ op: "set_prop", node, key, value: v }]),
                     false, editor);
}

/* PLACE: how the containing frame gives this node room. The pair sits on the CHILD — a
 * frame and a widget instance carry it identically — so one grid serves both inspectors. */
function placeGrid(editor: Editor, node: number): HTMLElement {
  return el("div", { class: "prop-grid" }, [
    el("label", { text: "grow", title: "share of the free space this takes; 0 = only its min" }),
    nodeField(editor, node, "grow", "num", 1), el("span"),
    el("label", { text: "min", title: "floor in pixels, on the container's main axis" }),
    nodeField(editor, node, "min", "num", 0), el("span"),
  ]);
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
 * you are standing (spec 3.3). A bound slot keeps its value editor, disabled, as a live
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
     A finding about this slot's value sits right here on its label (spec 3.8). */
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

