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
import { MenuItem, openMenu } from "../menu.js";
import { PartNode, ownedSlots, partIndex, slotLeaf } from "../parts.js";
import { bindField, bindText } from "../reconcile.js";
import { authoredSlot, editedSlot, fedSlots, runtimeSlots, slotCell, typeOf, withSlot } from "../slots.js";
import { ComponentDef, Json, SlotSpec, Widget, WidgetType } from "../types.js";

import { componentInspectorShape, renderComponentInspector } from "./components.js";
import { valueEditor } from "./editors.js";
import { feedCard, feedShape } from "./feeds.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { newVariable, varCard, varShape } from "./vars.js";

/* ---- left sidebar: the Layers tree (the CURRENT page's widgets; pages live in the
 * topbar selector), then Components. Globals live in the Data workspace. ---- */

/* The tree's expansion state: module-persistent, keyed "w<id>", "w<id>/<part path>",
 * "c<id>...". Defaults: part boxes open, widgets closed. A toggle bumps the revision,
 * which rides the shape string: expansion decides which rows EXIST, unlike a section
 * fold, which only hides standing rows. */
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

/* a doc component's part tree as structure (names are bound values; ids, kinds and
 * nesting decide which rows exist) */
function docPartShape(part: Json): Json {
  return [part?.id, part?.kind, part?.dir ?? "",
          ((part?.children ?? []) as Json[]).map(docPartShape)];
}

/* every finding under a component subtree, flattened: they pin marks on tree rows */
function componentDiagShape(editor: Editor, comp: ComponentDef): string[] {
  const out: string[] = [];
  const add = (id: number) => {
    for (const d of editor.diagNode(id))
      out.push(id + ":" + (d.where ?? "") + ":" + d.code + ":" + d.message);
  };
  add(comp.id);
  for (const prop of comp.props ?? []) add(prop.id);
  const walk = (part: Json): void => {
    if (typeof part?.id === "number") add(part.id);
    for (const prop of (part?.props ?? []) as Json[]) add(prop.id);
    for (const child of (part?.children ?? []) as Json[]) walk(child);
  };
  for (const part of comp.parts ?? []) walk(part);
  return out;
}

export function leftShape(editor: Editor): string {
  const page = editor.page();
  const comps = editor.store.components();
  const shadowed = new Set(comps.map((c) => c.name));
  const builtinNames = new Set(editor.builtins.map((b: Json) => b?.name));
  return JSON.stringify({
    /* the CURRENT page's widgets only: pages live in the topbar selector */
    page: page ? page.id : 0,
    widgets: (page?.widgets ?? []).map((w) => [w.id, w.type]),
    /* the tree highlights the selection and lists rows per expansion state */
    selection: editor.view.selection,
    part: editor.view.part,
    /* a switched-off part wears a different icon and a dimmed row, so which parts are
       hidden decides what the rows ARE */
    hidden: (page?.widgets ?? []).flatMap((w) => {
      const type = typeOf(editor.registry, w.type);
      return (type?.slots ?? [])
        .filter((s) => s.name.endsWith(".shown") && authoredSlot(w, type, s.name) === false)
        .map((s) => w.id + ":" + s.name);
    }),
    fold: layerRevision,
    /* the Components tree: the doc components (their part trees are rows), the
       unshadowed built-ins (browsable, forkable), and the component selection */
    components: comps.map((c) => [c.id, builtinNames.has(c.name),
                                  (c.parts ?? []).map(docPartShape)]),
    builtins: editor.builtins.map((b: Json) => b?.name).filter((n: Json) => !shadowed.has(n)),
    componentSel: editor.componentSel
      ? [editor.componentSel.component, editor.componentSel.node]
      : null,
    builtinSel: editor.builtinSel ? [editor.builtinSel.name, editor.builtinSel.path] : null,
    cdiag: comps.flatMap((c) => componentDiagShape(editor, c)),
    /* findings pin icons on rows and cards, so their coming and going is structure */
    wdiag: (page?.widgets ?? []).flatMap((w) =>
      editor.diagFor(w.id).map((d) => w.id + ":" + d.code + ":" + d.message),
    ),
  });
}

