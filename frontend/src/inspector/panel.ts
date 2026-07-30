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

import { clear, commitInput, el, iconButton, numberInput } from "../dom.js";
import { diagIcon, Editor, section } from "../editor.js";
import { ICONS, iconMarkup } from "../icons.js";
import { PartNode, partIndex, subtreeSlots } from "../parts.js";
import { bindField, bindText } from "../reconcile.js";
import { authoredSlot, editedSlot, fedSlots, runtimeSlots, slotCell, typeOf } from "../slots.js";
import { Json, Page, SlotSpec, Widget, WidgetType } from "../types.js";

import { valueEditor } from "./editors.js";
import { feedCard, feedShape } from "./feeds.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { newVariable, varCard, varShape } from "./vars.js";

/* ---- left sidebar: the Layers tree, then the globals ---- */

/* The tree's expansion state: module-persistent, keyed "p<id>", "w<id>",
 * "w<id>/<part path>". Defaults: pages and part boxes open, widgets closed. A toggle
 * bumps the revision, which rides the shape string: expansion decides which rows EXIST,
 * unlike a section fold, which only hides standing rows. */
const layerFold = new Map<string, boolean>();
let layerRevision = 0;

function layerOpen(key: string, dflt: boolean): boolean {
  return layerFold.get(key) ?? dflt;
}

function toggleLayer(editor: Editor, key: string, dflt: boolean): void {
  layerFold.set(key, !layerOpen(key, dflt));
  layerRevision++;
  editor.refresh();
}

export function leftShape(editor: Editor): string {
  const page = editor.page();
  return JSON.stringify({
    pages: editor.store.pages().map((p) => [p.id, (p.widgets ?? []).map((w) => [w.id, w.type])]),
    current: page ? page.id : 0,
    /* the tree highlights the selection and lists rows per expansion state */
    selection: editor.view.selection,
    part: editor.view.part,
    fold: layerRevision,
    globals: editor.store.globals().map(varShape),
    /* findings pin icons on rows and cards, so their coming and going is structure */
    wdiag: editor.store.pages().flatMap((p) =>
      (p.widgets ?? []).flatMap((w) =>
        editor.diagFor(w.id).map((d) => w.id + ":" + d.code + ":" + d.message),
      ),
    ),
    diag: editor.store.globals().flatMap((v) =>
      editor
        .diagAt(v.id)
        .concat(editor.diagAt(v.id, "init"))
        .map((d) => v.id + ":" + d.code + ":" + d.message),
    ),
  });
}

export function renderLeftSidebar(host: HTMLElement, editor: Editor): void {
  clear(host);
  const store = editor.store;
  const page = editor.page();

  host.append(
    ...section("layers", "Layers", String(store.pages().length), () => [
      el("div", { class: "layers" }, store.pages().flatMap((p) => pageRows(editor, p))),
      page ? pageNameRow(editor, page) : null,
      el("button", {
        class: "dashed-btn",
        text: "+ Page",
        onclick: () =>
          editor.apply([{ op: "insert", parent: 0, list: "pages", node: { name: "Page" } }]),
      }),
    ]),
  );

  host.append(
    ...section("globals", "Global Variables", String(store.globals().length), () => [
      ...store.globals().map((variable) => varCard(editor, variable, "global")),
      store.globals().length ? null : el("p", { class: "empty", text: "no globals yet" }),
      el("button", {
        class: "dashed-btn",
        text: "+ Variable",
        onclick: () => newVariable(editor, 0, "globals", store.globals()),
      }),
    ]),
  );
}

/* one tree row: indent, a caret when it expands, then the caller's cells. The caret owns
 * its own click, so a fold never changes the selection. */
function treeRow(
  key: string,
  depth: number,
  cls: string,
  fold: { open: boolean; toggle: () => void } | null,
  kids: (HTMLElement | null)[],
  onclick: () => void,
  title?: string,
): HTMLElement {
  const caret = el("span", {
    class: "layer-caret",
    html: fold ? iconMarkup("chevron-down", 9, 2) : "",
    style: fold && !fold.open ? "transform:rotate(-90deg)" : "",
  });
  if (fold)
    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fold.toggle();
    });
  return el(
    "button",
    {
      class: "layer-row " + cls,
      "data-key": key,
      style: "padding-left:" + (4 + depth * 12) + "px",
      title,
      onclick,
    },
    [caret, ...kids],
  );
}

