/* The component-editing inspector: the views behind the Components tree.
 *
 * A COMPONENT selection edits the type's own record — its name (a plain set_prop:
 * nothing references a component by id, and instances typed by the old name simply lose
 * their type, which the missing-type marker already says), its events, the PROPERTIES
 * table (one PropDef row each, the slot editors reused for the default), and its
 * BEHAVIOR — the default flows, edited with the very card an instance's flows use.
 *
 * A NODE selection edits one node of its tree: its name, a frame's layout, the ATTRS
 * table (every attr its kind declares, expression text with the highlight underlay,
 * committed as the WHOLE attrs object exactly like an instance's `slots`), the interact's
 * params, and the structural acts (add child, move, delete). That attrs table is exported
 * — the Content inspector shows the same rows for a page's node, because it is the same
 * node. Everything is ordinary ops: the backend recompiles and the snapshot delivers the
 * new derived type to every instance live. */

import { commitInput, el, iconButton, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, section } from "../editor.js";
import { addFlowButton, flowCard, flowShape } from "./flows.js";
import { highlighted } from "../highlight.js";
import { openMenu } from "../menu.js";
import { bindChoice, bindField, bindFlag, bindText } from "../reconcile.js";
import { AttrDef, ComponentDef, EventSpec, Json, Node, PRIMITIVES, PropDef,
         SlotSpec, TransitionMap, eventKind, primitiveDef, signatureText } from "../types.js";
import { valueEditor } from "./editors.js";

const PROP_SHAPES = ["num", "bool", "text", "color", "enum", "list", "map"];
const PROP_GROUPS = ["value", "appearance", "config", "frame"];
/* the shapes an event's PARAMETER may carry. A list or a map is not one (an event
   passes a value, never a history) and `enum` needs a type to name its variants, which
   a signature has nowhere to put — the enum's own text name is what travels. */
const EVENT_SHAPES = ["bool", "num", "text", "color"];

/* the closed attr vocabulary: `editor.attrTable` is snapshot-only data, so these read
 * straight off it rather than caching — a kind with nothing of its own, or an offline
 * editor with no table yet, both fall back to an empty list rather than to a crash. */
function ownAttrsOf(editor: Editor, kind: string): AttrDef[] {
  return editor.attrTable?.perKind[kind] ?? [];
}
function commonAttrs(editor: Editor): AttrDef[] {
  return editor.attrTable?.common ?? [];
}
function nodeKinds(editor: Editor): string[] {
  return editor.attrTable?.kinds ?? [];
}

/* What an unset attr's field shows so its effect is visible without typing anything: the
 * renderer's own default, verbatim. Where the vocabulary declares none — because absence
 * means "not applied" rather than any value (show, repeat, clip, zoom, rotate, at, fit) —
 * it says just that. The NOTE is deliberately not used here: it is a sentence, and a
 * column of clipped half-sentences reads as noise where the point of the placeholder is
 * to be scannable. The full note rides the row's tooltip, on both the name and the
 * field, which is where prose belongs. */
function attrPlaceholder(def: AttrDef): string {
  return def.default !== undefined ? literalText(def.default) : "not set";
}

/* The keys a node carries that its kind's vocabulary does NOT declare. ONE definition,
 * because both the shape string and the render need it and they must not disagree: the
 * declared rows are fixed by `kind` alone, but a stray adds a row, so which strays exist
 * is structure and has to ride the shape. */
function strayAttrs(editor: Editor, part: Node): string[] {
  const declared = new Set(
    [...ownAttrsOf(editor, part.kind), ...commonAttrs(editor)].map((d) => d.name));
  return Object.keys((part.attrs ?? {}) as Record<string, string>)
    .filter((key) => !declared.has(key));
}

/* the divider between a kind's own attrs, the placement half that applies and the set
 * every kind shares: the existing row-label idiom (KIND, ADDRESS, DEFAULT, GROUP, ...),
 * not a new visual language */
function attrGroupHeading(text: string): HTMLElement {
  return el("div", { class: "row" }, [el("span", { class: "row-label", text })]);
}

/* the selection resolved against the store: a vanished part falls back to the
 * component, a vanished component to null (the widget inspector then applies) */
function selection(editor: Editor): { comp: ComponentDef; part: Node | null } | null {
  const sel = editor.componentSel;
  if (!sel) return null;
  const comp = editor.store.node(sel.component) as ComponentDef | null;
  if (!comp) return null;
  if (sel.node === sel.component) return { comp, part: null };
  const part = editor.store.node(sel.node) as Node | null;
  return { comp, part: part && typeof part.kind === "string" ? part : null };
}

/* the list a node sits in: its parent frame's children, or the component's own */
function siblingsOf(editor: Editor, partId: number): Json[] {
  const parent = editor.store.parentOf(partId) as Json;
  if (!parent) return [];
  for (const key of ["children"]) {
    const list = parent[key];
    if (Array.isArray(list) && list.some((node: Json) => node?.id === partId)) return list;
  }
  return [];
}

/* ---- the browsed built-in ----
 *
 * The same definition an Override would copy, shown read-only. It is not in the
 * document, so nothing here binds, applies an op or looks anything up in the store: a
 * built-in never changes at runtime, which is exactly why one static render is enough.
 *
 * `path` is a CHILD-INDEX path into the component's own children ("" = the component
 * itself, "0" = its first child, "0.1" = that child's second). `address` is the different
 * thing the reader actually wants: the node's SLOT ADDRESS prefix — the names joined from
 * the component down, which is what its properties are addressed under and what an
 * instance's nested `slots` mirror. The component adds no segment, being the root. */
interface BuiltinAt {
  comp: Json;
  part: Json | null;
  path: string;
  address: string;
}

