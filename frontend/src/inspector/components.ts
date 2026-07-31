/* The component-editing inspector (spec 2.3, 3.1): the views behind the Components
 * tree. A COMPONENT selection edits the type's own record — its name (a plain
 * set_prop: nothing references a component by id, and instances typed by the old name
 * simply lose their type, which the missing-type marker already says), a read-only
 * events summary, the PROPERTIES table (one PropDef row each, the slot editors
 * reused for the default), and a read-only behavior summary. A PART selection edits
 * one template node: its name, a box's dir, the ATTRS table (attr name + expression
 * text with the highlight underlay, committed as the WHOLE attrs object exactly like
 * a widget's `slots`), the interact's params, and the structural acts (add child,
 * move, delete). Everything is ordinary ops: the backend recompiles and the
 * registry-changed snapshot delivers the new derived type to every instance live. */

import { commitInput, el, iconButton, pickerOf, selectField } from "../dom.js";
import { diagIcon, Editor, section } from "../editor.js";
import { highlighted } from "../highlight.js";
import { openMenu } from "../menu.js";
import { bindChoice, bindField, bindText, shownValue } from "../reconcile.js";
import { AttrDef, ComponentDef, Json, PartNode, PropDef, SlotSpec } from "../types.js";
import { valueEditor } from "./editors.js";

const PROP_SHAPES = ["num", "bool", "text", "color", "enum", "series"];
const PROP_GROUPS = ["value", "appearance", "config", "frame"];

/* the closed attr vocabulary (spec 2.3): `editor.attrTable` is snapshot-only data, so
 * these read straight off it rather than caching — a part kind with nothing of its own
 * (box) or an offline editor with no table yet both fall back to an empty list, never
 * a crash. `code` is the one open kind and never reads from here (see codeSection /
 * the "code" branch of the attrs section below): its own row is deliberately never
 * looked up by these. */
