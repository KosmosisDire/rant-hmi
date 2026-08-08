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
import { ComponentDef, Flow, Json, Lang, MeshEntity, MeshField, Node, Var } from "../types.js";
import { scopeAt } from "./flowscope.js";

export interface NameRow {
  label: string;   /* what inserting places: "setpoint", "widget.value", "x" */
  shape?: string;  /* its shape, when known: "num" "bool" "text" "list" ... */
  note?: string;   /* a short origin tag: "local", "global", "slot" */
  elem?: string;   /* aggregate names: the element shape */
  fields?: MeshField[];   /* struct names: the field table behind the dot */
}

/* One row of a Scope's BROWSE hierarchy — the folder-listing view of the same universe
 * names() serves flat. A row with `insert` is a leaf the picker can place at the caret
 * (the canonical reference spelling: `@cage/plc/IO.field`, a bare variable name); one
 * without is a pure folder. Searching flattens to the leaves, matched on `insert`. */
export interface BrowseRow {
  key: string;             /* expansion identity, stable across openings */
  label: string;
  kind?: string;           /* entity/variable rows: the kind mark */
  icon?: string;           /* folders and the rest: the fold icon */
  shape?: string;          /* trailing shape chip */
  note?: string;           /* trailing origin tag */
  insert?: string;         /* what picking places; absent = not pickable */
  children?: BrowseRow[];
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
  /* the browse tree's HIERARCHICAL view of the same universe names() serves flat: a
     scope carrying path-spelled mesh entities folders them explorer-style. Absent on
     flat-name scopes, whose browse popover keeps the flat list. */
  roots?(): BrowseRow[];
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


/* One row of a flow: wire tier, x and the locals as the rows above this one leave them
 * — PLUS the mesh under its '@' spellings, exactly the vocabulary the backend now binds
 * into flow expressions (bind_entities in compile_steps): an assignment's rvalue or a
 * gate reads `@cage/plc/IO.temp` by naming it. The browse tree serves the same
 * hierarchy the slot tier's does, with the flow's own names (x, the temporaries)
 * leading, so autocomplete and browse stay one universe. */
export function flowScope(editor: Editor, widget: Node | null, flow: Flow, stepId: number): Scope {
  const at = () => (editor.store.node(flow.id) as Flow | null) ?? flow;
  const names = flowNames(editor, widget, at, stepId);
  const x = flowX(editor, widget, at, stepId);
  return {
    tier: "wire",
    lang: () => editor.lang,
    names: () => names().concat(entityNames(editor)),
    x,
    roots: () => {
      const flowKids: BrowseRow[] = [];
      const held = x();
      if (held)
        flowKids.push({ key: "flow/x", label: "x", shape: held.shape, insert: "x" });
      /* the flow's OWN names: the event's parameter and the temporaries standing
         above this row (declared variables ride the hmi root already) */
      for (const local of scopeAt(editor, widget, at(), stepId).locals) {
        if (local.note !== "temporary" && local.note !== "event parameter") continue;
        flowKids.push({
          key: "flow/" + local.name, label: local.name, shape: local.shape,
          note: local.note === "temporary" ? "temp" : "param", insert: local.name,
          children: (local.fields ?? []).map((field) => ({
            key: "flow/" + local.name + "." + field.path,
            label: field.path,
            shape: field.shape,
            insert: local.name + "." + field.path,
          })),
        });
      }
      const roots = slotRoots(editor, widget);
      return flowKids.length
        ? [{ key: "flow", label: "this flow", icon: "folder", children: flowKids },
           ...roots]
        : roots;
    },
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

/* ---- THE SLOT TIER: what a widget's slot expression may reference ----
 *
 * Grounded in the compiler that reads them (compile_slot_program): the scope is the
 * widget's own — every variable in scope (struct fields dotted), every timer by field,
 * the widget's own slots as `widget.<name>` — PLUS every readable mesh entity bound
 * under its '@' spelling (bind_entities): `@name` where the entity reads as one field,
 * `@name.field` per field otherwise (a function binds its RESPONSE fields). `x` is
 * refused there (scope.no_x), so no x row exists. The tier is "display": that is the
 * ExprTier the backend compiles a slot program at.
 *
 * Color tokens are served with ONE caveat the compiler enforces: `$name` stands as a
 * color slot's WHOLE value (the authored-literal special case); inside a larger
 * expression the scalar parser refuses it. The picker writes whole values, so the
 * Tokens tab is honest here. */

/* the fields a slot expression reads OFF an entity: a function's response, anything
 * else's own table (the backend's feed_fields, mirrored) */
function entityReadFields(entity: MeshEntity): MeshField[] {
  return entity.kind === "F" ? entity.returns ?? [] : entity.fields;
}

/* the flat rows for the '@' spellings — the same universe the browse tree folders */
function entityNames(editor: Editor): NameRow[] {
  const rows: NameRow[] = [];
  for (const entity of editor.mesh.entities) {
    const fields = entityReadFields(entity);
    if (!fields.length) continue;
    if (fields.length === 1)
      rows.push({ label: "@" + entity.name, shape: fields[0].shape,
                  elem: fields[0].elem, note: "mesh" });
    else
      for (const field of fields)
        rows.push({ label: "@" + entity.name + "." + field.path, shape: field.shape,
                    elem: field.elem, note: "mesh" });
  }
  return rows;
}

/* nested folders from the / segments of entity names — the fold_entities idiom the
 * source tree draws (sourcetree.ts); duplicated here because that module is the
 * structural lvalue picker and stays untouched */
function foldEntityRows(editor: Editor): BrowseRow[] {
  interface Folder { folders: Map<string, Folder>; entities: MeshEntity[]; }
  const root: Folder = { folders: new Map(), entities: [] };
  for (const entity of editor.mesh.entities) {
    if (!entityReadFields(entity).length) continue;
    const segments = entity.name.split("/");
    let at = root;
    for (let i = 0; i + 1 < segments.length; ++i) {
      let next = at.folders.get(segments[i]);
      if (!next) {
        next = { folders: new Map(), entities: [] };
        at.folders.set(segments[i], next);
      }
      at = next;
    }
    at.entities.push(entity);
  }
  const entityRow = (entity: MeshEntity): BrowseRow => {
    const fields = entityReadFields(entity);
    const key = "e:" + entity.kind + ":" + entity.name;
    const leaf = entity.name.slice(entity.name.lastIndexOf("/") + 1);
    /* one field reads whole as `@name`; several read by `@name.field`, so the row is
       a folder over its field leaves */
    if (fields.length === 1)
      return { key, label: leaf, kind: entity.kind, shape: fields[0].shape,
               insert: "@" + entity.name };
    return {
      key, label: leaf, kind: entity.kind, shape: entity.type || undefined,
      children: fields.map((field) => ({
        key: key + "." + field.path,
        label: field.path,
        shape: field.shape,
        insert: "@" + entity.name + "." + field.path,
      })),
    };
  };
  const folderRows = (folder: Folder, prefix: string): BrowseRow[] => {
    const rows: BrowseRow[] = [];
    for (const [name, child] of [...folder.folders.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    ))
      rows.push({ key: "d:" + prefix + name, label: name, icon: "folder",
                  children: folderRows(child, prefix + name + "/") });
    for (const entity of [...folder.entities].sort((a, b) => a.name.localeCompare(b.name)))
      rows.push(entityRow(entity));
    return rows;
  };
  return folderRows(root, "");
}

/* the hierarchy over slotScope's universe: hmi (the widget's slots, then the variables
 * bucketed local/global, struct and timer fields as sub-rows) and dart (the mesh,
 * foldered by the / segments of entity names) */
function slotRoots(editor: Editor, widget: Node | null): BrowseRow[] {
  const hmiKids: BrowseRow[] = [];
  const type = editor.registry?.types.find((t) => t.name === widget?.type) ?? null;
  for (const slot of type?.slots ?? [])
    hmiKids.push({ key: "s:" + slot.name, label: "widget." + slot.name, icon: "layers",
                   shape: slot.shape === "enum" ? "text" : slot.shape,
                   insert: "widget." + slot.name });
  const buckets: Record<"local" | "global", BrowseRow[]> = { local: [], global: [] };
  for (const row of scopeNames(editor, widget)) {
    if (row.note !== "local" && row.note !== "global") continue;
    buckets[row.note].push({
      key: "v:" + row.label,
      label: row.label,
      kind: row.note === "local" ? "l" : "g",
      shape: row.shape,
      insert: row.label,
      children: (row.fields ?? []).map((field) => ({
        key: "v:" + row.label + "." + field.path,
        label: field.path,
        shape: field.variants?.length ? "enum" : field.shape,
        insert: row.label + "." + field.path,
      })),
    });
  }
  for (const scope of ["local", "global"] as const)
    if (buckets[scope].length)
      hmiKids.push({ key: "hmi/" + scope, label: scope, icon: "folder",
                     children: buckets[scope] });
  const roots: BrowseRow[] = [];
  if (hmiKids.length) roots.push({ key: "hmi", label: "hmi", icon: "folder", children: hmiKids });
  const dart = foldEntityRows(editor);
  if (dart.length) roots.push({ key: "dart", label: "dart", icon: "folder", children: dart });
  return roots;
}

/* a widget's slot expression: the standing vocabulary plus the mesh, no x */
export function slotScope(editor: Editor, widget: Node | null): Scope {
  return {
    tier: "display",
    lang: () => editor.lang,
    names: () => scopeNames(editor, widget).concat(entityNames(editor)),
    roots: () => slotRoots(editor, widget),
    tokens: () => tokenAccess(editor),
  };
}

/* an OPTIONS slot's scope: the same universe plus the schema's enum types, offered as
 * `variants(Type.field)` — the list named through the schema so it can never drift
 * from it. This absorbs the old enum chip into the browse tree. */
export function optionsSlotScope(editor: Editor, widget: Node | null): Scope {
  const base = slotScope(editor, widget);
  return {
    ...base,
    roots: () => {
      const enums: BrowseRow[] = [];
      for (const type of editor.mesh.types) {
        if (!type.name) continue;
        for (const field of type.fields)
          if (field.variants?.length)
            enums.push({
              key: "en:" + type.name + "." + field.path,
              label: type.name + "." + field.path,
              icon: "layers",
              shape: "enum",
              insert: "variants(" + type.name + "." + field.path + ")",
            });
      }
      const roots = base.roots?.() ?? [];
      return enums.length
        ? [{ key: "enums", label: "enum types", icon: "folder", children: enums }, ...roots]
        : roots;
    },
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