function builtinAt(editor: Editor): BuiltinAt | null {
  const sel = editor.builtinSel;
  if (!sel || !sel.name) return null;
  const comp = (editor.builtins ?? []).find((b: Json) => b?.name === sel.name);
  if (!comp) return null;
  let part: Json = null;
  let list: Json[] = Array.isArray(comp.children) ? (comp.children as Json[]) : [];
  const names: string[] = [];
  for (const step of sel.path ? sel.path.split(".") : []) {
    const at = list[Number(step)];
    /* a stale path (the tree it addressed is gone) falls back to the component itself
       rather than showing nothing: the same rule the doc selection follows */
    if (!at || typeof at !== "object") return { comp, part: null, path: "", address: "" };
    part = at;
    names.push(String(at.name ?? ""));
    list = Array.isArray(at.children) ? (at.children as Json[]) : [];
  }
  /* every step IS an address segment now: the component is the root, so its children are
     the first named level rather than one wrapper part down */
  return { comp, part, path: sel.path, address: names.join(".") };
}

/* A read-only expression: the same highlighted field the editable rows use, `readonly`
   rather than disabled so the text still selects and copies out. It carries the whole
   expression as its tooltip, because a built-in's attrs are the longest in the system
   (a Knob's `zoom` folds four properties) and this view exists to be READ — the
   editable rows can scroll their caret, a static one cannot. `placeholder`/`title`
   default to the interact-param call sites' old behaviour (none, and the text itself);
   the closed-vocabulary attr rows below pass the renderer's own default and its note
   instead, so an unset attr reads the same way here as it does in the editable view. */
function exprView(text: string, placeholder = "", title = text): HTMLElement {
  const input = el("input", {
    class: "field grow",
    type: "text",
    value: text,
    placeholder,
    title,
    spellcheck: "false",
    readonly: "readonly",
  }) as HTMLInputElement;
  return highlighted(input);
}

/* one authored value as the reader would type it back: a string is itself (a color, an
   enum variant, a piece of text), everything else its JSON */
function literalText(value: Json): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function builtinPropRow(prop: Json, prefix: string): HTMLElement {
  const name = String(prop?.name ?? "");
  return el("div", { class: "propdef" }, [
    el("div", { class: "row" }, [
      el("span", { class: "value-static grow", text: name,
                   title: "addressed " + (prefix ? prefix + "." + name : name) }),
      el("span", { class: "kw", text: String(prop?.shape ?? "num") }),
    ]),
    el("div", { class: "row" }, [
      el("span", { class: "row-label", text: "DEFAULT" }),
      el("span", { class: "value-static grow", text: literalText(prop?.default) }),
      el("span", { class: "row-label", text: "GROUP" }),
      el("span", { class: "kw", text: String(prop?.group ?? "appearance") }),
    ]),
  ]);
}

function builtinPropsSection(props: Json[], prefix: string, empty: string): HTMLElement[] {
  return section("builtin-props", "Properties", String(props.length), () => [
    ...props.map((prop) => builtinPropRow(prop, prefix)),
    props.length ? null : el("p", { class: "empty", text: empty }),
  ]);
}

function renderBuiltinComponentView(host: HTMLElement, editor: Editor, at: BuiltinAt): void {
  const name = String(at.comp?.name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      el("span", { class: "part-name", text: name }),
      el("span", { class: "head-tag", text: "built-in" }),
    ]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);
  body.appendChild(
    el("p", { class: "empty",
              text: "the shipped definition, read-only — open its parts in the tree" }),
  );
  body.appendChild(
    el("button", {
      class: "dashed-btn",
      text: "Override " + name,
      title: "copy this definition into the document and edit it there",
      onclick: () => editor.forkBuiltin(name),
    }),
  );

  const events = (Array.isArray(at.comp?.events) ? at.comp.events : []) as Json[];
  body.append(
    ...section("builtin-events", "Events", String(events.length), () => [
      ...events.map((evt) =>
        el("div", { class: "event-line" }, [
          el("span", { class: "kw", text: String(evt?.name ?? "") }),
          el("span", { class: "op", text: "x: " + String(evt?.x ?? "") }),
          evt?.value ? el("code", { class: "event-expr", text: String(evt.value) }) : null,
        ]),
      ),
      events.length ? null : el("p", { class: "empty", text: "no events" }),
    ]),
  );

  /* the WIDGET's own properties: what an instance shows while the widget itself is
     selected. A part's are on that part, which is what the tree is for. */
  body.append(
    ...builtinPropsSection((at.comp?.props ?? []) as Json[], "",
                           "no properties of its own"),
  );

  const flows = (Array.isArray(at.comp?.behavior) ? at.comp.behavior : []) as Json[];
  body.append(
    ...section("builtin-behavior", "Behavior", String(flows.length), () => [
      ...flows.map((flow) => el("div", { class: "flow-line", text: flowSummary(flow) })),
      flows.length ? null : el("p", { class: "empty", text: "no default behavior" }),
    ]),
  );
}

