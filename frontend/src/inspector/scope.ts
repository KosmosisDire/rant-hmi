/* THE ONE SCOPE PROVIDER: what an expression at a given surface may reference.
 *
 * Surfaces differ only in vocabulary — the tier, the names that stand, what x holds,
 * whether color tokens are legal — never in control shape, so all of that knowledge is
 * served through ONE object and the fields stay ignorant of flows, feeds and vars.
 * Autocomplete consumes a Scope today; the value box's browse tree will consume the
 * same one, which is what keeps the dropdown and the tree from ever disagreeing.
 *
 * Factories live where knowledge lives: a call site picks its factory and hands the
 * Scope on. */

import { TokenAccess } from "../colorpicker.js";
import { Editor } from "../editor.js";
import { resolveColor } from "../slots.js";
import { ComponentDef, Feed, Flow, Json, Lang, MeshField, Node, Var } from "../types.js";
import { scopeAt } from "./flowscope.js";

export interface NameRow {
  label: string;   /* what inserting places: "setpoint", "widget.value", "x" */
  shape?: string;  /* its shape, when known: "num" "bool" "text" "list" ... */
  note?: string;   /* a short origin tag: "local", "global", "slot" */
  elem?: string;   /* aggregate names: the element shape */
  fields?: MeshField[];   /* struct names: the field table behind the dot */
}

/* One value surface's whole reference universe. Affordances hide by ABSENCE: a surface
 * with no x() has no pipeline register (the name is never offered), one with no
 * tokens() cannot spell a color token. */
export interface Scope {
  /* "display" (a feed's transform) and "wire" (a flow guard/source) are the two
     SCALAR positions; "attr" is a template attribute, compiled by a
     different compiler (template_expr.cpp) with a smaller vocabulary again -- a row
     can be legal on "display" and still have no view encoding (rgb was, until the
     two tiers gained a shared vocabulary), so this needs its own filter rather than
     reusing "display"'s. "const" sees nothing live at all (a prop default). */
  tier: "display" | "wire" | "attr" | "const";
  lang(): Lang | null;
  /* every other name legal here (widget.<slot>, variables, a flow's own locals) */
  names(): NameRow[];
  /* the shape of x at this position, or null when unknown; a struct x carries its
     field table so the dot offers FIELDS, not methods */
  x?(): { shape: string; elem?: string; fields?: MeshField[] } | null;
  /* color tokens, only where they are legal */
  tokens?(): TokenAccess | null;
}

/* every variable a widget's flows can name: its own locals shadow the globals */
export function variablesInScope(editor: Editor, widget: Node | null): Var[] {
  const locals = widget?.locals ?? [];
  const shadowed = new Set(locals.map((v) => v.name));
  return locals.concat(editor.store.globals().filter((v) => !shadowed.has(v.name)));
}

const VAR_SHAPE: Record<string, string> = { f64: "num", bool: "bool", str: "text" };

/* a timer reads by field: what the dot offers on one */
const TIMER_FIELDS: MeshField[] = [
  { path: "running", shape: "bool" },
  { path: "remaining", shape: "num" },
  { path: "duration", shape: "num" },
  { path: "progress", shape: "num" },
];

/* the standing name vocabulary at a widget: its slots as widget.<name>, then every
 * variable in scope */
function scopeNames(editor: Editor, widget: Node | null): NameRow[] {
  const rows: NameRow[] = [];
  const type = editor.registry?.types.find((t) => t.name === widget?.type) ?? null;
  for (const slot of type?.slots ?? [])
    rows.push({
      label: "widget." + slot.name,
      shape: slot.shape === "enum" ? "text" : slot.shape,
      note: "slot",
    });
  const locals = new Set((widget?.locals ?? []).map((v) => v.id));
  for (const variable of variablesInScope(editor, widget)) {
    if (variable.type === "timer") {
      rows.push({
        label: variable.name,
        shape: "timer",
        note: locals.has(variable.id) ? "local" : "global",
        fields: TIMER_FIELDS,
      });
      continue;
    }
    /* beyond the scalars, a variable's type is a TypeRef: a dotted ref is
       an enum, a root name a struct carrying its field table */
    const scalar = VAR_SHAPE[variable.type];
    const isEnum = !scalar && variable.type.includes(".");
    const fields = scalar || isEnum
      ? undefined
      : editor.mesh.types.find((t) => t.name === variable.type)?.fields;
    rows.push({
      label: variable.name,
      shape: scalar ?? (isEnum ? "enum" : "struct"),
      note: locals.has(variable.id) ? "local" : "global",
      fields,
    });
  }
  return rows;
}

