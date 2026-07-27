/* The two rails: global state on the left, the selected widget's inspector on the right.
 * Both are generated from the served tables, never from a per-type branch: the section
 * order is fixed (spec 3.2), a slot's group decides where its row lives (spec 3.3), and
 * every editor comes from the slot's shape. Fold state is per view and never synced. */

import { clear, commitInput, el, numberInput, select } from "./dom.js";
import { ViewState } from "./canvas.js";
import { DocStore } from "./doc.js";
import { fedSlots, resolveSlot, typeOf } from "./slots.js";
import { Feed, Flow, Json, Live, Op, Page, Registry, SlotSpec, Var, Widget } from "./types.js";

/* what the rails need from the shell; App satisfies it structurally */
export interface Editor {
  store: DocStore;
  registry: Registry | null;
  live: Live | null;
  view: ViewState;
  page(): Page | null;
  selectedWidget(): Widget | null;
  apply(ops: Op[]): void;
  setPage(id: number): void;
  select(ids: number[]): void;
}

const folded = new Map<string, boolean>();

/* the header is the whole row, the caret rotates rather than swapping glyph, and the
 * open/closed state is remembered per section key across selection changes (spec 3.2) */
function section(key: string, title: string, badge: string | null, body: () => HTMLElement[]): HTMLElement {
  const open = !folded.get(key);
  const panel = el("div", { class: "section-body" }, body());
  if (!open) panel.style.display = "none";
  const head = el("button", { class: "section-head" }, [
    el("span", { class: "caret" }),
    el("span", { class: "section-title", text: title }),
    badge ? el("span", { class: "badge", text: badge }) : null,
  ]);
  if (open) head.classList.add("open");
  head.addEventListener("click", () => {
    const opening = panel.style.display === "none";
    panel.style.display = opening ? "" : "none";
    head.classList.toggle("open", opening);
    folded.set(key, !opening);
  });
  return el("div", { class: "section" }, [head, panel]);
}

/* ---- value editors, chosen by shape ---- */

function colorEditor(value: Json, commit: (v: Json) => void): HTMLElement {
  const hex = typeof value === "string" && value.startsWith("#") ? value : "#000000";
  const rgb = hex.slice(0, 7);
  return el("div", { class: "row-inline" }, [
    el("input", {
      class: "swatch",
      type: "color",
      value: rgb,
      onchange: (ev: Event) => commit((ev.target as HTMLInputElement).value + hex.slice(7)),
    }),
    commitInput(hex, (text) => commit(text), { class: "field mono" }),
  ]);
}

export function valueEditor(spec: SlotSpec | null, shape: string, value: Json, commit: (v: Json) => void): HTMLElement {
  switch (shape) {
    case "bool":
      return el("label", { class: "switch" }, [
        el("input", {
          type: "checkbox",
          checked: value === true,
          onchange: (ev: Event) => commit((ev.target as HTMLInputElement).checked),
        }),
        el("span", { class: "slider" }),
      ]);
    case "num":
      return numberInput(typeof value === "number" ? value : 0, (n) => commit(n));
    case "color":
      return colorEditor(value, commit);
    case "enum":
      return select(spec?.variants ?? [], typeof value === "string" ? value : "", (choice) => commit(choice));
    case "text":
      return commitInput(typeof value === "string" ? value : "", (text) => commit(text));
    default:
      return el("code", { class: "readonly", text: JSON.stringify(value ?? null) });
  }
}

function liveText(live: Live | null, cell: string): string {
  const value = live?.values?.[cell];
  if (value === undefined || value === null) return "--";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  return String(value);
}

/* ---- variable cards ---- */