function renderBuiltinPartView(host: HTMLElement, editor: Editor, at: BuiltinAt): void {
  const part = at.part as Json;
  const comp = String(at.comp?.name ?? "");
  const kind = String(part?.kind ?? "");
  const attrs = (part?.attrs ?? {}) as Record<string, Json>;

  const back = el("button", {
    class: "part-back",
    text: comp,
    title: "back to the component",
    onclick: () => editor.selectBuiltin(comp, ""),
  });
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      back,
      el("span", { class: "part-sep", text: "›" }),
      el("span", { class: "part-name", text: String(part?.name ?? "") }),
      el("span", { class: "head-tag", text: "built-in" }),
    ]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  const kindRow = el("div", { class: "row" }, [
    el("span", { class: "row-label", text: "KIND" }),
    el("span", { class: "kw", text: kind }),
  ]);
  body.append(
    el("div", { class: "part-def" }, [
      kindRow,
      /* the one thing a reader of a built-in is really after: what this part's
         properties are called from the outside */
      el("div", { class: "row" }, [
        el("span", { class: "row-label", text: "ADDRESS" }),
        el("span", { class: "value-static grow",
                     text: at.address || "the widget itself",
                     title: at.address
                       ? "its properties address " + at.address + ".<name>"
                       : "the template root adds no segment: its properties address bare" }),
      ]),
    ]),
  );

  body.append(
    ...builtinPropsSection((part?.props ?? []) as Json[], at.address,
                           "no properties of its own"),
  );

  /* the closed vocabulary: every attr this KIND declares, own first then common, with the
   * built-in's authored text where it set one — same idiom as the editable node view
   * below, minus the commit wiring */
  const attrDefRow = (def: AttrDef): HTMLElement => {
    const raw = attrs[def.name];
    return el("div", { class: "attr-row" }, [
      el("span", { class: "field attr-name static", text: def.name, title: def.note }),
      exprView(typeof raw === "string" ? raw : "", attrPlaceholder(def), def.note),
    ]);
  };
  const ownDefs = ownAttrsOf(editor, kind);
  const commonDefs = commonAttrs(editor);
  body.append(
    ...section("builtin-attrs", "Attrs", String(ownDefs.length + commonDefs.length), () => [
      ...(ownDefs.length ? [attrGroupHeading("THIS NODE"), ...ownDefs.map(attrDefRow)] : []),
      attrGroupHeading("COMMON"),
      ...commonDefs.map(attrDefRow),
    ]),
  );

  const interact = part?.interact as Json;
  if (interact && typeof interact === "object") {
    const params = Object.entries((interact.params ?? {}) as Record<string, Json>);
    const emits = Object.entries((interact.emits ?? {}) as Record<string, string>);
    body.append(
      ...section("builtin-interact", "Interact", null, () => [
        el("div", { class: "row" }, [
          el("span", { class: "row-label", text: "PRIMITIVE" }),
          el("span", { class: "kw", text: String(interact.primitive ?? "press") }),
        ]),
        ...params.map(([param, expr]) =>
          el("div", { class: "attr-row" }, [
            el("span", { class: "field attr-name static", text: param }),
            exprView(String(expr ?? "")),
          ]),
        ),
        ...emits.map(([gesture, event]) =>
          el("div", { class: "row" }, [
            el("span", { class: "row-label", text: "EMITS" }),
            el("span", { class: "kw", text: gesture + " → " + event }),
          ]),
        ),
      ]),
    );
  }
}

function flowSummary(flow: Json): string {
  const when = (Array.isArray(flow?.when) ? flow.when : [])
    .map((t: Json) => (t?.kind === "timer" ? "timer " + (t.var ?? "?") : String(t?.name ?? "?")))
    .join(", ");
  const steps = Array.isArray(flow?.do) ? flow.do.length : 0;
  return "on " + (when || "?") + " · " + steps + (steps === 1 ? " step" : " steps");
}

function diagShape(editor: Editor, id: number): string[] {
  return editor.diagNode(id).map((d) => id + ":" + (d.where ?? "") + ":" + d.code + ":" + d.message);
}

/* What a node OWNS beyond its attrs — the properties it declares and the interact it
 * carries — as shape data: the rows exist per prop and per param, so every inspector
 * whose render builds those sections carries this in its shape string. */
export function ownedShape(node: Json): Json {
  const interact = node?.interact as Json;
  return {
    props: ((node?.props ?? []) as PropDef[]).map((p) =>
      [p.id, p.shape, p.group, (p.variants ?? []).join("|"), p.editor ?? ""]),
    interact: interact && typeof interact === "object"
      ? { primitive: interact.primitive ?? "press",
          params: Object.keys(interact.params ?? {}),
          emits: interact.emits ?? {} }
      : null,
  };
}

/* the component view's structure, parameterized by the component so the Content
 * inspector can stand on an entered context's component as well as the Design
 * selection */
export function componentViewShape(editor: Editor, comp: ComponentDef): string {
  return JSON.stringify({
    comp: comp.id,
    props: (comp.props ?? []).map((p) => [p.id, p.shape, p.group,
                                          (p.variants ?? []).join("|"), p.editor ?? ""]),
    /* an event's NAME is its row's identity (there is no id to bind by); the signature
       rides the shape so a parameter added or dropped rebuilds its row */
    events: (comp.events ?? []).map((e) =>
      [e.name, ...(e.params ?? []).map((p) => p.name + ":" + p.shape)]),
    /* the component record IS the root node, so its gesture rides this view too: the
       primitive decides which param and posts rows exist */
    interact: ownedShape(comp as unknown as Json).interact,
    /* behavior rows are EDITED here now, so their structure rides the shape the same
       way an instance's flow list does */
    behavior: (comp.behavior ?? []).map(flowShape),
    diag: diagShape(editor, comp.id)
      .concat((comp.props ?? []).flatMap((p) => diagShape(editor, p.id))),
  });
}

/* the component inspector's structure, or null when no component is selected (which
 * is what routes the inspector back to the widget views) */
export function componentInspectorShape(editor: Editor): string | null {
  /* a browsed built-in is fully described by its address: the definitions are
     snapshot-only, so nothing inside one can change under a standing render */
  const browsing = builtinAt(editor);
  if (browsing) return JSON.stringify({ builtin: browsing.comp?.name, path: browsing.path });
  const at = selection(editor);
  if (!at) return null;
  const { comp, part } = at;
  if (part) {
    const siblings = siblingsOf(editor, part.id);
    return JSON.stringify({
      comp: comp.id,
      part: part.id,
      kind: part.kind,
      own: ownedShape(part),
      /* the closed vocabulary fixes the declared row SET by kind, already covered by the
         `kind` key above, so a value or diag change needs no shape bump (bindField and the
         diag icon's own hover state handle those live). One thing still adds a row: an
         undeclared key the document carries, which gets one of its own so it can be
         removed. */
      attrs: strayAttrs(editor, part),
      index: siblings.findIndex((node: Json) => node?.id === part.id),
      count: siblings.length,
      diag: diagShape(editor, part.id).concat(
        ((part as Json).props ?? []).flatMap((p: PropDef) => diagShape(editor, p.id))),
    });
  }
  return componentViewShape(editor, comp);
}

export function renderComponentInspector(host: HTMLElement, editor: Editor): void {
  const browsing = builtinAt(editor);
  if (browsing) {
    if (browsing.part) renderBuiltinPartView(host, editor, browsing);
    else renderBuiltinComponentView(host, editor, browsing);
    return;
  }
  const at = selection(editor);
  if (!at) return;
  if (at.part) renderPartView(host, editor, at.comp, at.part);
  else renderComponentView(host, editor, at.comp);
}

/* ---- the component view ----
 *
 * Exported: the Content inspector shows this very view while standing inside an entered
 * widget with nothing selected — the context's component IS the selection there. */