export function renderLeftSidebar(host: HTMLElement, editor: Editor): void {
  clear(host);
  const widgets = editor.page()?.widgets ?? [];

  host.append(
    ...section("layers", "Layers", String(widgets.length), () => [
      el("div", { class: "layers" }, widgets.flatMap((w) => widgetRows(editor, w))),
      widgets.length ? null : el("p", { class: "empty", text: "no widgets on this page" }),
    ]),
  );

  host.append(...componentSection(editor));
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

/* widgets -> the widget's template part tree (the page level lives in the topbar) */
function widgetRows(editor: Editor, widget: Widget): HTMLElement[] {
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
    0,
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
    () => editor.select([widget.id]),
  );
  const rows = [row];
  if (open) for (const part of parts) rows.push(...partRows(editor, widget, part, 1));
  return rows;
}

/* draw-kind glyphs: one mono mark per box direction / part draw */
const PART_GLYPH: Record<string, string> = {
  row: "→", col: "↓", stack: "▤", auto: "⇆",
  rect: "▭", bar: "▮", text: "T", icon: "✦",
  arc: "◠", needle: "↗", plot: "∿", path: "◇", code: "λ",
};

function partRows(
  editor: Editor,
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
  /* every part carries its own `shown` switch (spec 2.3), so the tree can turn one off
     where you are already looking at it; a span, not a button, inside the row's button */
  const type = typeOf(editor.registry, widget.type);
  const address = node.path + ".shown";
  const switchable = (type?.slots ?? []).some((s) => s.name === address);
  const on = !switchable || authoredSlot(widget, type, address) !== false;
  const eye = el("span", {
    class: "icon-btn layer-eye" + (on ? "" : " off"),
    title: on ? "hide " + node.name : "show " + node.name,
    html: iconMarkup(on ? "eye" : "eye-off", 11),
  });
  eye.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const at = editor.store.widget(widget.id) ?? widget;
    editor.apply([{ op: "set_prop", node: widget.id, key: "slots",
                    value: withSlot(at.slots, address, !on) }]);
  });
  const row = treeRow(
    key,
    depth,
    "part" + (current ? " current" : "") + (on ? "" : " hidden"),
    node.children.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [
      el("span", { class: "layer-glyph draw", text: PART_GLYPH[node.kind] ?? "·" }),
      el("span", { class: "layer-label", text: node.name }),
      switchable ? eye : null,
    ],
    () => editor.selectPart(widget.id, node.path),
    node.path + " (" + node.kind + ")",
  );
  const rows = [row];
  if (open)
    for (const child of node.children)
      rows.push(...partRows(editor, widget, child, depth + 1));
  return rows;
}

/* ---- the Components section: doc components (editable), then the unshadowed
 * built-ins (browsable, forkable). Same tree idiom as Layers; a doc component that
 * shadows a built-in wears the accent, a built-in row is dimmed and read-only. ---- */

function componentSection(editor: Editor): HTMLElement[] {
  const comps = editor.store.components();
  const shadowed = new Set(comps.map((c) => c.name));
  const builtinNames = new Set(editor.builtins.map((b: Json) => b?.name));
  const unshadowed = editor.builtins.filter((b: Json) => b?.name && !shadowed.has(b.name));
  return section("components", "Components", String(comps.length), () => [
    el("div", { class: "layers" }, [
      ...comps.flatMap((c) => docComponentRows(editor, c, builtinNames.has(c.name))),
      ...unshadowed.flatMap((b: Json) => builtinComponentRows(editor, b)),
    ]),
    el("button", {
      class: "dashed-btn",
      text: "+ Component",
      onclick: () => editor.addComponent(),
    }),
  ]);
}

/* the row-level verb menu (spec 2.3 Forking): every doc/built-in component row gets
 * one kebab opening the menu.ts context menu at the click point, so all of a row's
 * verbs are one gesture away without crowding the row with icons — the row itself
 * stays a single click to SELECT. */