function varCard(editor: Editor, variable: Var, scope: "global" | "local"): HTMLElement {
  const setProp = (key: string, value: Json) =>
    editor.apply([{ op: "set_prop", node: variable.id, key, value }]);
  const now = liveText(editor.live, "v" + variable.id);
  return el("div", { class: "card var" }, [
    el("div", { class: "card-head" }, [
      commitInput(variable.name, (name) => editor.apply([{ op: "rename", node: variable.id, name }]), {
        class: "field name",
      }),
      el("span", { class: "now" + (variable.type === "bool" && now === "true" ? " hot" : ""), text: now }),
      el("button", {
        class: "icon-btn",
        title: "remove " + variable.name,
        text: "x",
        onclick: () => editor.apply([{ op: "remove", node: variable.id }]),
      }),
    ]),
    el("div", { class: "card-grid" }, [
      el("label", { text: "type" }),
      select(["f64", "bool", "str", "timer"], variable.type, (type) => setProp("type", type)),
      el("label", { text: variable.type === "timer" ? "secs" : "init" }),
      valueEditor(
        null,
        variable.type === "bool" ? "bool" : variable.type === "str" ? "text" : "num",
        variable.init,
        (value) => setProp("init", value),
      ),
      el("label", { text: "persist" }),
      valueEditor(null, "bool", variable.persist, (value) => setProp("persist", value)),
    ]),
    el("div", { class: "card-foot", text: scope === "local" ? "widget-local" : "global" }),
  ]);
}

function newVar(editor: Editor, parent: number, list: string, taken: Var[]): void {
  let n = 1;
  const names = new Set(taken.map((v) => v.name));
  while (names.has("var" + n)) n++;
  editor.apply([
    { op: "insert", parent, list, node: { name: "var" + n, type: "f64", init: 0 } },
  ]);
}

/* ---- left rail ---- */

export function renderLeftRail(host: HTMLElement, editor: Editor): void {
  clear(host);
  const store = editor.store;
  const page = editor.page();

  host.appendChild(
    el("div", { class: "rail-head" }, [
      el("span", { class: "rail-title", text: "Pages" }),
      el("button", {
        class: "icon-btn",
        title: "new page",
        text: "+",
        onclick: () =>
          editor.apply([{ op: "insert", parent: 0, list: "pages", node: { name: "Page" } }]),
      }),
    ]),
  );
  host.appendChild(
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
  );
  if (page)
    host.appendChild(
      el("div", { class: "page-name" }, [
        el("label", { text: "name" }),
        commitInput(page.name, (name) =>
          editor.apply([{ op: "set_prop", node: page.id, key: "name", value: name }]),
        ),
        store.pages().length > 1
          ? el("button", {
              class: "icon-btn",
              title: "remove page",
              text: "x",
              onclick: () => editor.apply([{ op: "remove", node: page.id }]),
            })
          : null,
      ]),
    );

  host.appendChild(
    el("div", { class: "rail-head" }, [
      el("span", { class: "rail-title", text: "Global variables" }),
      el("span", { class: "badge", text: String(store.globals().length) }),
      el("button", {
        class: "icon-btn",
        title: "new global",
        text: "+",
        onclick: () => newVar(editor, 0, "globals", store.globals()),
      }),
    ]),
  );
  for (const variable of store.globals()) host.appendChild(varCard(editor, variable, "global"));
  if (!store.globals().length)
    host.appendChild(el("p", { class: "empty", text: "No globals yet." }));
}

/* ---- inspector ---- */

function feedCard(feed: Feed): HTMLElement {
  const source = `${feed.src?.kind ?? "?"} ${feed.src?.name ?? ""}${feed.path ? " . " + feed.path : ""}`;
  return el("div", { class: "card feed" }, [
    el("div", { class: "sentence" }, [
      el("span", { class: "chip slot", text: feed.slot }),
      el("span", { class: "arrow", text: "<-" }),
      feed.xf ? el("span", { class: "chip xf mono", text: feed.xf }) : null,
      feed.xf ? el("span", { class: "arrow", text: "<-" }) : null,
      el("span", { class: "chip src", text: source }),
      feed.poll_hz ? el("span", { class: "chip hz", text: feed.poll_hz + " Hz" }) : null,
    ]),
  ]);
}

function flowCard(flow: Flow): HTMLElement {
  const when = (flow.when ?? [])
    .map((t: Json) => (t.kind === "timer" ? `timer ${t.var} ends` : String(t.name ?? "?")))
    .join(flow.when_mode === "any" ? " or any " : " or first ");
  const targets: string[] = [];
  for (const step of flow.do ?? []) {
    if (step.kind === "send" || step.kind === "build" || step.kind === "unforce") {
      const target = step.target ?? {};
      const label = `${target.kind ?? "?"} ${target.name ?? ""}`.trim();
      if (label && targets.indexOf(label) < 0) targets.push(label);
    }
    if (step.kind === "assign" && step.var && targets.indexOf("L " + step.var) < 0)
      targets.push("L " + step.var);
  }
  return el("div", { class: "card flow" }, [
    el("div", { class: "sentence" }, [
      el("span", { class: "kw", text: "when" }),
      el("span", { class: "chip", text: when || "nothing" }),
      el("span", { class: "arrow", text: "->" }),
      targets.length
        ? el("span", { class: "chip out", text: targets.join(", ") })
        : el("span", { class: "chip dead", text: "nothing written" }),
    ]),
    el("div", { class: "steps", text: (flow.do ?? []).map((s: Json) => s.kind).join(" · ") || "no steps" }),
  ]);
}