/* pages -> widgets -> the widget's template part tree */
function pageRows(editor: Editor, page: Page): HTMLElement[] {
  const key = "p" + page.id;
  const open = layerOpen(key, true);
  const widgets = page.widgets ?? [];
  const label = el("span", { class: "layer-label" });
  bindText(page.id + ":name.layer", label, () => editor.store.page(page.id)?.name ?? "");
  const row = treeRow(
    key,
    0,
    "page" + (editor.page()?.id === page.id ? " here" : ""),
    widgets.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [label, el("span", { class: "badge", text: String(widgets.length) })],
    () => editor.setPage(page.id),
  );
  const rows = [row];
  if (open) for (const widget of widgets) rows.push(...widgetRows(editor, page, widget));
  return rows;
}

function widgetRows(editor: Editor, page: Page, widget: Widget): HTMLElement[] {
  const key = "w" + widget.id;
  const type = typeOf(editor.registry, widget.type);
  const parts = type ? partIndex(type).roots : [];
  const open = layerOpen(key, false);
  const cls =
    "widget" +
    (editor.view.selection.indexOf(widget.id) >= 0 && !editor.view.part ? " current" : "");
  const label = el("span", { class: "layer-label" });
  bindText(widget.id + ":label.layer", label, () => {
    const at = editor.store.widget(widget.id);
    return at ? at.label || at.type : "";
  });
  const row = treeRow(
    key,
    1,
    cls,
    parts.length ? { open, toggle: () => toggleLayer(editor, key, false) } : null,
    [
      el("span", {
        class: "layer-glyph",
        html: iconMarkup(ICONS[widget.type] ? widget.type : "layers", 11, 1.7),
      }),
      label,
      diagIcon(editor.diagFor(widget.id)),
    ],
    () => {
      if (editor.page()?.id !== page.id) editor.setPage(page.id);
      editor.select([widget.id]);
    },
  );
  const rows = [row];
  if (open) for (const part of parts) rows.push(...partRows(editor, page, widget, part, 2));
  return rows;
}

/* draw-kind glyphs: one mono mark per box direction / part draw */
const PART_GLYPH: Record<string, string> = {
  row: "→", col: "↓", stack: "▤", auto: "⇆",
  rect: "▭", bar: "▮", text: "T", icon: "✦",
  arc: "◠", needle: "↗", mark: "●", ticks: "‖", plot: "∿",
};

function partRows(
  editor: Editor,
  page: Page,
  widget: Widget,
  node: PartNode,
  depth: number,
): HTMLElement[] {
  const key = "w" + widget.id + "/" + node.path;
  const open = layerOpen(key, true);
  const current =
    editor.view.selection.length === 1 &&
    editor.view.selection[0] === widget.id &&
    editor.view.part === node.path;
  const row = treeRow(
    key,
    depth,
    "part" + (current ? " current" : ""),
    node.children.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [
      el("span", { class: "layer-glyph draw", text: PART_GLYPH[node.kind] ?? "·" }),
      el("span", { class: "layer-label", text: node.name }),
    ],
    () => {
      if (editor.page()?.id !== page.id) editor.setPage(page.id);
      editor.selectPart(widget.id, node.path);
    },
    node.path + " (" + node.kind + ")",
  );
  const rows = [row];
  if (open)
    for (const child of node.children)
      rows.push(...partRows(editor, page, widget, child, depth + 1));
  return rows;
}

function pageNameRow(editor: Editor, page: Page): HTMLElement {
  const at = () => editor.store.page(page.id);
  const name = commitInput(
    page.name,
    (text) => editor.apply([{ op: "set_prop", node: page.id, key: "name", value: text }]),
    { class: "field grow" },
  );
  bindField(page.id + ":name", name, () => at()?.name ?? "");
  return el("div", { class: "row" }, [
    el("span", { class: "row-label", text: "NAME" }),
    name,
    editor.store.pages().length > 1
      ? iconButton("trash", "remove this page", () =>
          editor.apply([{ op: "remove", node: page.id }]),
        )
      : null,
  ]);
}

/* ---- inspector ---- */

/* the selected part, but only when this type can actually name it; anything else (a
 * stale path, an unknown type) falls back to the widget view */
function selectedPart(editor: Editor, type: WidgetType | null): string {
  const path = editor.view.part;
  return path && type && partIndex(type).byPath.has(path) ? path : "";
}

