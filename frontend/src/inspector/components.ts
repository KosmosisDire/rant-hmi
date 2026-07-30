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
import { bindChoice, bindField, bindText } from "../reconcile.js";
import { ComponentDef, Json, PartNode, PropDef, SlotSpec } from "../types.js";
import { valueEditor } from "./editors.js";

const PROP_SHAPES = ["num", "bool", "text", "color", "enum", "series"];
const PROP_GROUPS = ["value", "appearance", "config", "frame"];
const PART_KINDS = ["box", "rect", "bar", "text", "icon", "arc", "needle", "mark",
                    "ticks", "plot"];

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
      attrs: Object.keys(part.attrs ?? {}),
      interact: interact
        ? { primitive: interact.primitive ?? "press",
            params: Object.keys(interact.params ?? {}),
            emits: interact.emits ?? {} }
        : null,
      index: siblings.findIndex((node: Json) => node?.id === part.id),
      count: siblings.length,
      diag: diagShape(editor, part.id),
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
   *    group are the whole slot spec an instance sees. */
  const props = comp.props ?? [];
  body.append(
    ...section("comp-props", "Properties", String(props.length), () => [
      ...props.map((prop) => propRow(editor, prop)),
      props.length ? null : el("p", { class: "empty", text: "no properties yet" }),
      el("button", {
        class: "dashed-btn",
        text: "+ Property",
        onclick: () => {
          const taken = new Set((at().props ?? []).map((p) => p.name));
          let fresh = "prop1";
          for (let n = 1; taken.has(fresh); n++) fresh = "prop" + n;
          editor.apply([{ op: "insert", parent: comp.id, list: "props", node: { name: fresh } }]);
        },
      }),
    ]),
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

  /* the attrs table: one row per entry, name + expression text. Renaming rebuilds the
   * whole object in place so the entry keeps its position. */
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

  if (isBox) {
    const add = el("button", { class: "dashed-btn", text: "+ Child part" });
    add.addEventListener("click", () => {
      const rect = add.getBoundingClientRect();
      openMenu(rect.left, rect.bottom + 4, "Add part",
        PART_KINDS.map((kind) => ({
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