export function renderComponentView(host: HTMLElement, editor: Editor, comp: ComponentDef): void {
  const at = () => (editor.store.node(comp.id) as ComponentDef | null) ?? comp;
  const name = commitInput(
    comp.name,
    (text) => {
      if (text) editor.apply([{ op: "set_prop", node: comp.id, key: "name", value: text }]);
    },
    {
      class: "field title",
      title: "the component's name; instances typed by the old name lose their type",
    },
  );
  bindField(comp.id + ":name", name, () => at().name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      name,
      el("span", { class: "head-tag", text: "component" }),
      diagIcon(editor.diagAt(comp.id).concat(editor.diagAt(comp.id, "name"))),
    ]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  /* 1. Events: what instances can trigger a flow on, and what `x` is when they do. */
  body.append(...eventsSection(editor, comp));

  /* 2. The root's own gesture. The component record IS its root node, so this is the
   *    ordinary node-level section — the same one a part inside the tree gets — asked of
   *    the root. It sits directly under Events because it is the other half of the same
   *    sentence: the gesture is what RAISES the events above. */
  body.append(...interactSection(editor, comp as unknown as Node, "the widget's own box"));

  /* 3. Properties: one PropDef row per served slot. The name, shape, default and
   *    group are the whole slot spec an instance sees. These are the WIDGET's own —
   *    what an instance shows while the widget itself is selected; a property that
   *    belongs to one part is declared on that part. */
  body.append(
    ...propsSection(editor, comp.id, "comp-props", () => at().props ?? [],
                    "no properties yet"),
  );

  /* 4. Behavior: the type's DEFAULT flows, edited with the same card an instance's
   *    flows get — a component's behavior is not special, it just compiles per
   *    instance. The card needs a widget-shaped host for scope (globals only: a
   *    component holds no locals) and the component's own served type for its slots
   *    and events; the Trend's sampler — one beat, one append — is authored with
   *    exactly these controls. */
  const flows = comp.behavior ?? [];
  const asWidget = {
    id: comp.id, kind: "frame", name: comp.name, type: comp.name,
    attrs: {},
  } as unknown as Node;
  const ownType = editor.registry?.types.find((t) => t.name === comp.name) ?? null;
  body.append(
    ...section("comp-behavior", "Behavior", String(flows.length), () => [
      ...flows.map((flow) => flowCard(editor, asWidget, ownType, flow)),
      addFlowButton(editor, asWidget, ownType, "behavior"),
    ]),
  );

  /* 5. Design frame: the component's own authored size — what the future Design
   *    preview will draw it at. Never an instance size (an instance carries no
   *    geometry of its own; its box comes from layout), so it is edited here on the
   *    TYPE and nowhere else. Same numeric idiom the frame inspector's gap/pad fields
   *    use (panel.ts): a hand-built SlotSpec through the ordinary value editor. */
  const designField = (key: "design_w" | "design_h") => {
    const spec: SlotSpec = { name: key, shape: "num", default: key === "design_w" ? 240 : 120,
                             group: "config" };
    return valueEditor(spec, "num", comp.id + ":" + key, () => at()[key],
                       (v) => editor.apply([{ op: "set_prop", node: comp.id, key, value: v }]),
                       false, editor);
  };
  body.append(
    ...section("comp-design-frame", "Design frame", null, () => [
      el("div", { class: "prop-grid" }, [
        el("label", { text: "w" }), designField("design_w"), el("span"),
        el("label", { text: "h" }), designField("design_h"), el("span"),
      ]),
    ]),
  );
}

/* ---- the events a component declares ----
 *
 * AN EVENT IS A FUNCTION SIGNATURE this component declares and its behavior raises with
 * the `raise` step; an instance's flows are the bodies, parameters bound by name.
 * GESTURE events never appear here — a part carrying a primitive brings that family
 * with fixed signatures — so this section holds only what the component INVENTS:
 * `changed(value)` on a control, `confirmed()` on a two-tap interlock. The row set is
 * the component's own `events` array, edited as a whole (a plain array prop; the NAME
 * is the identity). One parameter per event for now, which is the runtime's rule too. */
function eventsSection(editor: Editor, comp: ComponentDef): HTMLElement[] {
  const at = () => (editor.store.node(comp.id) as ComponentDef | null) ?? comp;
  const eventsAt = (): EventSpec[] => at().events ?? [];
  const commit = (next: EventSpec[]) =>
    editor.apply([{ op: "set_prop", node: comp.id, key: "events", value: next }]);
  const events = eventsAt();

  const add = () => {
    const taken = new Set(eventsAt().map((e) => e.name));
    let name = "changed";
    for (let n = 2; taken.has(name) || eventKind(name); ++n) name = "event" + n;
    commit([...eventsAt(), { name, params: [{ name: "value", shape: "num" }] }]);
  };

  return section("comp-events", "Events", String(events.length), () => [
    ...events.map((evt) => eventRow(comp.id, evt.name, eventsAt, commit)),
    events.length
      ? null
      : el("p", { class: "empty",
                  text: "no declared events — the gesture family (tap, press, ...) comes "
                        + "with each part's primitive; declare one to raise it from "
                        + "behavior" }),
    el("button", { class: "dashed-btn", text: "+ Event", onclick: add }),
  ]);
}

/* one declared signature, edited in place: name ( parameter : shape ). An empty
   parameter name makes the event nullary — a moment, like tap. Gesture names are
   reserved; a rename into one is refused silently and the field snaps back. */
