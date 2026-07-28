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
import { bindField, bindFlag, bindText } from "../reconcile.js";
import { authoredSlot, editedSlot, fedSlots, runtimeSlots, slotCell, typeOf } from "../slots.js";
import { Json, Page, SlotSpec, Widget } from "../types.js";

import { valueEditor } from "./editors.js";
import { feedCard, feedShape } from "./feeds.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { newVariable, varCard, varShape } from "./vars.js";

/* ---- left sidebar ---- */

export function leftShape(editor: Editor): string {
  const page = editor.page();
  return JSON.stringify({
    pages: editor.store.pages().map((p) => p.id),
    current: page ? page.id : 0,
    globals: editor.store.globals().map(varShape),
    /* a global's findings pin icons on its card, so their coming and going is structure */
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
    ...section("pages", "Pages", String(store.pages().length), () => [
      el(
        "div",
        { class: "pages" },
        store.pages().map((p) => pageChip(editor, p)),
      ),
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

/* the chip's name and its selected state both move without the chip being replaced, so
   picking a page never disturbs the list under the pointer */
function pageChip(editor: Editor, page: Page): HTMLElement {
  const at = () => editor.store.page(page.id);
  const chip = el("button", {
    class: "page-chip",
    onclick: () => editor.setPage(page.id),
  });
  bindText(page.id + ":name.chip", chip, () => at()?.name ?? "");
  bindFlag(page.id + ":current", chip, "on", () => editor.page()?.id === page.id);
  return chip;
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

export function inspectorShape(editor: Editor): string {
  const widget = editor.selectedWidget();
  if (!widget) return "empty";
  const type = typeOf(editor.registry, widget.type);
  const fed = fedSlots(widget);
  const template = JSON.stringify(type?.template ?? null);
  return JSON.stringify({
    id: widget.id,
    type: widget.type,
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
      el("span", { class: "type", text: widget.type.toUpperCase() + " · #" + widget.id }),
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

  /* 4. Appearance: placement, then every appearance and config slot. A slot the
   *    template consumes nowhere is hidden rather than shown dead: align also counts
   *    the aspect-locked content box it places, so it stays once an aspect is set. */
  const template = JSON.stringify(type?.template ?? null);
  const usesAlign = template.includes("slot:align");
  const usesTextScale = template.includes("slot:text_scale");
  const hasAspect = String(authoredSlot(widget, type, "aspect") ?? "") !== "";
  body.append(
    ...section("appearance", "Appearance", String(fed.size), () => [
      el("div", { class: "prop-grid" }, [
        el("label", { text: "Place" }),
        geomRow(editor, widget),
        el("span"),
      ]),
      el(
        "div",
        { class: "prop-grid" },
        otherSlots
          .filter((s) => s.group === "appearance")
          .concat(otherSlots.filter((s) => s.group === "config"))
          .filter((s) => s.name !== "align" || usesAlign || hasAspect)
          .filter((s) => s.name !== "text_scale" || usesTextScale)
          .flatMap((spec) => slotCells(editor, widget, type, fed, spec)),
      ),
    ]),
  );

  /* 5. Code: the generated view of what was built (read-only, spec 3.9) */
  const code = el("pre", { class: "code" });
  bindText(widget.id + ":code", code, () => codeFor(at()));
  body.append(...section("code", "Code", null, () => [code]));
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
    [valueEditor(spec, spec.shape, slotCell(widget, spec.name), read, commit, bound)],
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

/* The Code panel: a readable chained form of the same document, generated. It is a view,
 * never an input (spec 3.9). */
function codeFor(widget: Widget): string {
  const lines: string[] = [];
  const name = widget.label || widget.type.toLowerCase();
  for (const feed of widget.feeds ?? []) {
    const src = feed.src ?? { kind: "V", name: "" };
    const base =
      src.kind === "F"
        ? `poll(F("${src.name}"), ${feed.poll_hz ?? 1})`
        : `${src.kind}("${src.name}")`;
    const path = feed.path ? `${base}.at("${feed.path}")` : base;
    lines.push(`feed(${name}.${feed.slot}, ${path}${feed.xf ? `, x => ${feed.xf}` : ""});`);
  }
  for (const flow of widget.flows ?? []) {
    const when = (flow.when ?? [])
      .map((t: Json) => (t.kind === "timer" ? `timer("${t.var}")` : `${name}.${t.name}`))
      .join(", ");
    const entry = (flow.when ?? []).length > 1 ? `${flow.when_mode ?? "first"}(${when})` : when;
    let chain = `flow(${entry})`;
    for (const step of flow.do ?? []) {
      switch (step.kind) {
        case "transform": chain += `\n  .map(x => ${step.a})`; break;
        case "gate": chain += `\n  .gate(x => ${step.a})`; break;
        case "build": chain += `\n  .msg(${step.target?.kind}("${step.target?.name}"), { seed: "${step.seed}" })`; break;
        case "setf": chain += `\n  .field("${step.path}", x => ${step.a})`; break;
        case "send": chain += `\n  .${step.verb}(${step.buf || "x"})`; break;
        case "assign": chain += `\n  .set(L("${step.var}"), x => ${step.a})`; break;
        case "unforce": chain += `\n  .unforce(${step.target?.kind}("${step.target?.name}"))`; break;
        case "tmr_start": chain += `\n  .start("${step.timer}")`; break;
        case "tmr_cancel": chain += `\n  .cancel("${step.timer}")`; break;
        default: chain += `\n  .${step.kind}(${step.a})`;
      }
    }
    lines.push(chain + ";");
  }
  return lines.join("\n") || "// no sources or behavior on this widget";
}