export function inspectorShape(editor: Editor): string {
  const widget = editor.selectedWidget();
  if (!widget) return "empty";
  const type = typeOf(editor.registry, widget.type);
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
  const widget = editor.selectedWidget();
  if (!widget) {
    host.appendChild(
      el("div", { class: "inspector-head" }, [
        el("span", { class: "type", text: "nothing selected" }),
      ]),
    );
    host.appendChild(
      el("div", { class: "inspector-body" }, [
        el("p", { class: "empty", text: "pick a widget on the artboard" }),
      ]),
    );
    return;
  }

  const at = () => editor.store.widget(widget.id) ?? widget;
  const type = typeOf(editor.registry, widget.type);
  const part = selectedPart(editor, type);
  if (part && type) {
    renderPartInspector(host, editor, widget, type, part);
    return;
  }
  const fed = fedSlots(widget);
  const feeds = widget.feeds ?? [];
  const valueSlots = (type?.slots ?? []).filter((s) => s.group === "value");
  const otherSlots = (type?.slots ?? []).filter((s) => s.group !== "value");

  const label = commitInput(
    widget.label,
    (text) => editor.apply([{ op: "set_prop", node: widget.id, key: "label", value: text }]),
    { class: "field title", title: "the widget's label" },
  );
  bindField(widget.id + ":label", label, () => at().label ?? "");
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
   *    island merge, surface, border, radius, paddings, aspect). Separated from
   *    Appearance so the panel's dressing never mixes with the control's own. */
  body.append(
    ...section("panel", "Panel", null, () => [
      /* placement shares the slots' grid so its row sits on the same rhythm */
      el("div", { class: "prop-grid" }, [
        el("label", { text: "Place" }),
        geomRow(editor, widget),
        el("span"),
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

function slotRank(name: string): number {
  const at = SLOT_ORDER.indexOf(name);
  return at < 0 ? SLOT_ORDER.length : at;
}

/* The part-scoped inspector: the head reads widget › part (the widget's name is the way
 * back), and ONE section lists exactly the slots the part's subtree consumes — value
 * slots included, and the frame slots only when the subtree actually reads them (it
 * mostly will not: the frame is painted by the canvas, not the template). Behavior,
 * variables and placement belong to the widget view. Slot rows come from the same
 * slotCells with the same keys, so text half-typed in the widget view survives here. */
function renderPartInspector(
  host: HTMLElement,
  editor: Editor,
  widget: Widget,
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
    return at ? at.label || at.type : "";
  });
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      back,
      el("span", { class: "part-sep", text: "›" }),
      el("span", { class: "part-name", text: node.name, title: path }),
    ]),
  );

  const fed = fedSlots(widget);
  const consumed = new Set(subtreeSlots(type, path));
  const specs = (type.slots ?? [])
    .filter((spec) => consumed.has(spec.name))
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
        : el("p", { class: "empty", text: "this part consumes no properties" }),
    ]),
  );
}

function geomRow(editor: Editor, widget: Widget): HTMLElement {
  const at = () => editor.store.widget(widget.id) ?? widget;
  const field = (key: "x" | "y" | "w" | "h") => {
    const input = numberInput(Math.round(widget.geom[key]), (n) =>
      editor.apply([
        { op: "set_prop", node: widget.id, key: "geom", value: { ...at().geom, [key]: n } },
      ]),
    );
    /* a canvas drag lands here as four value pushes: the fields track the pointer and the
       one the user happens to be typing in is left alone */
    bindField(widget.id + ":geom." + key, input, () => String(Math.round(at().geom[key])));
    return input;
  };
  return el("div", { class: "geom-grid" }, [
    el("label", { text: "x" }),
    field("x"),
    el("label", { text: "y" }),
    field("y"),
    el("label", { text: "w" }),
    field("w"),
    el("label", { text: "h" }),
    field("h"),
  ]);
}

/* one Data-in row for a value slot, bound or not */
function slotRow(
  editor: Editor,
  widget: Widget,
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
  widget: Widget,
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
    const slots = { ...(at().slots ?? {}) };
    slots[spec.name] = next;
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
     out; it is on the label's tooltip for when the user wants to know. A finding about
     this slot's value sits right here on its label (spec 3.8). */
  const cells = [
    el("label", { text: spec.name, title: spec.name + ": " + spec.shape }, [
      diagIcon(editor.diagAt(widget.id, spec.name)),
    ]),
    control,
    link,
  ];
  if (bound && feed)
    cells.push(el("div", { class: "feed-below" }, [feedCard(editor, widget, type, feed)]));
  return cells;
}