function eventRow(
  compId: number,
  name: string,
  eventsAt: () => EventSpec[],
  commit: (next: EventSpec[]) => void,
): HTMLElement {
  const rowAt = (): EventSpec =>
    eventsAt().find((e) => e.name === name) ?? { name, params: [] };
  const patch = (next: Partial<EventSpec>) =>
    commit(eventsAt().map((e) => (e.name === name ? { ...e, ...next } : e)));
  const param = () => (rowAt().params ?? [])[0] ?? null;

  const rename = commitInput(name, (text) => {
    const clean = text.trim();
    if (!clean || clean === name) return;
    if (eventKind(clean) || eventsAt().some((e) => e.name === clean)) return;
    patch({ name: clean });
  }, { class: "field", spellcheck: "false", title: "the event's name" });
  bindField(compId + ":events." + name + ".name", rename, () => rowAt().name);

  const pname = commitInput(param()?.name ?? "", (text) => {
    const clean = text.trim();
    patch({ params: clean ? [{ name: clean, shape: param()?.shape ?? "num" }] : [] });
  }, { class: "field", spellcheck: "false", placeholder: "no parameter",
       title: "the value this event carries, bound by this name in a handler flow" });
  bindField(compId + ":events." + name + ".param", pname, () => param()?.name ?? "");

  const shape = selectField(EVENT_SHAPES.map((v) => ({ value: v })),
    param()?.shape ?? "num",
    (v) => { const held = param(); if (held) patch({ params: [{ name: held.name, shape: v }] }); },
  );
  bindChoice(compId + ":events." + name + ".shape", pickerOf(shape),
             () => param()?.shape ?? "num");

  return el("div", { class: "eventdef" }, [
    el("div", { class: "row" }, [
      rename,
      el("span", { class: "op", text: "(" }),
      pname,
      param() ? shape : null,
      el("span", { class: "op", text: ")" }),
      iconButton("trash", "remove this event", () =>
        commit(eventsAt().filter((e) => e.name !== name)),
      ),
    ]),
  ]);
}

/* The properties one owner declares — a component (the widget's own vocabulary) or a
 * part (what that part paints). One section, three callers (the Design component and
 * part views, and the Content node inspector inside an entered context), because the
 * row is the same thing in every place and so is the rule: a property is declared
 * where it is read. */
export function propsSection(
  editor: Editor,
  ownerId: number,
  key: string,
  propsAt: () => PropDef[],
  empty: string,
): HTMLElement[] {
  const props = propsAt();
  return section(key, "Properties", String(props.length), () => [
    ...props.map((prop) => propRow(editor, prop)),
    props.length ? null : el("p", { class: "empty", text: empty }),
    el("button", {
      class: "dashed-btn",
      text: "+ Property",
      onclick: () => {
        const taken = new Set(propsAt().map((p) => p.name));
        let fresh = "prop1";
        for (let n = 1; taken.has(fresh); n++) fresh = "prop" + n;
        editor.apply([{ op: "insert", parent: ownerId, list: "props", node: { name: fresh } }]);
      },
    }),
  ]);
}

function propRow(editor: Editor, prop: PropDef): HTMLElement {
  const at = () => (editor.store.node(prop.id) as PropDef | null) ?? prop;
  const name = commitInput(
    prop.name,
    (text) => {
      if (text) editor.apply([{ op: "set_prop", node: prop.id, key: "name", value: text }]);
    },
    { class: "field grow" },
  );
  bindField(prop.id + ":name", name, () => at().name ?? "");

  const shape = selectField(PROP_SHAPES.map((v) => ({ value: v })), prop.shape, (v) =>
    editor.apply([{ op: "set_prop", node: prop.id, key: "shape", value: v }]),
  );
  bindChoice(prop.id + ":shape", pickerOf(shape), () => at().shape ?? "num");

  const group = selectField(PROP_GROUPS.map((v) => ({ value: v })), prop.group, (v) =>
    editor.apply([{ op: "set_prop", node: prop.id, key: "group", value: v }]),
  );
  bindChoice(prop.id + ":group", pickerOf(group), () => at().group ?? "appearance");

  /* the same editor an instance's slot row uses, driving the DEFAULT value */
  const spec = {
    name: prop.name,
    shape: prop.shape,
    default: prop.default,
    group: prop.group,
    variants: prop.variants ?? [],
    ...(prop.editor ? { editor: prop.editor } : {}),
  } as SlotSpec;
  const dflt = valueEditor(
    spec,
    prop.shape,
    prop.id + ":default",
    () => at().default,
    (v) => editor.apply([{ op: "set_prop", node: prop.id, key: "default", value: v }]),
    false,
    editor,
  );

  /* THE DECLARED TRANSITION, number properties only: rendered reads of this slot sweep
     toward the true value over this many ms — the needle, the arc and the readout all
     together — while behavior, gestures and the wire keep reading truth. 0 = none. */
  const sweep = commitInput(
    typeof prop.smooth === "number" && prop.smooth > 0 ? String(prop.smooth) : "",
    (text) => {
      const ms = Number(text);
      editor.apply([{ op: "set_prop", node: prop.id, key: "smooth",
                      value: Number.isFinite(ms) && ms > 0 ? ms : 0 }]);
    },
    { class: "field", placeholder: "none" },
  );
  bindField(prop.id + ":smooth", sweep, () => {
    const ms = (at() as PropDef).smooth;
    return typeof ms === "number" && ms > 0 ? String(ms) : "";
  });
  const profile = selectField(
    PROFILES.map((v) => ({ value: v })),
    prop.profile || "ease",
    (v) => editor.apply([{ op: "set_prop", node: prop.id, key: "profile", value: v }]),
  );
  bindChoice(prop.id + ":profile", pickerOf(profile), () => at().profile || "ease");
  const sweepDiag = editor.diagAt(prop.id, "smooth");

  return el("div", { class: "propdef" }, [
    el("div", { class: "row" }, [
      name,
      shape,
      iconButton("trash", "remove this property", () =>
        editor.apply([{ op: "remove", node: prop.id }]),
      ),
      diagIcon(editor.diagAt(prop.id, "name")),
    ]),
    el("div", { class: "row" }, [
      el("span", { class: "row-label", text: "DEFAULT" }),
      dflt,
      el("span", { class: "row-label", text: "GROUP" }),
      group,
    ]),
    prop.shape === "num"
      ? el("div", { class: "row" }, [
          el("span", { class: "row-label", text: "SWEEP MS" }),
          sweep,
          profile,
          diagIcon(sweepDiag.length ? sweepDiag : editor.diagAt(prop.id, "profile")),
        ])
      : null,
  ]);
}

/* ---- the part view ---- */