/* what x IS in a feed's transform: the source field's shape, from reflection (mesh
 * sources) or the variable's declared type (HMI sources); a WHOLE-entity source makes
 * x the message, its field table riding along so the dot completes fields */
function feedX(editor: Editor, widget: Node | null, feed: () => Feed) {
  return (): { shape: string; elem?: string; fields?: MeshField[] } | null => {
    const at = feed();
    if (!at.src) return null;
    if (at.src.kind === "L") {
      const row = scopeNames(editor, widget).find((n) => n.label === at.src.name);
      return row?.shape ? { shape: row.shape, fields: row.fields } : null;
    }
    const entity = editor.mesh.entities.find(
      (e) => e.kind === at.src.kind && e.name === at.src.name,
    );
    if (!entity) return null;
    const fields = entity.kind === "F" ? entity.returns ?? [] : entity.fields;
    if (!(at.path ?? "") && fields.length > 1)
      return { shape: "struct", fields };
    const field =
      fields.find((f) => f.path === (at.path ?? "")) ??
      (fields.length === 1 ? fields[0] : null);
    if (!field) return null;
    return { shape: field.variants?.length ? "enum" : field.shape, elem: field.elem };
  };
}

/* what x IS at one row of a flow: the pipeline register — Nil until a `set x = ...`
 * above this row fills it, retyped by each one. The event's own value arrives as a
 * named PARAMETER (flowNames lists it), never as x. */
function flowX(editor: Editor, widget: Node | null, flow: () => Flow, stepId: number) {
  return (): { shape: string; elem?: string; fields?: MeshField[] } | null =>
    scopeAt(editor, widget, flow(), stepId).x;
}

/* The names a FLOW ROW may write: the standing scope plus this flow's own locals,
 * declared above this row only, and struct ones expanded to their fields so one field
 * can be computed from another. */
function flowNames(editor: Editor, widget: Node | null, flow: () => Flow, stepId: number) {
  return (): NameRow[] => {
    const rows = scopeNames(editor, widget);
    const declared = new Set(rows.map((r) => r.label));
    for (const local of scopeAt(editor, widget, flow(), stepId).locals) {
      if (!declared.has(local.name))
        rows.push({
          label: local.name,
          shape: local.shape,
          elem: local.elem,
          note: local.note,
          fields: local.fields,
        });
      for (const field of local.fields ?? [])
        rows.push({
          label: local.name + "." + field.path,
          shape: field.shape,
          elem: field.elem,
          note: local.type || "field",
        });
    }
    return rows;
  };
}

/* ---- the factories: one per surface ---- */

/* a widget-surface display-tier field: the standing vocabulary, no pipeline register */
export function pageScope(editor: Editor, widget: Node | null): Scope {
  return {
    tier: "display",
    lang: () => editor.lang,
    names: () => scopeNames(editor, widget),
  };
}

/* a feed's transform or condition: display tier, x is what the source delivers. The
 * feed is re-read from the store per ask, so a repicked source retypes x in place. */
export function feedScope(editor: Editor, widget: Node | null, feed: Feed): Scope {
  const at = () => (editor.store.node(feed.id) as Feed | null) ?? feed;
  return {
    tier: "display",
    lang: () => editor.lang,
    names: () => scopeNames(editor, widget),
    x: feedX(editor, widget, at),
  };
}