function componentMenuButton(name: string, items: () => MenuItem[]): HTMLElement {
  const btn = el("span", {
    class: "icon-btn layer-menu",
    title: "duplicate, override or revert " + name,
    html: iconMarkup("ellipsis-vertical", 12),
  });
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const at = (btn as HTMLElement).getBoundingClientRect();
    openMenu(at.left, at.bottom + 4, name, items());
  });
  return btn;
}

/* a doc component's own verbs: "Duplicate as…" always (it may itself be duplicated
 * again), then EITHER "Revert to built-in" — only where it actually shadows one,
 * since that is what restores the built-in — or an ordinary "Delete" otherwise,
 * deleting a component with no built-in behind it just destroys it (spec: the
 * component that shadows nothing has nothing to "revert" to). Both destructive
 * verbs read danger-styled, the menu's own confirm idiom (menu.ts). */
function docComponentMenu(editor: Editor, comp: ComponentDef, shadows: boolean): MenuItem[] {
  /* read the live name rather than the render-time `comp`: a rename does not change
     the row's SHAPE (2.3/panel split), so this closure can outlive it */
  const liveName = () => ((editor.store.node(comp.id) as Json)?.name as string) ?? comp.name;
  const items: MenuItem[] = [
    { label: "Duplicate as…", icon: "copy", run: () => editor.duplicateComponent(liveName()) },
  ];
  items.push(
    shadows
      ? { label: "Revert to built-in", icon: "rotate-ccw", danger: true,
          run: () => editor.apply([{ op: "remove", node: comp.id }]) }
      : { label: "Delete", icon: "trash", danger: true,
          run: () => editor.apply([{ op: "remove", node: comp.id }]) },
  );
  return items;
}

function docComponentRows(editor: Editor, comp: ComponentDef, shadows: boolean): HTMLElement[] {
  const key = "c" + comp.id;
  const open = layerOpen(key, false);
  const parts = comp.parts ?? [];
  const label = el("span", { class: "layer-label" + (shadows ? " shadows" : "") });
  bindText(comp.id + ":name.layer", label, () =>
    (editor.store.node(comp.id) as Json)?.name ?? "");
  const row = treeRow(
    key,
    0,
    "component" + (editor.componentSel?.node === comp.id ? " current" : ""),
    parts.length ? { open, toggle: () => toggleLayer(editor, key, false) } : null,
    [
      el("span", {
        class: "layer-glyph",
        html: iconMarkup(ICONS[comp.name] ? comp.name : "layers", 11, 1.7),
      }),
      label,
      diagIcon(editor.diagNode(comp.id)),
      /* legible in the row itself, not only the tooltip below: which types are
         customized should read from the list alone */
      shadows ? el("span", { class: "badge shadow", text: "override" }) : null,
      componentMenuButton(comp.name, () => docComponentMenu(editor, comp, shadows)),
    ],
    () => editor.selectComponent(comp.id, comp.id),
    shadows ? "overrides built-in" : comp.name,
  );
  const rows = [row];
  if (open) for (const part of parts) rows.push(...docPartTreeRows(editor, comp, part, 1));
  return rows;
}

function docPartTreeRows(editor: Editor, comp: ComponentDef, part: Json, depth: number): HTMLElement[] {
  const key = "c" + comp.id + "/" + part.id;
  const open = layerOpen(key, true);
  const children = (part.children ?? []) as Json[];
  const glyph = PART_GLYPH[part.kind === "box" ? (part.dir ?? "stack") : part.kind] ?? "·";
  const label = el("span", { class: "layer-label" });
  bindText(part.id + ":name.layer", label, () =>
    (editor.store.node(part.id) as Json)?.name ?? "");
  const row = treeRow(
    key,
    depth,
    "part" + (editor.componentSel?.node === part.id ? " current" : ""),
    children.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [el("span", { class: "layer-glyph draw", text: glyph }), label,
     diagIcon(editor.diagNode(part.id))],
    () => editor.selectComponent(comp.id, part.id),
    part.name + " (" + part.kind + ")",
  );
  const rows = [row];
  if (open)
    for (const child of children) rows.push(...docPartTreeRows(editor, comp, child, depth + 1));
  return rows;
}