function renderPartView(host: HTMLElement, editor: Editor, comp: ComponentDef,
                        part: Node): void {
  const at = () => (editor.store.node(part.id) as Node | null) ?? part;

  const back = el("button", {
    class: "part-back",
    title: "back to the component",
    onclick: () => editor.selectComponent(comp.id, comp.id),
  });
  bindText(part.id + ":comp.back", back, () =>
    (editor.store.node(comp.id) as Json)?.name ?? "");
  const headName = el("span", { class: "part-name" });
  bindText(part.id + ":name.head", headName, () => at().name ?? "");
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      back,
      el("span", { class: "part-sep", text: "›" }),
      headName,
      diagIcon(editor.diagAt(part.id)),
    ]),
  );

  const body = el("div", { class: "inspector-body" }, []);
  host.appendChild(body);

  const name = commitInput(
    part.name,
    (text) => {
      if (text) editor.apply([{ op: "set_prop", node: part.id, key: "name", value: text }]);
    },
    { class: "field grow", title: "unique among siblings: the names are the part's path" },
  );
  bindField(part.id + ":name", name, () => at().name ?? "");

  const siblings = siblingsOf(editor, part.id);
  const index = siblings.findIndex((node: Json) => node?.id === part.id);

  const kindRow = el("div", { class: "row" }, [
    el("span", { class: "row-label", text: "KIND" }),
    el("span", { class: "kw", text: part.kind }),
  ]);
  kindRow.appendChild(el("span", { class: "spacer" }));
  if (index > 0)
    kindRow.appendChild(
      iconButton("arrow-up", "move this part up", () =>
        editor.apply([{ op: "move", node: part.id, index: index - 1 }]),
      ),
    );
  if (index >= 0 && index < siblings.length - 1)
    kindRow.appendChild(
      iconButton("arrow-down", "move this part down", () =>
        editor.apply([{ op: "move", node: part.id, index: index + 1 }]),
      ),
    );
  kindRow.appendChild(
    iconButton("trash", "remove this part and everything under it", () =>
      editor.apply([{ op: "remove", node: part.id }]),
    ),
  );

  body.append(
    el("div", { class: "part-def" }, [
      el("div", { class: "row" }, [
        el("span", { class: "row-label", text: "NAME" }),
        name,
        diagIcon(editor.diagAt(part.id, "name")),
      ]),
      kindRow,
    ]),
  );

  /* the properties this part OWNS: an instance edits them only while this
   * part is selected, they are stored under its path, and this part's expressions —
   * and its children's — are the only ones that can read them */
  body.append(
    ...propsSection(editor, part.id, "part-props", () => (at() as Json).props ?? [],
                    "no properties of its own"),
  );

  body.append(...attrsSection(editor, part));

  body.append(...interactSection(editor, part));

  /* A FRAME IS THE ONE KIND THAT HOLDS CHILDREN: text, icon and path are ink, and
     anything that wants to sit over them is a free frame's child, placed by its own
     x/y/w/h. The schema refuses the other three a `children` list at all, so this offers
     the button only where it would work. */
  if (part.kind === "frame") {
    const add = el("button", {
      class: "dashed-btn",
      text: "+ Child",
      title: "placed by its own x/y/w/h, fractions of this frame",
    });
    add.addEventListener("click", () => {
      const rect = add.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, "Add node",
        nodeKinds(editor).map((kind) => ({
          label: kind,
          run: () => {
            const taken = new Set(((at() as Json).children ?? []).map((c: Json) => c?.name));
            let fresh = kind;
            for (let n = 2; taken.has(fresh); n++) fresh = kind + n;
            editor.apply([
              { op: "insert", parent: part.id, list: "children",
                node: { kind, name: fresh, attrs: {} } },
            ]);
          },
        })));
    });
    body.appendChild(add);
  }
}

/* THE ATTRS SECTION, for any node anywhere. The vocabulary is CLOSED: it lists EVERY attr
 * this kind declares — its own first, then the common set every kind shares — set or not,
 * so what an unset one will do is visible without typing anything (its default as the
 * field's placeholder). The name is a static label: it is picked by which row you are on,
 * never typed, and clearing a field back to empty REMOVES the key rather than storing "",
 * so the document keeps only what was authored. Anything the document carries that the
 * vocabulary does not name is listed last, under its own heading, so it is visible and
 * removable rather than an error with nowhere to land.
 *
 * ONE implementation, exported, because a page's frame and a component's frame are the
 * same node: editing them differently would be two vocabularies wearing one name. */
export function attrsSection(editor: Editor, node: Node): HTMLElement[] {
  const at = () => (editor.store.node(node.id) as Node | null) ?? node;
  const attrsOf = () => (at().attrs ?? {}) as Record<string, string>;
  const commitAttrs = (next: Record<string, string>) =>
    editor.apply([{ op: "set_prop", node: node.id, key: "attrs", value: next }]);
  const row = (d: AttrDef) => attrDefRow(editor, node.id, d, attrsOf, commitAttrs);
  const ownDefs = ownAttrsOf(editor, node.kind);
  const place = placementAttrs(editor);
  const commonDefs = commonAttrs(editor).filter((d) => !PLACEMENT.has(d.name));
  const strays = strayAttrs(editor, node);
  return section("node-attrs", "Attrs",
                 String(ownDefs.length + place.length + commonDefs.length + strays.length),
                 () => [
    ...(ownDefs.length
      ? [attrGroupHeading("THIS " + node.kind.toUpperCase()), ...ownDefs.map(row)]
      : []),
    attrGroupHeading("THE BOX"),
    ...place.map(row),
    attrGroupHeading("COMMON"),
    ...commonDefs.map(row),
    ...(strays.length
      ? [attrGroupHeading("NOT READ BY THIS KIND"),
         ...strays.map((key) => unknownAttrRow(editor, node.id, key, attrsOf, commitAttrs))]
      : []),
  ]);
}

/* ---- the placement vocabulary: one, because there is one space ----
 *
 * Everything sits at its own x/y in canvas px (a component's internals in fractions of
 * their parent, same fields), so the box group is the same eight rows on every node. */
const MEASURED = ["x", "y", "w", "h", "aspect", "origin_x", "origin_y", "rotate"];
const PLACEMENT = new Set(MEASURED);

