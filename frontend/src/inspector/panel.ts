/* The two rails. Both are generated from the served tables: the section order is fixed
 * (spec 3.2), a slot's group decides whether its row lives in Data in or Appearance
 * (spec 3.3), and every editor comes from the slot's shape. */

import { clear, commitInput, el, iconButton, numberInput } from "../dom.js";
import { Editor, section } from "../editor.js";
import { fedSlots, resolveSlot, typeOf } from "../slots.js";
import { Json, SlotSpec, Widget } from "../types.js";
import { valueEditor } from "./editors.js";
import { feedCard } from "./feeds.js";
import { addFlowButton, flowCard } from "./flows.js";
import { newVariable, varCard } from "./vars.js";

export function renderLeftRail(host: HTMLElement, editor: Editor): void {
  clear(host);
  const store = editor.store;
  const page = editor.page();

  host.append(
    ...section("pages", "Pages", String(store.pages().length), () => [
      el(
        "div",
        { class: "pages" },
        store.pages().map((p) =>
          el("button", {
            class: "page-chip" + (page && p.id === page.id ? " on" : ""),
            text: p.name,
            onclick: () => editor.setPage(p.id),
          }),
        ),
      ),
      page
        ? el("div", { class: "row" }, [
            el("span", { class: "row-label", text: "NAME" }),
            commitInput(
              page.name,
              (name) => editor.apply([{ op: "set_prop", node: page.id, key: "name", value: name }]),
              { class: "field grow" },
            ),
            store.pages().length > 1
              ? iconButton("trash", "remove this page", () =>
                  editor.apply([{ op: "remove", node: page.id }]),
                )
              : null,
          ])
        : null,
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

  const type = typeOf(editor.registry, widget.type);
  const fed = fedSlots(widget);
  const feeds = widget.feeds ?? [];
  const valueSlots = (type?.slots ?? []).filter((s) => s.group === "value");
  const otherSlots = (type?.slots ?? []).filter((s) => s.group !== "value");

  host.appendChild(
    el("div", { class: "inspector-head" }, [
      commitInput(
        widget.label,
        (label) => editor.apply([{ op: "set_prop", node: widget.id, key: "label", value: label }]),
        { class: "field title", title: "the widget's label" },
      ),
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
      ...section("data-in", "Data in", String(feeds.length), () => {
        const rows: (HTMLElement | null)[] = [];
        for (const spec of valueSlots) {
          const feed = feeds.find((f) => f.slot === spec.name);
          rows.push(feed ? feedCard(editor, widget, type, feed) : slotRow(editor, widget, spec, false));
        }
        return rows;
      }),
    );

  /* 2. Behavior */
  body.append(
    ...section("behavior", "Behavior", String((widget.flows ?? []).length), () => [
      ...(widget.flows ?? []).map((flow) => flowCard(editor, widget, type, flow)),
      (widget.flows ?? []).length ? null : el("p", { class: "empty", text: "no behavior yet" }),
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

  /* 4. Appearance: placement, then every appearance and config slot */
  body.append(
    ...section("appearance", "Appearance", String(fedSlots(widget).size ? fed.size : 0), () => [
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
          .flatMap((spec) => slotCells(editor, widget, spec, fed.has(spec.name))),
      ),
    ]),
  );

  /* 5. Code: the generated view of what was built (read-only, spec 3.9) */
  body.append(
    ...section("code", "Code", null, () => [
      el("pre", { class: "code", text: codeFor(widget) }),
    ]),
  );
}

function geomRow(editor: Editor, widget: Widget): HTMLElement {
  const field = (key: "x" | "y" | "w" | "h") =>
    numberInput(Math.round(widget.geom[key]), (n) =>
      editor.apply([
        { op: "set_prop", node: widget.id, key: "geom", value: { ...widget.geom, [key]: n } },
      ]),
    );
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

/* one Data-in row for an unfed value slot */
function slotRow(editor: Editor, widget: Widget, spec: SlotSpec, bound: boolean): HTMLElement {
  return el("div", { class: "prop-grid" }, slotCells(editor, widget, spec, bound));
}

/* label + (editor or the feed sentence) + the bind chip: which property you are binding is
 * answered by where you are standing (spec 3.3) */
function slotCells(editor: Editor, widget: Widget, spec: SlotSpec, bound: boolean): HTMLElement[] {
  const type = typeOf(editor.registry, widget.type);
  const fed = fedSlots(widget);
  const value = resolveSlot(widget, type, editor.live, fed, spec.name);
  const commit = (next: Json) => {
    const slots = { ...(widget.slots ?? {}) };
    slots[spec.name] = next;
    editor.apply([{ op: "set_prop", node: widget.id, key: "slots", value: slots }]);
  };
  const feed = (widget.feeds ?? []).find((f) => f.slot === spec.name);

  const control = bound && feed
    ? feedCard(editor, widget, type, feed)
    : el("span", { class: "value-cell" }, [valueEditor(spec, spec.shape, value, commit)]);

  /* one link icon, two states: bound shows it lit and unbinds, unbound offers the feed */
  const bind = bound
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
  if (bound) bind.classList.add("on");

  /* the shape is what the editor and the compiler enforce, so the row does not spell it
     out; it is on the label's tooltip for when the user wants to know */
  return [el("label", { text: spec.name, title: spec.name + ": " + spec.shape }), control, bind];
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