/* a built-in's own two verbs: "Override <Name>" shadows it under its own name (every
 * existing instance follows automatically), "Duplicate as…" copies it under a fresh
 * name instead, leaving the built-in and its instances alone — the verb the fork icon
 * alone could not say. The built-ins are snapshot-only (spec: never change at runtime),
 * so closing over `name` here is safe unlike the doc component menu above. */
function builtinComponentMenu(editor: Editor, name: string): MenuItem[] {
  return [
    { label: "Override " + name, icon: "git-branch", run: () => editor.forkBuiltin(name) },
    { label: "Duplicate as…", icon: "copy", run: () => editor.duplicateComponent(name) },
  ];
}

/* A built-in row SELECTS, exactly as a doc component's does; what differs is only what
 * the inspector then shows (the definition, read-only) and how the row is addressed:
 * a built-in is not in the document, so there is no node id to name it by and the
 * address is its name plus a CHILD-INDEX PATH into its parts. */
function builtinComponentRows(editor: Editor, comp: Json): HTMLElement[] {
  const name = String(comp?.name ?? "");
  const key = "b:" + name;
  const open = layerOpen(key, false);
  const parts = Array.isArray(comp?.parts) ? (comp.parts as Json[]) : [];
  const current = editor.builtinSel?.name === name && !editor.builtinSel.path;
  const row = treeRow(
    key,
    0,
    "component builtin" + (current ? " current" : ""),
    parts.length ? { open, toggle: () => toggleLayer(editor, key, false) } : null,
    [
      el("span", {
        class: "layer-glyph",
        html: iconMarkup(ICONS[name] ? name : "layers", 11, 1.7),
      }),
      el("span", { class: "layer-label", text: name }),
      componentMenuButton(name, () => builtinComponentMenu(editor, name)),
    ],
    () => editor.selectBuiltin(name, ""),
    name + " (built-in, read-only)",
  );
  const rows = [row];
  if (open)
    parts.forEach((part, i) =>
      rows.push(...builtinPartRows(editor, name, String(i), part, 1)));
  return rows;
}

function builtinPartRows(
  editor: Editor,
  comp: string,
  path: string,
  part: Json,
  depth: number,
): HTMLElement[] {
  const name = String(part?.name ?? "");
  const key = "b:" + comp + "/" + path;
  const open = layerOpen(key, true);
  const children = Array.isArray(part?.children) ? (part.children as Json[]) : [];
  const glyph = PART_GLYPH[part?.kind === "box" ? (part?.dir ?? "stack") : part?.kind] ?? "·";
  const current = editor.builtinSel?.name === comp && editor.builtinSel.path === path;
  const row = treeRow(
    key,
    depth,
    "part builtin" + (current ? " current" : ""),
    children.length ? { open, toggle: () => toggleLayer(editor, key, true) } : null,
    [el("span", { class: "layer-glyph draw", text: glyph }),
     el("span", { class: "layer-label", text: name || "(unnamed)" })],
    () => editor.selectBuiltin(comp, path),
    name + " (" + part?.kind + ", read-only)",
  );
  const rows = [row];
  if (open)
    children.forEach((child, i) =>
      rows.push(...builtinPartRows(editor, comp, path + "." + i, child, depth + 1)));
  return rows;
}

/* ---- inspector ---- */

/* the selected part, but only when this type can actually name it; anything else (a
 * stale path, an unknown type) falls back to the widget view */
function selectedPart(editor: Editor, type: WidgetType | null): string {
  const path = editor.view.part;
  return path && type && partIndex(type).byPath.has(path) ? path : "";
}

export function inspectorShape(editor: Editor): string {
  /* a component selection owns the inspector; it and the widget selection are
     mutually exclusive by construction (each clears the other) */
  const component = componentInspectorShape(editor);
  if (component) return component;
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
  if (componentInspectorShape(editor)) {
    renderComponentInspector(host, editor);
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