function placementAttrs(editor: Editor): AttrDef[] {
  const table = commonAttrs(editor);
  return MEASURED
    .map((name) => table.find((d) => d.name === name))
    .filter((d): d is AttrDef => d !== undefined);
}

/* which attrs a node's inspector will show, as a shape string: the declared set is fixed
 * by kind, so only it and the strays move it */
export function attrsShape(editor: Editor, node: Node): string {
  return node.kind + ":" + strayAttrs(editor, node).join(",");
}

/* the easing vocabulary a transition takes: the CSS names, verbatim (the backend's
   easing_profile is the same list) */
const PROFILES = ["ease", "linear", "ease-in", "ease-out", "ease-in-out"];

/* THE TRANSITION BUTTON, on exactly the attrs that land on a CSS property the browser
 * can animate (the served `css` column — the same one the compiler validates against).
 * It edits the node's `transitions` METADATA: {attr: {ms, profile?}}, merged by the
 * view into the element's native CSS `transition`. Never part of the expression, so it
 * survives every edit to the field beside it — the first of the per-field settings
 * buttons (bindings and colour tokens being the pattern), to be unified later. */
function transitionChip(editor: Editor, partId: number, def: AttrDef): HTMLElement | null {
  if (!def.css) return null;
  const rowsOf = () =>
    ((editor.store.node(partId) as Node | null)?.transitions ?? {}) as TransitionMap;
  const commit = (next: TransitionMap) =>
    editor.apply([{ op: "set_prop", node: partId, key: "transitions", value: next }]);
  const chip = iconButton("timer", "transition: how this field's picture approaches a "
                                   + "new value (the value itself is never eased)", () => {
    const rect = chip.getBoundingClientRect();
    const held = rowsOf()[def.name] ?? null;
    const ms = commitInput(held && held.ms > 0 ? String(held.ms) : "", (text) => {
      const value = Number(text);
      const next = { ...rowsOf() };
      if (Number.isFinite(value) && value > 0)
        next[def.name] = { ...(next[def.name] ?? {}), ms: value };
      else delete next[def.name];
      commit(next);
    }, { class: "field", placeholder: "none" });
    const profile = selectField(PROFILES.map((v) => ({ value: v })),
                                held?.profile ?? "ease", (v) => {
      const at = rowsOf()[def.name];
      /* a profile means nothing without a time; the ms field is what turns it on */
      if (at) commit({ ...rowsOf(), [def.name]: { ms: at.ms, profile: v } });
    });
    openMenu(rect.left, rect.bottom + 4, "transition " + def.name, [
      { node: el("div", { class: "menu-field", title: "milliseconds; empty = none" },
                 [el("span", { class: "row-label", text: "MS" }), ms]) },
      { node: el("div", { class: "menu-field" },
                 [el("span", { class: "row-label", text: "EASE" }), profile]) },
      ...(held ? [{ label: "remove the transition", icon: "trash", run: () => {
          const next = { ...rowsOf() };
          delete next[def.name];
          commit(next);
        } }] : []),
    ]);
  });
  chip.classList.add("transition-chip");
  /* lit from birth where a transition stands: the bind keeps it honest afterwards */
  if (rowsOf()[def.name]) chip.classList.add("on");
  bindFlag(partId + ":transitions." + def.name, chip, "on",
           () => !!rowsOf()[def.name]);
  return chip;
}

function attrDefRow(
  editor: Editor,
  partId: number,
  def: AttrDef,
  attrsOf: () => Record<string, string>,
  commitAttrs: (next: Record<string, string>) => void,
): HTMLElement {
  const expr = commitInput(
    String(attrsOf()[def.name] ?? ""),
    (text) => {
      const next = { ...attrsOf() };
      if (text === "") delete next[def.name];
      else next[def.name] = text;
      commitAttrs(next);
    },
    { class: "field grow", spellcheck: "false", placeholder: attrPlaceholder(def), title: def.note },
  );
  bindField(partId + ":attrs." + def.name, expr, () => String(attrsOf()[def.name] ?? ""));
  /* one icon serves both findings a row can carry: the expression's, and — where the
     expression is fine — its transition metadata's */
  const exprDiag = editor.diagAt(partId, def.name);
  const transDiag = editor.diagAt(partId, "transitions." + def.name);
  return el("div", { class: "attr-row" }, [
    el("span", { class: "field attr-name static", text: def.name, title: def.note }),
    highlighted(expr),
    transitionChip(editor, partId, def),
    diagIcon(exprDiag.length ? exprDiag : transDiag),
  ]);
}

/* A key the document carries that this kind's vocabulary does NOT declare — a hand-edited
 * document, or an attr the table dropped. The compiler flags it (`attr_name`), so without
 * a row of its own the author would be told something is wrong and handed no way to see
 * or remove it: the rows are generated from the vocabulary, and this name is not in it.
 * So it gets an explicit row, marked, carrying its finding and a delete — the standing
 * rule that nothing in the document is invisible in the editor that owns it. */
function unknownAttrRow(
  editor: Editor,
  partId: number,
  key: string,
  attrsOf: () => Record<string, string>,
  commitAttrs: (next: Record<string, string>) => void,
): HTMLElement {
  const expr = commitInput(
    String(attrsOf()[key] ?? ""),
    (text) => commitAttrs({ ...attrsOf(), [key]: text }),
    { class: "field grow", spellcheck: "false" },
  );
  bindField(partId + ":attrs." + key, expr, () => String(attrsOf()[key] ?? ""));
  return el("div", { class: "attr-row" }, [
    el("span", { class: "field attr-name static unknown", text: key,
                 title: "no part of this kind reads '" + key + "'" }),
    highlighted(expr),
    diagIcon(editor.diagAt(partId, key)),
    iconButton("x", "remove " + key, () => {
      const next = { ...attrsOf() };
      delete next[key];
      commitAttrs(next);
    }),
  ]);
}

