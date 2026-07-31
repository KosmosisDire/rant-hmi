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

import { clear, commitInput, el, iconButton } from "../dom.js";
import { diagIcon, Editor, section } from "../editor.js";
import { ICONS, iconMarkup } from "../icons.js";
import { ownedSlots, partIndex, slotLeaf } from "../parts.js";
import { bindField, bindText } from "../reconcile.js";
import { authoredSlot, editedSlot, fedSlots, runtimeSlots, slotCell, typeOf, withSlot } from "../slots.js";
import { makeFold, treeRow } from "../tree.js";
import { Frame, Json, SlotSpec, Widget, WidgetType } from "../types.js";

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

/* every node on the page, wherever it nests: a frame groups widgets and other frames in
   ONE ordered list (spec 2.8), so the Layers tree is a real hierarchy now, not a flat
   widget list. Pre-order, matching document (= z/flow) order. */
function flattenPage(children: (Frame | Widget)[]): (Frame | Widget)[] {
  const out: (Frame | Widget)[] = [];
  for (const node of children) {
    out.push(node);
    if (node.kind === "frame") out.push(...flattenPage(node.children));
  }
  return out;
}

export function leftShape(editor: Editor): string {
  const page = editor.page();
  const nodes = flattenPage(page?.children ?? []);
  const widgets = nodes.filter((n): n is Widget => n.kind === "widget");
  return JSON.stringify({
    /* the CURRENT page's tree only: pages live in the topbar selector */
    page: page ? page.id : 0,
    nodes: nodes.map((n) => [n.id, n.kind, n.kind === "widget" ? n.type : n.name]),
    /* the tree highlights the selection and lists rows per expansion state */
    selection: editor.view.selection,
    part: editor.view.part,
    /* a switched-off part wears a different icon and a dimmed row, so which parts are
       hidden decides what the rows ARE */
    hidden: widgets.flatMap((w) => {
      const type = typeOf(editor.registry, w.type);
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
  const count = flattenPage(children).filter((n) => n.kind === "widget").length;

  host.append(
    ...section("layers", "Layers", String(count), () => [
      el("div", { class: "layers" }, children.flatMap((n) => nodeRows(editor, n, 0))),
      children.length ? null : el("p", { class: "empty", text: "no widgets on this page" }),
    ]),
  );
}

function nodeRows(editor: Editor, node: Frame | Widget, depth: number): HTMLElement[] {
  return node.kind === "frame" ? frameRows(editor, node, depth) : widgetRows(editor, node, depth);
}

/* a frame row selects the frame (spec 2.8); its children are indented beneath it using
   the same fold/treeRow idiom a widget's part tree uses, so a group reads exactly like
   any other branch of the tree */
function frameRows(editor: Editor, frame: Frame, depth: number): HTMLElement[] {
  const key = "f" + frame.id;
  const open = layerOpen(key, true);   /* a frame opens by default: it exists to show structure */
  const current = editor.view.selection.length === 1 && editor.view.selection[0] === frame.id;
  const label = el("span", { class: "layer-label" });
  bindText(frame.id + ":label.layer", label, () => (editor.store.frame(frame.id) ?? frame).name);
  const row = treeRow(
    key,
    depth,
    "frame" + (current ? " current" : ""),
    frame.children.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [
      el("span", { class: "layer-glyph", html: iconMarkup("frame", 11, 1.7) }),
      label,
      diagIcon(editor.diagAt(frame.id)),
    ],
    () => editor.select([frame.id]),
  );
  const rows = [row];
  if (open) for (const child of frame.children) rows.push(...nodeRows(editor, child, depth + 1));
  return rows;
}

/* widgets -> the widget's template part tree (the page level lives in the topbar) */
function widgetRows(editor: Editor, widget: Widget, depth: number): HTMLElement[] {
  const key = "w" + widget.id;
  const cls =
    "widget" +
    (editor.view.selection.indexOf(widget.id) >= 0 && !editor.view.part ? " current" : "");
  const label = el("span", { class: "layer-label" });
  bindText(widget.id + ":label.layer", label, () => {
    const at = editor.store.widget(widget.id);
    return at ? at.label || at.type : "";
  });
  return [
    treeRow(
      key,
      depth,
      cls,
      null,
      [
        el("span", {
          class: "layer-glyph",
          html: iconMarkup(ICONS[widget.type] ? widget.type : "layers", 11, 1.7),
        }),
        label,
        diagIcon(editor.diagFor(widget.id)),
      ],
      () => editor.select([widget.id]),
    ),
  ];
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

/* The CONTENT inspector: a widget instance, one of its parts, or a selected FRAME
   (plain: name/layout/gap/pad/align, no feeds or behavior — a frame is pure
   composition). Editing a component itself belongs to the Design workspace and no
   longer routes through here. */
export function inspectorShape(editor: Editor): string {
  const frame = editor.selectedFrame();
  if (frame)
    return JSON.stringify({
      frame: frame.id,
      diag: editor.diagAt(frame.id).map((d) => d.code + ":" + d.message),
    });
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
  const frame = editor.selectedFrame();
  if (frame) {
    renderFrameInspector(host, editor, frame);
    return;
  }
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
  /* ONLY the widget's own properties (spec 2.3): what a part declares is edited by
     selecting that part, and appears nowhere else. This is the whole point of parts
     owning properties — a Slider's inspector is its value, its range and its frame,
     not every colour of every shape inside it. */
  const own = ownedSlots(type, "");
  const valueSlots = own.filter((s) => s.group === "value");
  const otherSlots = own.filter((s) => s.group !== "value");

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

/* The x/y/w/h grid that stood here is gone with the coordinate space it edited. A node's
   size and position stop being four numbers an author types and become a consequence of
   what the node sits in — order, grow, min, gap, pad — so the rows that replace it are
   ordinary schema rows on the frame, not a geometry pad. */

/* The frame inspector: plain and small on purpose — a frame is pure composition
 * (name, layout, gap, pad, align), never feeds or behavior. Every field reuses the
 * ordinary slot-shaped value editor (editors.ts) with a hand-built SlotSpec, exactly
 * the control a "config"-group widget property would get. */
function renderFrameInspector(host: HTMLElement, editor: Editor, frame: Frame): void {
  const at = () => editor.store.frame(frame.id) ?? frame;

  const name = commitInput(
    frame.name,
    (text) => editor.apply([{ op: "set_prop", node: frame.id, key: "name", value: text }]),
    { class: "field title", title: "the frame's name" },
  );
  bindField(frame.id + ":name", name, () => at().name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [name, diagIcon(editor.diagAt(frame.id))]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  const enumField = (key: "layout" | "align", variants: string[]) => {
    const spec: SlotSpec = { name: key, shape: "enum", default: variants[0], group: "config",
                             variants };
    return valueEditor(spec, "enum", frame.id + ":" + key, () => at()[key],
                       (v) => editor.apply([{ op: "set_prop", node: frame.id, key, value: v }]),
                       false, editor);
  };
  const numField = (key: "gap" | "pad") => {
    const spec: SlotSpec = { name: key, shape: "num", default: 0, group: "config" };
    return valueEditor(spec, "num", frame.id + ":" + key, () => at()[key],
                       (v) => editor.apply([{ op: "set_prop", node: frame.id, key, value: v }]),
                       false, editor);
  };

  /* `.prop-grid` is THREE columns (label, editor, trailing cell), so every row has to
     supply all three or the next row's label slides into this one's trailing slot and the
     pairs come apart — the same triple the widget inspector's slot rows emit. */
  body.append(
    ...section("frame", "Layout", null, () => [
      el("div", { class: "prop-grid" }, [
        el("label", { text: "layout" }), enumField("layout", ["none", "row", "col"]), el("span"),
        el("label", { text: "gap" }), numField("gap"), el("span"),
        el("label", { text: "pad" }), numField("pad"), el("span"),
        el("label", { text: "align" }),
        enumField("align", ["start", "center", "end", "stretch"]), el("span"),
      ]),
    ]),
  );
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