/* one row of a flow: wire tier, x and the locals as the rows above this one leave them */
export function flowScope(editor: Editor, widget: Node | null, flow: Flow, stepId: number): Scope {
  const at = () => (editor.store.node(flow.id) as Flow | null) ?? flow;
  return {
    tier: "wire",
    lang: () => editor.lang,
    names: flowNames(editor, widget, at, stepId),
    x: flowX(editor, widget, at, stepId),
  };
}

/* a prop default: the language alone, nothing live to reference */
export function constScope(editor: Editor): Scope {
  return {
    tier: "const",
    lang: () => editor.lang,
    names: () => [],
  };
}

/* ---- THE ATTR TIER: what a node's attr expressions may reference ----
 *
 * Grounded in the compiler that reads them (lang/template_expr.cpp): a bare name is a
 * property this part declares or inherits, a dotted one is another part's property by
 * ADDRESS from the template root — and the served type's slot table IS that address
 * list, so it is what names() offers. `state` and `repeat` are the view's own inputs,
 * read by field, legal on every node. Theme tokens are legal too ($name lexes to a
 * theme load), which is why tokens() is served here and the color picker grows its
 * Tokens tab on this surface.
 *
 * A PAGE node's scope is EMPTY on the backend (compile_page_attrs: nothing declares a
 * property there yet), so a node outside any component offers only the view's inputs. */

const STATE_FIELDS: MeshField[] = [
  { path: "pressed", shape: "bool" },
  { path: "dragging", shape: "bool" },
  { path: "open", shape: "bool" },
  { path: "hover", shape: "bool" },
];

const REPEAT_FIELDS: MeshField[] = [
  { path: "index", shape: "num" },
  { path: "count", shape: "num" },
  { path: "fraction", shape: "num" },
];

/* the component whose tree holds this node, or null for a page's node */
function owningComponent(editor: Editor, id: number): ComponentDef | null {
  const comps = editor.store.components();
  let at: Json | null = editor.store.node(id);
  while (at && typeof at.id === "number") {
    const comp = comps.find((c) => c.id === at.id);
    if (comp) return comp;
    at = editor.store.parentOf(at.id);
  }
  return null;
}

function attrNames(editor: Editor, node: Node): NameRow[] {
  const rows: NameRow[] = [
    { label: "state", shape: "struct", note: "this view", fields: STATE_FIELDS },
    { label: "repeat", shape: "struct", note: "this copy", fields: REPEAT_FIELDS },
  ];
  const comp = owningComponent(editor, node.id);
  if (!comp) return rows;
  /* the served slot table carries every property address in the component — bare for
     the component's own, dotted for a part's — which is exactly the reference universe
     the template compiler resolves */
  const type = editor.registry?.types.find((t) => t.name === comp.name) ?? null;
  for (const slot of type?.slots ?? [])
    rows.push({
      label: slot.name,
      shape: slot.shape === "enum" ? "text" : slot.shape,
      note: "prop",
    });
  return rows;
}

/* a node's attr expression (and its transition ms/profile, compiled over the same
 * scope): tier "attr" engages the served lang tables' `view` column in autocomplete,
 * so only rows the view can encode are ever offered */
export function attrScope(editor: Editor, node: Node): Scope {
  return {
    tier: "attr",
    lang: () => editor.lang,
    names: () => attrNames(editor, node),
    tokens: () => tokenAccess(editor),
  };
}

/* what a color editor needs to speak tokens: resolution in this view's mode, and the
 * grouped offer list for the $ menu */
export function tokenAccess(editor: Editor): TokenAccess {
  const mode = () => editor.view.themeMode ?? "dark";
  return {
    resolve: (raw) => {
      const resolved = resolveColor(raw, editor.store.tokens(), mode());
      return typeof resolved === "string" ? resolved : raw;
    },
    list: () =>
      editor.store.tokens().map((t) => ({
        name: t.name,
        group: t.group || "core",
        hex: mode() === "light" ? t.light : t.dark,
      })),
  };
}