/* THE INTERACT SECTION, for any node that can carry one.
 *
 * A GESTURE IS A PROPERTY OF A NODE, and which of the four primitives it is decides
 * everything else: the params that mean anything, and the EVENT FAMILY the part brings
 * (fixed signatures, types.ts — nothing is declared or mapped). So the PRIMITIVE picker
 * is the whole section's spine, and changing it rewrites the params to that primitive's
 * — keeping every param the new primitive also reads, so switching a dial's mode does
 * not throw away its range.
 *
 * `none` is a real choice and the one an authored node starts at: without it a node that
 * never had a gesture could not be given one, which is exactly the hole that left a custom
 * widget unable to be pressed at all.
 *
 * BUBBLES is the propagation topology, declared: on, this part's gestures also ring the
 * widget-level channel (a tap on the zone IS a tap on the widget); off, they stay the
 * part's own — the close button whose tap must not read as "the card was tapped". The
 * component's behavior hears the part channel either way.
 *
 * ONLY A BOX TAKES ONE: `interact` is a frame's prop (doc/schema.cpp) because text, icon
 * and path are ink — anything that wants to be pressed sits in a frame. The component
 * record carries no `kind` at all and IS its root frame, which is the other case here.
 *
 * One implementation for the Design part view, the Content node inspector inside an
 * entered context, and the component root itself — same node, same rows. */
export function interactSection(editor: Editor, node: Node, subject = ""): HTMLElement[] {
  const at = () => (editor.store.node(node.id) as Node | null) ?? node;
  const held = (): Json => {
    const interact = at().interact as Json;
    return interact && typeof interact === "object" ? interact : null;
  };
  const write = (value: Json) =>
    editor.apply([{ op: "set_prop", node: node.id, key: "interact", value }]);
  const interact = held();
  const box = !node.kind || node.kind === "frame";
  /* ink with a hand-written gesture: shown, so it is not invisible, but not offered a
     picker whose every write the backend would refuse */
  if (!box && !interact) return [];
  const primitive = interact ? String(interact.primitive ?? "press") : "";
  const def = primitiveDef(primitive);

  /* SWITCHING PRIMITIVE: the new one's params, with anything the author already wrote
     for a param it also reads carried across. "none" removes the gesture outright. */
  const setPrimitive = (name: string) => {
    if (!name) return write(null);
    const next = primitiveDef(name);
    if (!next) return;
    const current = held() ?? {};
    const kept = (current.params ?? {}) as Record<string, string>;
    const params: Record<string, string> = {};
    for (const [param, seed] of Object.entries(next.params))
      params[param] = kept[param] ?? seed;
    const fresh: Json = { primitive: name, params };
    if (current.bubbles === false) fresh.bubbles = false;
    write(fresh);
  };

  const picker = selectField(
    [{ value: "", label: "none" },
     ...PRIMITIVES.map((p) => ({ value: p.name, label: p.name + " — " + p.note }))],
    primitive,
    setPrimitive,
  );
  bindChoice(node.id + ":interact.primitive", pickerOf(picker), () =>
    String(held()?.primitive ?? ""));

  return section("part-interact", "Interact", null, () => [
    box
      ? el("div", { class: "row" }, [
          el("span", { class: "row-label", text: "GESTURE" }),
          picker,
        ])
      : el("div", { class: "row" }, [
          el("span", { class: "row-label", text: "GESTURE" }),
          el("span", { class: "kw", text: primitive }),
        ]),
    box && !interact
      ? el("p", { class: "empty",
                  text: "no gesture" + (subject ? " on " + subject : "") +
                        " — pick one and this node becomes pressable" })
      : null,
    ...(interact ? Object.keys((interact.params ?? {}) as Record<string, string>)
                     .map((param) => interactParamRow(editor, node.id, param, at)) : []),
    /* what the primitive BRINGS: the family with its signatures, read-only — picking
       the primitive IS the declaration */
    ...(interact && def
      ? [el("div", { class: "row" }, [
          el("span", { class: "row-label", text: "BRINGS" }),
          el("span", { class: "kw", text: def.events
            .map((name) => signatureText(name, eventKind(name)?.params ?? []))
            .join("  ") }),
        ])]
      : []),
    /* the bubbling toggle, on NAMED parts only: the root's channel IS the widget-level
       one, so it has nothing to opt out of */
    ...(interact && subject ? [bubblesRow(node.id, held, write)] : []),
  ]);
}

function bubblesRow(nodeId: number, held: () => Json,
                    write: (value: Json) => void): HTMLElement {
  const picker = selectField(
    [{ value: "on", label: "ring the widget too" },
     { value: "off", label: "this part only" }],
    held()?.bubbles === false ? "off" : "on",
    (choice) => {
      const next = { ...(held() ?? {}) };
      if (choice === "off") next.bubbles = false;
      else delete next.bubbles;
      write(next);
    },
  );
  bindChoice(nodeId + ":interact.bubbles", pickerOf(picker), () =>
    held()?.bubbles === false ? "off" : "on");
  return el("div", { class: "row" }, [
    el("span", { class: "row-label", text: "REACH" }),
    picker,
  ]);
}

/* the built-in component view addressed by NAME: what an entered-but-unforked
 * built-in context stands on (the Design browse path builds the same view from
 * `builtinSel`). False when no built-in wears the name, so the caller can fall back. */
export function renderBuiltinComponent(host: HTMLElement, editor: Editor,
                                       name: string): boolean {
  const comp = (editor.builtins ?? []).find((b: Json) => b?.name === name);
  if (!comp) return false;
  renderBuiltinComponentView(host, editor, { comp, part: null, path: "", address: "" });
  return true;
}

function interactParamRow(
  editor: Editor,
  partId: number,
  param: string,
  at: () => Json,
): HTMLElement {
  const paramsOf = () => ((at().interact ?? {}).params ?? {}) as Record<string, string>;
  const expr = commitInput(
    String(paramsOf()[param] ?? ""),
    (text) => {
      const held = (at().interact ?? {}) as Json;
      editor.apply([
        { op: "set_prop", node: partId, key: "interact",
          value: { ...held, params: { ...paramsOf(), [param]: text } } },
      ]);
    },
    { class: "field grow", spellcheck: "false" },
  );
  bindField(partId + ":interact." + param, expr, () => String(paramsOf()[param] ?? ""));
  return el("div", { class: "attr-row" }, [
    el("span", { class: "field attr-name static", text: param }),
    highlighted(expr),
    diagIcon(editor.diagAt(partId, "interact." + param)),
  ]);
}