function ownAttrsOf(editor: Editor, kind: string): AttrDef[] {
  return editor.attrTable?.perKind[kind] ?? [];
}
function commonAttrs(editor: Editor): AttrDef[] {
  return editor.attrTable?.common ?? [];
}
function partKinds(editor: Editor): string[] {
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

/* The keys a part carries that its kind's vocabulary does NOT declare. ONE definition,
 * because both the shape string and the render need it and they must not disagree: the
 * declared rows are fixed by `kind` alone, but a stray adds a row, so which strays exist
 * is structure and has to ride the shape. `code` has an open vocabulary and never strays. */
function strayAttrs(editor: Editor, part: PartNode): string[] {
  if (part.kind === "code") return [];
  const declared = new Set(
    [...ownAttrsOf(editor, part.kind), ...commonAttrs(editor)].map((d) => d.name));
  return Object.keys((part.attrs ?? {}) as Record<string, string>)
    .filter((key) => !declared.has(key));
}

/* the "THIS PART" / "COMMON" divider between a kind's own attrs and the set every kind
 * shares: the existing row-label idiom (KIND, ADDRESS, DEFAULT, GROUP, ...), not a new
 * visual language */
function attrGroupHeading(text: string): HTMLElement {
  return el("div", { class: "row" }, [el("span", { class: "row-label", text })]);
}

/* the selection resolved against the store: a vanished part falls back to the
 * component, a vanished component to null (the widget inspector then applies) */
function selection(editor: Editor): { comp: ComponentDef; part: PartNode | null } | null {
  const sel = editor.componentSel;
  if (!sel) return null;
  const comp = editor.store.node(sel.component) as ComponentDef | null;
  if (!comp) return null;
  if (sel.node === sel.component) return { comp, part: null };
  const part = editor.store.node(sel.node) as PartNode | null;
  return { comp, part: part && typeof part.kind === "string" ? part : null };
}

/* the list a part sits in: a box's children, or the component's parts for the root */
function siblingsOf(editor: Editor, partId: number): Json[] {
  const parent = editor.store.parentOf(partId) as Json;
  if (!parent) return [];
  for (const key of ["children", "parts"]) {
    const list = parent[key];
    if (Array.isArray(list) && list.some((node: Json) => node?.id === partId)) return list;
  }
  return [];
}

/* ---- the browsed built-in (spec 2.3 Forking) ----
 *
 * The same definition an Override would copy, shown read-only. It is not in the
 * document, so nothing here binds, applies an op or looks anything up in the store: a
 * built-in never changes at runtime, which is exactly why one static render is enough.
 *
 * `path` is a CHILD-INDEX path into `parts` ("" = the component, "0" = its root part,
 * "0.1" = that part's second child). `address` is the different thing the reader
 * actually wants: the part's SLOT ADDRESS prefix — the names joined below the template
 * root, which is what its properties are addressed under and what an instance's nested
 * `slots` mirror (spec 2.3). The root contributes no segment, so it is dropped. */
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
  let list: Json[] = Array.isArray(comp.parts) ? (comp.parts as Json[]) : [];
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
  return { comp, part, path: sel.path, address: names.slice(1).join(".") };
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
  const keys = Object.keys(attrs);

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
  if (kind === "box")
    kindRow.append(
      el("span", { class: "row-label", text: "DIR" }),
      el("span", { class: "kw", text: String(part?.dir ?? "stack") }),
    );
  body.append(
    el("div", { class: "part-def" }, [
      kindRow,
      /* the one thing a reader of a built-in is really after: what this part's
         properties are called from the outside (spec 2.3) */
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

  /* the closed vocabulary (spec 2.3): every attr this KIND declares, own first then
   * common, with the built-in's authored text where it set one — same idiom as the
   * editable part view below, minus the commit wiring. `code` alone keeps the old
   * free-form listing (its own attrs are never in the table at all). */
  const attrDefRow = (def: AttrDef): HTMLElement => {
    const raw = attrs[def.name];
    return el("div", { class: "attr-row" }, [
      el("span", { class: "field attr-name static", text: def.name, title: def.note }),
      exprView(typeof raw === "string" ? raw : "", attrPlaceholder(def), def.note),
    ]);
  };
  const ownDefs = kind === "code" ? [] : ownAttrsOf(editor, kind);
  const commonDefs = kind === "code" ? [] : commonAttrs(editor);
  body.append(
    ...section(
      "builtin-attrs", "Attrs",
      String(kind === "code" ? keys.length : ownDefs.length + commonDefs.length),
      () =>
        kind === "code"
          ? [
              ...keys.map((key) =>
                el("div", { class: "attr-row" }, [
                  el("span", { class: "field attr-name static", text: key }),
                  exprView(String(attrs[key] ?? "")),
                ]),
              ),
              keys.length ? null : el("p", { class: "empty", text: "no attrs" }),
            ]
          : [
              ...(ownDefs.length
                ? [attrGroupHeading("THIS PART"), ...ownDefs.map(attrDefRow)]
                : []),
              attrGroupHeading("COMMON"),
              ...commonDefs.map(attrDefRow),
            ],
    ),
  );

  if (kind === "code") {
    const source = el("textarea", {
      class: "field code-editor",
      spellcheck: "false",
      rows: "8",
      readonly: "readonly",
    }) as HTMLTextAreaElement;
    source.value = String(part?.code ?? "");
    body.append(...section("builtin-code", "Code", null, () => [source]));
  }

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
    const interact = part.interact as Json;
    return JSON.stringify({
      comp: comp.id,
      part: part.id,
      kind: part.kind,
      props: ((part as Json).props ?? []).map((p: PropDef) =>
        [p.id, p.shape, p.group, (p.variants ?? []).join("|"), p.editor ?? ""]),
      /* the closed vocabulary (spec 2.3) fixes the declared row SET by kind, already
         covered by the `kind` key above, so a value or diag change needs no shape bump
         (bindField and the diag icon's own hover state handle those live). Two things
         still add rows: `code`, whose vocabulary is open, and an undeclared key the
         document carries, which gets a row of its own so it can be removed. */
      attrs: part.kind === "code"
        ? Object.keys(part.attrs ?? {})
        : strayAttrs(editor, part),
      interact: interact
        ? { primitive: interact.primitive ?? "press",
            params: Object.keys(interact.params ?? {}),
            emits: interact.emits ?? {} }
        : null,
      index: siblings.findIndex((node: Json) => node?.id === part.id),
      count: siblings.length,
      diag: diagShape(editor, part.id).concat(
        ((part as Json).props ?? []).flatMap((p: PropDef) => diagShape(editor, p.id))),
    });
  }
  return JSON.stringify({
    comp: comp.id,
    props: (comp.props ?? []).map((p) => [p.id, p.shape, p.group,
                                          (p.variants ?? []).join("|"), p.editor ?? ""]),
    events: comp.events ?? [],
    behavior: (comp.behavior ?? []).map(flowSummary),
    diag: diagShape(editor, comp.id)
      .concat((comp.props ?? []).flatMap((p) => diagShape(editor, p.id))),
  });
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

/* ---- the component view ---- */

function renderComponentView(host: HTMLElement, editor: Editor, comp: ComponentDef): void {
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

  /* 1. Events: what instances can trigger on. Read-only for now: the vocabulary is
   *    coupled to the interacts in the parts tree, so it is edited there. */
  const events = comp.events ?? [];
  body.append(
    ...section("comp-events", "Events", String(events.length), () => [
      ...events.map((evt) =>
        el("div", { class: "event-line" }, [
          el("span", { class: "kw", text: evt.name }),
          el("span", { class: "op", text: "x: " + evt.x }),
          evt.value ? el("code", { class: "event-expr", text: evt.value }) : null,
        ]),
      ),
      events.length ? null : el("p", { class: "empty", text: "no events" }),
    ]),
  );

  /* 2. Properties: one PropDef row per served slot. The name, shape, default and
   *    group are the whole slot spec an instance sees. These are the WIDGET's own —
   *    what an instance shows while the widget itself is selected; a property that
   *    belongs to one part is declared on that part (spec 2.3). */
  body.append(
    ...propsSection(editor, comp.id, "comp-props", () => at().props ?? [],
                    "no properties yet"),
  );

  /* 3. Behavior: the type's default flows, summarized. Full flow editing stays on
   *    instances (and the shared flow editor) for now. */
  const flows = comp.behavior ?? [];
  body.append(
    ...section("comp-behavior", "Behavior", String(flows.length), () => [
      ...flows.map((flow) => el("div", { class: "flow-line", text: flowSummary(flow) })),
      flows.length ? null : el("p", { class: "empty", text: "no default behavior" }),
    ]),
  );

  /* 4. Design frame: the component's own authored size — what the future Design
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

/* The properties one owner declares — a component (the widget's own vocabulary) or a
 * part (what that part paints). One section, two callers, because the row is the same
 * thing in both places and so is the rule: a property is declared where it is read. */
function propsSection(
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
                        part: PartNode): void {
  const at = () => (editor.store.node(part.id) as PartNode | null) ?? part;
  const attrsOf = () => (at().attrs ?? {}) as Record<string, string>;
  const commitAttrs = (next: Record<string, string>) =>
    editor.apply([{ op: "set_prop", node: part.id, key: "attrs", value: next }]);

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
  const isBox = part.kind === "box";

  const kindRow = el("div", { class: "row" }, [
    el("span", { class: "row-label", text: "KIND" }),
    el("span", { class: "kw", text: part.kind }),
  ]);
  if (isBox) {
    const dir = selectField(
      ["row", "col", "stack", "auto"].map((v) => ({ value: v })),
      (part as Json).dir ?? "stack",
      (v) => editor.apply([{ op: "set_prop", node: part.id, key: "dir", value: v }]),
    );
    bindChoice(part.id + ":dir", pickerOf(dir), () => (at() as Json).dir ?? "stack");
    kindRow.append(el("span", { class: "row-label", text: "DIR" }), dir);
  }
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

  /* the properties this part OWNS (spec 2.3): an instance edits them only while this
   * part is selected, they are stored under its path, and this part's expressions —
   * and its children's — are the only ones that can read them */
  body.append(
    ...propsSection(editor, part.id, "part-props", () => (at() as Json).props ?? [],
                    "no properties of its own"),
  );

  /* the attrs table (spec 2.3). The vocabulary is CLOSED: the section lists EVERY attr
   * this kind declares — its own first, then the common set every kind shares — set or
   * not, so what an unset one will do is visible without typing anything (its renderer
   * default as the field's placeholder). The name is a static label now: it is picked
   * by which row you are on, never typed, and clearing a field back to empty REMOVES
   * the key (attrDefRow) rather than storing "", so the document keeps only what was
   * authored. `code` is the one exception, unchanged: its body reads `view.attrs` by
   * whatever names its own JS chose, an open set no table could close, so it alone
   * keeps the free-form rows (add, rename, delete) this section always had. */
  if (part.kind === "code") {
    const keys = Object.keys(part.attrs ?? {});
    body.append(
      ...section("part-attrs", "Attrs", String(keys.length), () => [
        ...keys.map((key) => attrRow(editor, part.id, key, attrsOf, commitAttrs)),
        keys.length ? null : el("p", { class: "empty", text: "no attrs yet" }),
        el("button", {
          class: "dashed-btn",
          text: "+ Attr",
          onclick: () => {
            const taken = new Set(Object.keys(attrsOf()));
            let fresh = "attr1";
            for (let n = 1; taken.has(fresh); n++) fresh = "attr" + n;
            commitAttrs({ ...attrsOf(), [fresh]: "" });
          },
        }),
      ]),
    );
  } else {
    const ownDefs = ownAttrsOf(editor, part.kind);
    const commonDefs = commonAttrs(editor);
    /* anything the document carries that the vocabulary does not name: rendered last,
       under its own heading, so it is visible and removable rather than an error with
       nowhere to land (unknownAttrRow) */
    const strays = strayAttrs(editor, part);
    body.append(
      ...section("part-attrs", "Attrs",
                 String(ownDefs.length + commonDefs.length + strays.length), () => [
        ...(ownDefs.length
          ? [attrGroupHeading("THIS PART"),
             ...ownDefs.map((d) => attrDefRow(editor, part.id, d, attrsOf, commitAttrs))]
          : []),
        attrGroupHeading("COMMON"),
        ...commonDefs.map((d) => attrDefRow(editor, part.id, d, attrsOf, commitAttrs)),
        ...(strays.length
          ? [attrGroupHeading("NOT READ BY THIS KIND"),
             ...strays.map((key) => unknownAttrRow(editor, part.id, key, attrsOf, commitAttrs))]
          : []),
      ]),
    );
  }

  /* the `code` kind's body (spec 2.3): user-authored JavaScript, so it gets a dedicated
   * multi-line editor instead of the one-line attr rows above (`attrs` still applies to
   * a code part — repeat, show, the transform — only the body itself needs this). */
  if (part.kind === "code") body.append(...codeSection(editor, part));

  /* the interact, when the part carries one: primitive and emits are read-only (the
   * primitive's vocabulary is closed), the params are expressions like any attr */
  const interact = part.interact as Json;
  if (interact && typeof interact === "object") {
    const params = Object.keys(interact.params ?? {});
    const emits = Object.entries((interact.emits ?? {}) as Record<string, string>);
    body.append(
      ...section("part-interact", "Interact", null, () => [
        el("div", { class: "row" }, [
          el("span", { class: "row-label", text: "PRIMITIVE" }),
          el("span", { class: "kw", text: String(interact.primitive ?? "press") }),
        ]),
        ...params.map((param) => interactParamRow(editor, part.id, param, at)),
        ...emits.map(([gesture, event]) =>
          el("div", { class: "row" }, [
            el("span", { class: "row-label", text: "EMITS" }),
            el("span", { class: "kw", text: gesture + " → " + event }),
          ]),
        ),
      ]),
    );
  }

  /* ANY part takes children now (spec 2.3), not just a box: a draw part paints its
     shape and its children ride over it, which is how a knob's dot lives on its face
     instead of beside it behind a wrapper box */
  {
    const add = el("button", {
      class: "dashed-btn",
      text: "+ Child part",
      title: isBox
        ? "a box lays its children out by `dir`"
        : "a draw part paints its shape, then its children over it",
    });
    add.addEventListener("click", () => {
      const rect = add.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, "Add part",
        partKinds(editor).map((kind) => ({
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

/* The `code` part's body editor: a multi-line monospace textarea (`.code-editor` in
 * styles.css; `.field` already sets the monospace font every field here uses), resizable
 * vertically since a JS body can run long. It follows the file's commit idiom — commit on
 * blur/change, Escape reverts to the last value the reconciler pushed in (shownValue) —
 * with two deliberate departures from `commitInput`/`commitTextInput`: Enter must NOT
 * commit (it is an ordinary newline in the source), and Tab inserts two spaces rather
 * than moving focus, since a code body is the one field here that needs both. */
function codeSection(editor: Editor, part: PartNode): HTMLElement[] {
  const at = () => (editor.store.node(part.id) as PartNode | null) ?? part;
  const commit = (text: string) =>
    editor.apply([{ op: "set_prop", node: part.id, key: "code", value: text }]);
  const textarea = el("textarea", {
    class: "field code-editor",
    spellcheck: "false",
    rows: "8",
    onkeydown: (ev: KeyboardEvent) => {
      const input = ev.target as HTMLTextAreaElement;
      if (ev.key === "Tab") {
        ev.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = input.value.slice(0, start) + "  " + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + 2;
        return;
      }
      if (ev.key === "Escape") {
        input.value = shownValue(input) ?? "";
        input.blur();
      }
    },
    onchange: (ev: Event) => commit((ev.target as HTMLTextAreaElement).value),
  }) as HTMLTextAreaElement;
  bindField(part.id + ":code", textarea, () => at().code ?? "");
  return section("part-code", "Code", null, () => [textarea]);
}

function attrRow(
  editor: Editor,
  partId: number,
  key: string,
  attrsOf: () => Record<string, string>,
  commitAttrs: (next: Record<string, string>) => void,
): HTMLElement {
  const name = commitInput(
    key,
    (text) => {
      if (!text || text === key) return;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrsOf())) next[k === key ? text : k] = v;
      commitAttrs(next);
    },
    { class: "field attr-name" },
  );
  bindField(partId + ":attrs." + key + ".key", name, () => key);
  const expr = commitInput(
    String(attrsOf()[key] ?? ""),
    (text) => commitAttrs({ ...attrsOf(), [key]: text }),
    { class: "field grow", spellcheck: "false" },
  );
  bindField(partId + ":attrs." + key, expr, () => String(attrsOf()[key] ?? ""));
  return el("div", { class: "attr-row" }, [
    name,
    highlighted(expr),
    diagIcon(editor.diagAt(partId, key)),
    iconButton("x", "remove " + key, () => {
      const next = { ...attrsOf() };
      delete next[key];
      commitAttrs(next);
    }),
  ]);
}

/* One row of the CLOSED vocabulary (spec 2.3): the name is a static label — the
 * vocabulary is picked by which row you are on, not typed — and the value is the same
 * highlighted expression field every attr row has always used. An unset attr shows the
 * renderer's own default (or, where there is none, the note explaining what absence
 * means) as the field's placeholder, so its effect is visible without filling it in.
 * Typing a value commits it into the attrs object; clearing it back to empty REMOVES
 * the key rather than storing "", so the document keeps only what was actually
 * authored — unlike `attrRow` above, there is no separate remove button, because
 * clearing the field already says the same thing. */
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