function slotRow(editor: Editor, widget: Widget, spec: SlotSpec, fed: Set<string>): HTMLElement {
  const type = typeOf(editor.registry, widget.type);
  const value = resolveSlot(widget, type, editor.live, fed, spec.name);
  const commit = (next: Json) => {
    const slots = { ...(widget.slots ?? {}) };
    slots[spec.name] = next;
    editor.apply([{ op: "set_prop", node: widget.id, key: "slots", value: slots }]);
  };
  const bound = fed.has(spec.name);
  return el("div", { class: "slot-row" }, [
    el("label", { class: "slot-name", text: spec.name }),
    bound
      ? el("span", { class: "chip bound", text: "fed · " + liveText(editor.live, widget.id + "." + spec.name) })
      : valueEditor(spec, spec.shape, value, commit),
    el("span", { class: "shape", text: spec.shape }),
  ]);
}

export function renderInspector(host: HTMLElement, editor: Editor): void {
  clear(host);
  const widget = editor.selectedWidget();
  if (!widget) {
    host.appendChild(el("p", { class: "empty", text: "Select a widget to inspect it." }));
    return;
  }
  const type = typeOf(editor.registry, widget.type);
  const fed = fedSlots(widget);
  const geomField = (key: "x" | "y" | "w" | "h") =>
    numberInput(widget.geom[key], (n) => {
      const geom = { ...widget.geom, [key]: n };
      editor.apply([{ op: "set_prop", node: widget.id, key: "geom", value: geom }]);
    });

  host.appendChild(
    el("div", { class: "inspector-head" }, [
      commitInput(widget.label, (label) =>
        editor.apply([{ op: "set_prop", node: widget.id, key: "label", value: label }]),
      { class: "field title" }),
      el("div", { class: "sub" }, [
        el("span", { class: "chip type", text: widget.type }),
        el("span", { class: "id", text: "#" + widget.id }),
      ]),
      el("div", { class: "geom" }, [
        el("label", { text: "x" }), geomField("x"),
        el("label", { text: "y" }), geomField("y"),
        el("label", { text: "w" }), geomField("w"),
        el("label", { text: "h" }), geomField("h"),
      ]),
    ]),
  );

  const valueSlots = (type?.slots ?? []).filter((s) => s.group === "value");
  const otherSlots = (type?.slots ?? []).filter((s) => s.group !== "value");

  host.appendChild(
    section("data-in", "Data in", String((widget.feeds ?? []).length), () => [
      ...(widget.feeds ?? []).map(feedCard),
      ...valueSlots.map((spec) => slotRow(editor, widget, spec, fed)),
      valueSlots.length || (widget.feeds ?? []).length
        ? null
        : el("p", { class: "empty", text: "This type consumes no values." }),
    ].filter(Boolean) as HTMLElement[]),
  );

  host.appendChild(
    section("behavior", "Behavior", String((widget.flows ?? []).length), () =>
      (widget.flows ?? []).length
        ? (widget.flows ?? []).map(flowCard)
        : [el("p", { class: "empty", text: "No flows. Authoring lands with the runtime." })],
    ),
  );

  host.appendChild(
    section("locals", "Local variables", String((widget.locals ?? []).length), () => [
      ...(widget.locals ?? []).map((variable) => varCard(editor, variable, "local")),
      el("button", {
        class: "wide-btn",
        text: "+ local variable",
        onclick: () => newVar(editor, widget.id, "locals", widget.locals ?? []),
      }),
    ]),
  );

  host.appendChild(
    section("appearance", "Appearance", String(otherSlots.length), () =>
      otherSlots.map((spec) => slotRow(editor, widget, spec, fed)),
    ),
  );
}
