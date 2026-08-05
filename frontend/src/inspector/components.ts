/* The component-editing inspector: the views behind the Components tree.
 *
 * A COMPONENT selection edits the type's own record — its name (a plain set_prop:
 * nothing references a component by id, and instances typed by the old name simply lose
 * their type, which the missing-type marker already says), a read-only events summary,
 * the PROPERTIES table (one PropDef row each, the slot editors reused for the default),
 * and a read-only behavior summary.
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
import { highlighted } from "../highlight.js";
import { MenuItem, openMenu } from "../menu.js";
import { bindChoice, bindField, bindText } from "../reconcile.js";
import { AttrDef, ComponentDef, EVENT_KINDS, EventSpec, Json, Node, PRIMITIVES, PropDef,
         SlotSpec, eventKind, primitiveDef } from "../types.js";
import { valueEditor } from "./editors.js";

const PROP_SHAPES = ["num", "bool", "text", "color", "enum", "list", "map"];
const PROP_GROUPS = ["value", "appearance", "config", "frame"];
/* what an event's `x` may be: the shapes a PROPOSAL can have. A list or a map is not
   one (a gesture never carries a history) and `enum` needs a type to name its variants,
   which an event row has nowhere to put — the enum's own text name is what travels. */
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
    /* an event's NAME is its row's identity (there is no id to bind by), and whether some
       gesture raises it decides whether the row wears the mark — everything else on the
       row is a value the bindings push in */
    events: (comp.events ?? []).map((e) => e.name),
    raised: Array.from(raisedEvents(comp)).sort(),
    /* the component record IS the root node, so its gesture rides this view too: the
       primitive decides which param and posts rows exist */
    interact: ownedShape(comp as unknown as Json).interact,
    behavior: (comp.behavior ?? []).map(flowSummary),
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

  /* 4. Behavior: the type's default flows, summarized. Full flow editing stays on
   *    instances (and the shared flow editor) for now. */
  const flows = comp.behavior ?? [];
  body.append(
    ...section("comp-behavior", "Behavior", String(flows.length), () => [
      ...flows.map((flow) => el("div", { class: "flow-line", text: flowSummary(flow) })),
      flows.length ? null : el("p", { class: "empty", text: "no default behavior" }),
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
 * AN EVENT IS WHAT AN INSTANCE'S FLOW TRIGGERS ON. The row set is the component's own
 * `events` array, edited as a whole (it is a plain array prop, not a child list, so there
 * are no ids to address a row by — the NAME is the identity, which is why it is picked
 * rather than typed). What each row carries is the two things a trigger needs: the SHAPE
 * of `x`, and optionally the expression that derives `x` from the widget's own slots — a
 * Toggle's tap proposes `!widget.value`, so no flow has to restate the widget's logic.
 *
 * WHAT IS OFFERED IS WHAT CAN FIRE: the vocabulary is closed (types.ts EVENT_KINDS), and
 * the add menu separates the events some gesture in this component actually raises from
 * the ones nothing does. A declared event nothing raises is still shown, marked — it is
 * the trigger that would never fire, and hiding it would only make it harder to find. */
function raisedEvents(comp: Json): Set<string> {
  const out = new Set<string>();
  const walk = (node: Json) => {
    const interact = node?.interact;
    if (interact && typeof interact === "object")
      for (const event of Object.values((interact.emits ?? {}) as Record<string, string>))
        if (event) out.add(String(event));
    for (const kid of (node?.children ?? []) as Json[]) walk(kid);
  };
  walk(comp);
  /* the pair the SCHEDULER derives: a press on the wire fires held (past its hold_ms) and
     the down half of pressrelease, with nothing in any emits map naming them */
  if (out.has("press")) { out.add("held"); out.add("pressrelease"); }
  if (out.has("release")) out.add("pressrelease");
  return out;
}

function eventsSection(editor: Editor, comp: ComponentDef): HTMLElement[] {
  const at = () => (editor.store.node(comp.id) as ComponentDef | null) ?? comp;
  const eventsAt = (): EventSpec[] => at().events ?? [];
  const commit = (next: EventSpec[]) =>
    editor.apply([{ op: "set_prop", node: comp.id, key: "events", value: next }]);
  const raised = raisedEvents(at());
  const events = eventsAt();

  const add = (name: string) => {
    const kind = eventKind(name);
    commit([...eventsAt(), { name, x: kind?.x ?? "bool" }]);
  };
  const openAdd = (host: HTMLElement) => {
    const rect = host.getBoundingClientRect();
    const taken = new Set(eventsAt().map((e) => e.name));
    const free = EVENT_KINDS.filter((k) => !taken.has(k.name));
    const item = (name: string, past: string): MenuItem =>
      ({ label: name + " — " + past, run: () => add(name) });
    const live = free.filter((k) => raised.has(k.name));
    const dead = free.filter((k) => !raised.has(k.name));
    const items: MenuItem[] = [
      ...live.map((k) => item(k.name, k.past)),
      ...(live.length && dead.length ? [{ separator: true }] : []),
      ...(dead.length
        ? [{ node: el("div", { class: "menu-note",
                               text: "nothing in this component raises these yet" }) },
           ...dead.map((k) => item(k.name, k.past))]
        : []),
      ...(free.length ? [] : [{ node: el("div", { class: "menu-note",
                                                  text: "every event is already declared" }) }]),
    ];
    openMenu(rect.left, rect.bottom + 4, "Add event", items);
  };

  return section("comp-events", "Events", String(events.length), () => [
    ...events.map((evt) => eventRow(comp.id, evt.name, raised, eventsAt, commit)),
    events.length
      ? null
      : el("p", { class: "empty",
                  text: "no events — an instance of this widget can trigger nothing" }),
    el("button", {
      class: "dashed-btn",
      text: "+ Event",
      onclick: (ev: MouseEvent) => openAdd(ev.currentTarget as HTMLElement),
    }),
  ]);
}

/* NO FINDING RIDES THIS ROW, deliberately: an events array is a plain prop, so the
   compiler pins a bad proposal to the INSTANCE that failed to compile it (build_event_values
   has no id for the row), and a diag icon here would have nothing to show. */
function eventRow(
  compId: number,
  name: string,
  raised: Set<string>,
  eventsAt: () => EventSpec[],
  commit: (next: EventSpec[]) => void,
): HTMLElement {
  const kind = eventKind(name);
  const rowAt = (): EventSpec => eventsAt().find((e) => e.name === name) ?? { name, x: "bool" };
  const patch = (next: Partial<EventSpec>) =>
    commit(eventsAt().map((e) => (e.name === name ? { ...e, ...next } : e)));
  const fires = raised.has(name);

  const shape = selectField(EVENT_SHAPES.map((v) => ({ value: v })), rowAt().x || "bool", (v) =>
    patch({ x: v }),
  );
  bindChoice(compId + ":events." + name + ".x", pickerOf(shape), () => rowAt().x || "bool");

  /* the PROPOSAL: a wire-tier expression over this widget's slots, evaluated once and
     pinned per gesture. Empty means the gesture's own value stands (a drag already carries
     its number), and clearing the field removes the key rather than storing "" — the same
     rule every attr row follows. */
  const value = commitInput(
    rowAt().value ?? "",
    (text) => patch({ value: text || undefined }),
    { class: "field grow", spellcheck: "false",
      placeholder: "the gesture's own value",
      title: "what this widget PROPOSES on " + name + ", as an expression over its slots" },
  );
  bindField(compId + ":events." + name + ".value", value, () => rowAt().value ?? "");

  return el("div", { class: "eventdef" }, [
    el("div", { class: "row" }, [
      el("span", { class: "kw grow", text: name,
                   title: fires
                     ? "an instance triggers on this when it is " + (kind?.past ?? name)
                     : "declared, but no gesture in this component raises it" }),
      fires ? null : el("span", { class: "badge dead", text: "not raised" }),
      shape,
      iconButton("trash", "remove this event", () =>
        commit(eventsAt().filter((e) => e.name !== name)),
      ),
    ]),
    el("div", { class: "row" }, [
      el("span", { class: "row-label", text: "x IS" }),
      highlighted(value),
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
  return el("div", { class: "attr-row" }, [
    el("span", { class: "field attr-name static", text: def.name, title: def.note }),
    highlighted(expr),
    diagIcon(editor.diagAt(partId, def.name)),
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
 * everything else: the params that mean anything, and the gestures there are to post. So
 * the PRIMITIVE picker is the whole section's spine, and changing it rewrites the params
 * and emits to that primitive's — keeping every param the new primitive also reads, so
 * switching a dial's mode does not throw away its range.
 *
 * `none` is a real choice and the one an authored node starts at: without it a node that
 * never had a gesture could not be given one, which is exactly the hole that left a custom
 * widget unable to be pressed at all.
 *
 * EMITS is gesture → event NAME: the view posts a gesture and the type names the event a
 * flow triggers on, and mapping a radial's `select` (instead of its input/commit) is what
 * turns a dial into a detent selector. Empty means the gesture is not posted at all.
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

  /* SWITCHING PRIMITIVE: the new one's params, with anything the author already wrote for
     a param it also reads carried across; its emits fresh, because the gestures they map
     are the ones that just changed. "none" removes the gesture outright. */
  const setPrimitive = (name: string) => {
    if (!name) return write(null);
    const next = primitiveDef(name);
    if (!next) return;
    const kept = (held()?.params ?? {}) as Record<string, string>;
    const params: Record<string, string> = {};
    for (const [param, seed] of Object.entries(next.params))
      params[param] = kept[param] ?? seed;
    write({ primitive: name, params, emits: { ...next.emits } });
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
    ...(interact && def
      ? [attrGroupHeading("POSTS"),
         ...def.gestures.map((gesture) => emitRow(node.id, gesture, held, write))]
      : []),
    /* a primitive nothing in the table names (a hand-edited document): its map is still
       shown, read-only, rather than silently dropped by a render that knows no gestures */
    ...(interact && !def
      ? Object.entries((interact.emits ?? {}) as Record<string, string>).map(([g, e]) =>
          el("div", { class: "row" }, [
            el("span", { class: "row-label", text: "POSTS" }),
            el("span", { class: "kw", text: g + " → " + e }),
          ]))
      : []),
  ]);
}

/* one gesture the chosen primitive posts, and the event name it goes out as. The picker
   is the closed event vocabulary plus "not posted", because an event name nothing can
   trigger on is a typo the author would only find at run time. */
function emitRow(
  nodeId: number,
  gesture: string,
  held: () => Json,
  write: (value: Json) => void,
): HTMLElement {
  const emitsOf = () => ((held()?.emits ?? {}) as Record<string, string>);
  const picker = selectField(
    [{ value: "", label: "not posted" },
     ...EVENT_KINDS.filter((k) => !k.derived).map((k) => ({ value: k.name }))],
    emitsOf()[gesture] ?? "",
    (name) => {
      const next = { ...emitsOf() };
      if (name) next[gesture] = name;
      else delete next[gesture];
      write({ ...(held() ?? {}), emits: next });
    },
  );
  bindChoice(nodeId + ":interact.emits." + gesture, pickerOf(picker), () =>
    emitsOf()[gesture] ?? "");
  return el("div", { class: "attr-row" }, [
    el("span", { class: "field attr-name static", text: gesture,
                 title: "what the view posts when this node is " + gesture }),
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
