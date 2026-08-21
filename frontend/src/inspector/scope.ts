/* THE ONE SCOPE PROVIDER: what an expression at a given surface may reference.
 *
 * Surfaces differ only in vocabulary — the tier, the names that stand, what x holds,
 * whether color tokens are legal — never in control shape, so all of that knowledge is
 * served through ONE object and the fields stay ignorant of flows, feeds and vars.
 *
 * THE TREE IS THE TRUTH. Each factory builds ONE structured universe — the roots()
 * hierarchy the value box's browse popover draws — and names(), the flat list
 * autocomplete completes over, is a PROJECTION of that tree (projectNames). Neither
 * view is hand-maintained beside the other, which is what keeps the dropdown and the
 * tree from ever disagreeing: `this.value` exists once, as a leaf inside the
 * `this` folder, and the flat spelling is read off that leaf's `insert`.
 *
 * Factories live where knowledge lives: a call site picks its factory and hands the
 * Scope on. */

import { TokenAccess } from "../colorpicker.js";
import { Editor } from "../editor.js";
import { resolveColor, resolveTypeRef } from "../slots.js";
import { ComponentDef, Flow, Json, Lang, MeshEntity, MeshField, Node,
         SCALAR_TYPES, Var } from "../types.js";
import { scopeAt } from "./flowscope.js";

export interface NameRow {
  label: string;   /* what inserting places: "setpoint", "this.value", "x" */
  shape?: string;  /* its shape, when known: "num" "bool" "text" "list" ... */
  note?: string;   /* a short origin tag: "local", "global", "slot" */
  elem?: string;   /* aggregate names: the element shape */
  leaf?: string;   /* nested aggregates: what one ROW holds */
  fields?: MeshField[];   /* struct names: the field table behind the dot */
}

/* One row of a Scope's BROWSE hierarchy — the folder-listing view of the universe.
 * A row with `insert` is a leaf the picker can place at the caret (the canonical
 * reference spelling: `@cage/plc/IO.field`, a bare variable name); one without is a
 * pure folder. A row may be BOTH pickable and a folder (a struct variable: the whole
 * struct is a legal name AND its fields are leaves — the split-click idiom). Searching
 * flattens to the pickable rows, matched on `insert`. */
export interface BrowseRow {
  key: string;             /* expansion identity, stable across openings */
  label: string;
  kind?: string;           /* entity/variable rows: the kind mark */
  icon?: string;           /* folders and the rest: the fold icon */
  shape?: string;          /* trailing shape chip */
  note?: string;           /* trailing origin tag */
  insert?: string;         /* what picking places; absent = not pickable */
  children?: BrowseRow[];
  /* the mesh field behind a fielded row's child leaf: the projection rebuilds the
     parent's dot table (NameRow.fields) from these, so autocomplete completes with
     the very field objects the schema serves */
  field?: MeshField;
  /* how the row rides the FLAT projection: a note the flat list shows that the tree
     says with folders and kind marks instead, or skip for tree-only rows (x and the
     flow's own locals — autocomplete serves those through Scope.x and the flow
     section of names(); the enum-types helpers — call spellings, not names) */
  flat?: { note?: string; skip?: boolean };
  /* reflection ordinal: the flat list has always spoken in the mesh's own order
     while the tree sorts and folders for browsing; the projection re-orders by this */
  ord?: number;
}

/* ---- the projection: names() is DERIVED from the tree, never hand-built beside it.
 *
 * A pickable row becomes one flat row under its canonical spelling; a fielded row's
 * children are ABSORBED into its dot table rather than emitted (autocomplete offers
 * `motor` and completes `.speed` off its fields — exactly the flat model it always
 * had); a pure folder only frames. Rows carrying a reflection ordinal sort by it,
 * after the ordinal-less rows (the mesh rides behind the hmi names, as ever). ---- */
function projectNames(rows: BrowseRow[]): NameRow[] {
  const out: { name: NameRow; ord: number }[] = [];
  const walk = (rows: BrowseRow[]) => {
    for (const row of rows) {
      if (row.flat?.skip) continue;
      const kids = row.children ?? [];
      if (row.insert === undefined) {
        walk(kids);
        continue;
      }
      const fields = kids.map((k) => k.field).filter((f): f is MeshField => !!f);
      out.push({
        ord: row.ord ?? -1,
        name: {
          label: row.insert,
          shape: row.field ? row.field.shape : row.shape,
          elem: row.field?.elem,
          note: row.flat?.note ?? row.note,
          fields: kids.length ? fields : undefined,
        },
      });
    }
  };
  walk(rows);
  return out.sort((a, b) => a.ord - b.ord).map((entry) => entry.name);
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
  /* every other name legal here (this.<slot>, variables, a flow's own locals) —
     the flat projection of roots() */
  names(): NameRow[];
  /* the shape of x at this position, or null when unknown; a struct x carries its
     field table so the dot offers FIELDS, not methods */
  x?(): { shape: string; elem?: string; leaf?: string; fields?: MeshField[] } | null;
  /* color tokens, only where they are legal */
  tokens?(): TokenAccess | null;
  /* the browse tree — the STRUCTURED universe names() projects flat. Absent only
     where there is nothing to browse (a const surface). */
  roots?(): BrowseRow[];
}

/* ---- WHERE AN ELEMENT SITS decides what it can name (the backend's scope_for, mirrored)
 *
 * On a page: this element's own locals, then every enclosing element's from the inside
 * out, then the globals — nearest declaration wins. Inside a COMPONENT: nothing. A
 * component sees its own properties and no page name at all, so that it works wherever it
 * is placed; the compiler refuses the rest with a message that teaches the way in. */
export function variablesInScope(editor: Editor, element: Node | null): Var[] {
  if (element && inComponent(editor, element.id)) return declaredLocals(editor, element.id);
  const out: Var[] = [];
  const shadowed = new Set<string>();
  const take = (vars: Var[]) => {
    for (const variable of vars) {
      if (shadowed.has(variable.name)) continue;
      shadowed.add(variable.name);
      out.push(variable);
    }
  };
  for (let at: Json | null = element as Json | null; at && typeof at.id === "number";
       at = editor.store.parentOf(at.id))
    take(((at as Node).locals ?? []) as Var[]);
  take(editor.store.globals());
  return out;
}

/* the locals this element declares, and only those. Read off the raw record, not
 * nodeAt: a COMPONENT holds locals too and carries no `kind`. */
function declaredLocals(editor: Editor, id: number): Var[] {
  const locals = (editor.store.node(id) as Json | null)?.locals;
  return Array.isArray(locals) ? (locals as unknown as Var[]) : [];
}

/* is this element inside a component definition rather than on a page? The walk up ends
 * at a component record or at the page — the same question owningComponent answers, kept
 * separate because the callers that ask this do not want the component itself. */
function inComponent(editor: Editor, id: number): boolean {
  return owningComponent(editor, id) !== null;
}

/* a scalar variable's shape IS its type; anything else is a timer, an aggregate or a
   TypeRef (see SCALAR_TYPES in types.ts) */
const scalarShape = (type: string) => (SCALAR_TYPES.has(type) ? type : undefined);

/* ONE AMBIENT OBJECT'S FIELD TABLE, read off the SERVED roster (lang.objects — the
 * backend's registry/objects.h, the same tables its compilers bind and check with).
 * The clock, the view's own inputs (state, repeat) and a timer all read by field,
 * and what the dot offers on each is exactly what the descriptor says — the hand
 * mirrors this file kept beside the generated vocabulary died into these reads. */
function objectFields(editor: Editor, name: string): MeshField[] {
  return editor.lang?.objects?.find((row) => row.name === name)?.fields ?? [];
}

/* the standing `time` folder: not itself pickable (time reads by field), its leaves
 * inserting the dotted spellings. `now` is the animation clock. */
function timeRow(editor: Editor, prefix: string): BrowseRow {
  return {
    key: prefix + "/time",
    label: "time",
    icon: "clock",
    children: objectFields(editor, "time").map((field) => ({
      key: prefix + "/time." + field.path,
      label: field.path,
      shape: field.shape,
      insert: "time." + field.path,
      field,
      flat: { note: "clock" },
    })),
  };
}

/* ---- the hmi universe: this instance's names, structured ----
 *
 * `this` is a folder over the slot leaves (a slot's canonical spelling is
 * this.<name>); the variables bucket local/global, each a leaf (scalar, enum) or a
 * pickable folder over its field leaves (struct by its type's table, timer by the
 * four timer fields). */
function hmiRows(editor: Editor, instance: Node | null,
                 extra: BrowseRow[] = []): BrowseRow[] {
  const rows: BrowseRow[] = [];
  const type = editor.registry?.components.find((t) => t.name === instance?.type) ?? null;
  const slots: BrowseRow[] = (type?.slots ?? []).map((slot) => ({
    key: "s:" + slot.name,
    label: slot.name,
    icon: "layers",
    shape: slot.shape === "enum" ? "text" : slot.shape,
    insert: "this." + slot.name,
    flat: { note: "slot" },
  }));
  if (slots.length)
    rows.push({ key: "hmi/this", label: "this", icon: "layers", children: slots });

  rows.push(...variableRows(editor, instance, "hmi"));
  /* the clock stands in every scalar scope (scope_for binds it last), so the hmi
     universe always offers it. `extra` is what only SOME surfaces bind — `repeat` on a
     flow an event can trigger — and it sits here rather than beside the roots because a
     reserved view input is part of the hmi universe wherever it is legal at all. */
  rows.push(timeRow(editor, "hmi"));
  rows.push(...extra);
  return rows;
}

/* THE VARIABLES IN SCOPE, foldered in the order they shadow: what this element declares,
 * what an element ABOVE it declares, and the document's globals. One builder, because the
 * scalar surfaces and a page element's ATTRS now read the very same list — the whole
 * point of the scoping work is that where a name resolves is a fact about where the
 * element sits and not about which surface is asking. */
function variableRows(editor: Editor, element: Node | null, prefix: string,
                      keep?: (variable: Var) => boolean): BrowseRow[] {
  const own = new Set((element?.locals ?? []).map((v) => v.id));
  const globals = new Set(editor.store.globals().map((v) => v.id));
  const buckets: Record<"local" | "outer" | "global", BrowseRow[]> =
    { local: [], outer: [], global: [] };
  for (const variable of variablesInScope(editor, element)) {
    if (keep && !keep(variable)) continue;
    const note = own.has(variable.id) ? ("local" as const)
               : globals.has(variable.id) ? ("global" as const)
               : ("outer" as const);
    /* beyond timer and the scalars, a variable's type is a TypeRef: a dotted ref is
       an enum, a root name a struct carrying its field table */
    const scalar = scalarShape(variable.type);
    const isEnum = !scalar && variable.type !== "timer" && variable.type.includes(".");
    const fields =
      variable.type === "timer" ? objectFields(editor, "timer")
      : scalar || isEnum ? []
      : editor.mesh.types.find((t) => t.name === variable.type)?.fields ?? [];
    buckets[note].push({
      key: prefix + "/v:" + variable.name,
      label: variable.name,
      kind: note === "global" ? "g" : "l",
      shape: variable.type === "timer" ? "timer" : scalar ?? (isEnum ? "enum" : "struct"),
      insert: variable.name,
      flat: { note },
      children: fields.map((field) => ({
        key: prefix + "/v:" + variable.name + "." + field.path,
        label: field.path,
        shape: field.variants?.length ? "enum" : field.shape,
        insert: variable.name + "." + field.path,
        field,
      })),
    });
  }
  const FOLDER: Record<"local" | "outer" | "global", string> =
    { local: "local", outer: "enclosing", global: "global" };
  const rows: BrowseRow[] = [];
  for (const scope of ["local", "outer", "global"] as const)
    if (buckets[scope].length)
      rows.push({ key: prefix + "/" + scope, label: FOLDER[scope], icon: "folder",
                  children: buckets[scope] });
  return rows;
}

/* the hmi root, or nothing when this instance has no names at all */
function hmiRoot(editor: Editor, instance: Node | null,
                 extra: BrowseRow[] = []): BrowseRow[] {
  const rows = hmiRows(editor, instance, extra);
  return rows.length ? [{ key: "hmi", label: "hmi", icon: "folder", children: rows }] : [];
}

/* ---- the dart universe: the mesh, foldered by the / segments of entity names ---- */

/* the fields a slot expression reads OFF an entity: a function's response, anything
 * else's own table (the backend's feed_fields, mirrored) */
function entityReadFields(entity: MeshEntity): MeshField[] {
  return entity.kind === "F" ? entity.returns ?? [] : entity.fields;
}

/* nested folders from the / segments of entity names, explorer style — THE ONE fold
 * implementation; the source tree (sourcetree.ts) draws its folders from this too */
export interface EntityFolder {
  folders: Map<string, EntityFolder>;
  entities: MeshEntity[];
}

export function foldEntities(entities: MeshEntity[]): EntityFolder {
  const root: EntityFolder = { folders: new Map(), entities: [] };
  for (const entity of entities) {
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
  return root;
}

function dartRows(editor: Editor): BrowseRow[] {
  /* the reflection ordinal rides every leaf: the tree sorts for browsing, the flat
     projection restores the mesh's own order by it */
  const ordOf = new Map(editor.mesh.entities.map((entity, i) => [entity, i]));
  const readable = editor.mesh.entities.filter((e) => entityReadFields(e).length > 0);
  const entityRow = (entity: MeshEntity): BrowseRow => {
    const fields = entityReadFields(entity);
    const key = "e:" + entity.kind + ":" + entity.name;
    const leaf = entity.name.slice(entity.name.lastIndexOf("/") + 1);
    const ord = ordOf.get(entity);
    /* one field reads whole as `@name`; several read by `@name.field`, so the row is
       a folder over its field leaves */
    if (fields.length === 1)
      return { key, label: leaf, kind: entity.kind, shape: fields[0].shape,
               insert: "@" + entity.name, field: fields[0], flat: { note: "mesh" }, ord };
    return {
      key, label: leaf, kind: entity.kind, shape: entity.type || undefined,
      children: fields.map((field) => ({
        key: key + "." + field.path,
        label: field.path,
        shape: field.shape,
        insert: "@" + entity.name + "." + field.path,
        field,
        flat: { note: "mesh" },
        ord,
      })),
    };
  };
  const folderRows = (folder: EntityFolder, prefix: string): BrowseRow[] => {
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
  return folderRows(foldEntities(readable), "");
}

function dartRoot(editor: Editor): BrowseRow[] {
  const rows = dartRows(editor);
  return rows.length ? [{ key: "dart", label: "dart", icon: "folder", children: rows }] : [];
}

/* the standing roots a surface shares — and the ONE place isolation shows in the UI: a
 * surface INSIDE a component offers no dart universe at all, because nothing in there may
 * name the mesh. The compiler refuses it either way; not offering it is how the rule
 * teaches before the refusal has to. `extra` is what one surface binds on top of the
 * shared universe (a flow's `repeat`). */
function slotRoots(editor: Editor, element: Node | null,
                   extra: BrowseRow[] = []): BrowseRow[] {
  const rows = hmiRoot(editor, element, extra);
  if (element && inComponent(editor, element.id)) return rows;
  return rows.concat(dartRoot(editor));
}

/* ---- the factories: one per surface ---- */

/* WHICH COPY THIS FLOW RUNS FOR, offered only where the flow can have one. `repeat` names
 * the copy an EVENT arrived on: a cadence or a timer fires for the element itself, so the
 * backend refuses the word there. A flow compiles its steps ONCE PER TRIGGER, so a clock
 * trigger anywhere in the list means one of those compiles has no copy — and the row is
 * offered only when every trigger carries one, which is exactly what the compiler will
 * accept. Not offering it is how the rule teaches before the refusal has to. */
function repeatRow(editor: Editor, flow: Flow | null): BrowseRow[] {
  const when = (flow?.when ?? []) as Json[];
  if (!when.length) return [];
  if (when.some((t) => t?.kind === "every" || t?.kind === "timer")) return [];
  return [{
    key: "hmi/repeat",
    label: "repeat",
    icon: "copy",
    children: objectFields(editor, "repeat").map((field) => ({
      key: "hmi/repeat." + field.path,
      label: field.path,
      shape: field.shape,
      insert: "repeat." + field.path,
      field,
      flat: { note: "copy" },
    })),
  }];
}

/* what x IS at one row of a flow: the pipeline register — Nil until a `set x = ...`
 * above this row fills it, retyped by each one. The event's own value arrives as a
 * named PARAMETER, never as x. */
function flowX(editor: Editor, instance: Node | null, flow: () => Flow, stepId: number) {
  return (): { shape: string; elem?: string; leaf?: string;
               fields?: MeshField[] } | null =>
    scopeAt(editor, instance, flow(), stepId).x;
}

/* One row of a flow: wire tier, x and the locals as the rows above this one leave them
 * — PLUS the mesh under its '@' spellings, exactly the vocabulary the backend binds
 * into flow expressions (bind_entities in compile_steps). The browse tree serves the
 * standing hierarchy with the flow's own names (x, the event's parameter, the
 * temporaries) leading under a "this flow" root.
 *
 * names() projects the same hmi and dart trees the browse draws; between them rides
 * the flow's own section — the temporaries and parameters standing at this row, and
 * every struct local's fields as dotted rows so one field can be computed from
 * another. That section's order is POSITIONAL (scopeAt's walk of the rows above),
 * not tree-shaped, so it is read off scopeAt directly — the same truth the "this
 * flow" subtree is built from. */
export function flowScope(editor: Editor, instance: Node | null, flow: Flow, stepId: number): Scope {
  const at = () => (editor.store.node(flow.id) as Flow | null) ?? flow;
  const x = flowX(editor, instance, at, stepId);
  const flowRoot = (): BrowseRow[] => {
    const kids: BrowseRow[] = [];
    const held = x();
    if (held)
      kids.push({ key: "flow/x", label: "x", shape: held.shape, insert: "x",
                  flat: { skip: true } });
    /* the flow's OWN names: the event's parameter and the temporaries standing
       above this row (declared variables ride the hmi root already) */
    for (const local of scopeAt(editor, instance, at(), stepId).locals) {
      if (local.note !== "temporary" && local.note !== "event parameter") continue;
      kids.push({
        key: "flow/" + local.name, label: local.name, shape: local.shape,
        note: local.note === "temporary" ? "temp" : "param", insert: local.name,
        children: (local.fields ?? []).map((field) => ({
          key: "flow/" + local.name + "." + field.path,
          label: field.path,
          shape: field.shape,
          insert: local.name + "." + field.path,
          field,
        })),
      });
    }
    /* tree-only: names() serves this vocabulary through its flow section (and x
       through Scope.x), in the standing order autocomplete has always offered */
    return kids.length
      ? [{ key: "flow", label: "this flow", icon: "folder", flat: { skip: true },
           children: kids }]
      : [];
  };
  return {
    tier: "wire",
    lang: () => editor.lang,
    names: () => {
      const rows = projectNames(hmiRoot(editor, instance, repeatRow(editor, at())));
      const declared = new Set(rows.map((r) => r.label));
      for (const local of scopeAt(editor, instance, at(), stepId).locals) {
        if (!declared.has(local.name))
          rows.push({
            label: local.name,
            shape: local.shape,
            elem: local.elem,
            leaf: local.leaf,
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
      return rows.concat(projectNames(dartRoot(editor)));
    },
    x,
    roots: () => flowRoot().concat(slotRoots(editor, instance, repeatRow(editor, at()))),
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

/* ---- THE SLOT TIER: what an instance's slot expression may reference ----
 *
 * Grounded in the compiler that reads them (compile_slot_program): the scope is the
 * instance's own — every variable in scope (struct fields dotted), every timer by field,
 * the instance's own slots as `this.<name>` — PLUS every readable mesh entity bound
 * under its '@' spelling (bind_entities): `@name` where the entity reads as one field,
 * `@name.field` per field otherwise (a function binds its RESPONSE fields). `x` is
 * refused there by name, so no x row exists. The tier is "display": that is the
 * ExprTier the backend compiles a slot program at.
 *
 * Color tokens are served with ONE caveat the compiler enforces: `$name` stands as a
 * color slot's WHOLE value (the authored-literal special case); inside a larger
 * expression the scalar parser refuses it. The picker writes whole values, so the
 * Tokens tab is honest here. */
export function slotScope(editor: Editor, instance: Node | null): Scope {
  const roots = () => slotRoots(editor, instance);
  return {
    tier: "display",
    lang: () => editor.lang,
    names: () => projectNames(roots()),
    roots,
    tokens: () => tokenAccess(editor),
  };
}

/* every ENUM-TYPED value in reach, spelled with its `.variants()` read: variables
 * whose declared type names an enum, and the mesh's enum fields. What the options
 * slot's browse offers, so the vocabulary list is PICKED, never memorised — and it
 * is named through the VALUE beside it, so it can never name a different enum than
 * the one the control drives. */
export function enumListRefs(editor: Editor, instance: Node | null):
    { label: string; insert: string }[] {
  const out: { label: string; insert: string }[] = [];
  for (const v of variablesInScope(editor, instance)) {
    const resolved = resolveTypeRef(editor.mesh, v.type ?? "");
    if (resolved?.kind === "enum")
      out.push({ label: v.name, insert: v.name + ".variants()" });
    else if (resolved?.kind === "struct")
      /* a struct variable's ENUM FIELDS are enum values too, one dot deeper */
      for (const field of resolved.type.fields)
        if (field.variants?.length)
          out.push({ label: v.name + "." + field.path,
                     insert: v.name + "." + field.path + ".variants()" });
  }
  for (const entity of editor.mesh.entities) {
    const fields = entity.kind === "F" ? entity.returns ?? [] : entity.fields;
    for (const field of fields)
      if (field.variants?.length) {
        const ref = "@" + entity.name + (field.path ? "." + field.path : "");
        out.push({ label: ref, insert: ref + ".variants()" });
      }
  }
  /* the schema's enum TYPES by their own spelling — the no-value case: a function
     argument's enum is a field a call writes, never a value to read, so its type
     reference is the one road to the vocabulary */
  for (const type of editor.mesh.types) {
    if (!type.name) continue;
    for (const field of type.fields)
      if (field.variants?.length) {
        const ref = type.name + "." + field.path;
        out.push({ label: ref, insert: ref + ".variants()" });
      }
  }
  return out;
}

/* an OPTIONS slot's scope: the same universe plus the enum lists above. Browse-only
 * (flat-skipped): `.variants()` is a read spelling, not a name of its own. */
export function optionsSlotScope(editor: Editor, instance: Node | null): Scope {
  const roots = () => {
    const enums: BrowseRow[] = enumListRefs(editor, instance).map((row) => ({
      key: "ev:" + row.insert,
      label: row.insert,
      icon: "layers",
      shape: "list",
      insert: row.insert,
    }));
    const rest = slotRoots(editor, instance);
    return enums.length
      ? [{ key: "enums", label: "enum lists", icon: "folder", flat: { skip: true },
           children: enums }, ...rest]
      : rest;
  };
  return {
    tier: "display",
    lang: () => editor.lang,
    names: () => projectNames(roots()),
    roots,
    tokens: () => tokenAccess(editor),
  };
}

/* ---- THE ATTR TIER: what a node's attr expressions may reference ----
 *
 * Grounded in the compiler that reads them (lang/template_expr.cpp): a bare name is a
 * property this element declares or inherits, a dotted one is another element's property by
 * ADDRESS from the template root — and the served type's slot table IS that address
 * list, so it is what the universe offers. `state` and `repeat` are the view's own
 * inputs, read by field, legal on every node — folders over their field leaves. Theme
 * tokens are legal too ($name lexes to a theme load), which is why tokens() is served
 * here and the color picker grows its Tokens tab on this surface.
 *
 * A PAGE node's scope is the PAGE UNIVERSE (compile_page_attrs): the variables in its
 * lexical scope — its own locals, every enclosing element's, the globals — and the mesh,
 * the same names a flow on that element reads. Inside a component neither is offered,
 * which is where isolation shows in the UI. */

/* the component whose tree holds this node, or null for a page's node.
 *
 * Matched by IDENTITY, not by id: this now decides what a whole surface may reference, so
 * "is this record the component" must be the actual record and not a number that happens
 * to agree with one. */
function owningComponent(editor: Editor, id: number): ComponentDef | null {
  const comps = editor.store.components();
  let at: Json | null = editor.store.node(id);
  while (at && typeof at.id === "number") {
    const here = at;
    const comp = comps.find((c) => (c as unknown as Json) === here);
    if (comp) return comp;
    at = editor.store.parentOf(at.id);
  }
  return null;
}

/* CAN AN ATTR READ THIS VARIABLE AT ALL? A whole struct is read BY FIELD, and a view
 * program's cell load hands back one value — the compiler refuses it by name
 * (lang/template_expr.cpp no_display_reading), so the browse tree does not offer it.
 * Everything else — the scalars, an icon, an enum (a dotted TypeRef), a list, a map,
 * and a TIMER (whose fields resolve to renderer-answered "tmr:" cells that count down
 * per frame off the served deadline) — rides the wire already. */
function displayReadable(variable: Var): boolean {
  return SCALAR_TYPES.has(variable.type) || variable.type === "timer" ||
         variable.type === "list" || variable.type === "map" ||
         variable.type.includes(".");
}

function attrRoots(editor: Editor, node: Node): BrowseRow[] {
  const viewInput = (name: string, note: string, fields: MeshField[]): BrowseRow => ({
    key: "attr/" + name,
    label: name,
    shape: "struct",
    note,
    insert: name,
    children: fields.map((field) => ({
      key: "attr/" + name + "." + field.path,
      label: field.path,
      shape: field.shape,
      insert: name + "." + field.path,
      field,
    })),
  });
  const rows: BrowseRow[] = [
    viewInput("state", "this view", objectFields(editor, "state")),
    viewInput("repeat", "this copy", objectFields(editor, "repeat")),
    timeRow(editor, "attr"),
  ];
  const comp = owningComponent(editor, node.id);
  /* ON A PAGE: the variables in lexical scope and the whole mesh, which is what an
     element outside a component may now name. Inside one: neither, and the absence IS
     the isolation rule — the compiler refuses the rest with a message that teaches the
     way in, and not offering it is how the rule teaches before the refusal has to. */
  if (!comp)
    return rows.concat(variableRows(editor, node, "attr", displayReadable),
                       dartRoot(editor));
  /* the served slot table carries every property address in the component — bare for
     the component's own, dotted for an element's — which is exactly the reference universe
     the template compiler resolves */
  const type = editor.registry?.components.find((t) => t.name === comp.name) ?? null;
  for (const slot of type?.slots ?? [])
    rows.push({
      key: "attr/p:" + slot.name,
      label: slot.name,
      shape: slot.shape === "enum" ? "text" : slot.shape,
      note: "prop",
      insert: slot.name,
    });
  return rows;
}

/* a node's attr expression (and its transition ms/profile, compiled over the same
 * scope): tier "attr" engages the served lang tables' `view` column in autocomplete,
 * so only rows the view can encode are ever offered */
export function attrScope(editor: Editor, node: Node): Scope {
  const roots = () => attrRoots(editor, node);
  return {
    tier: "attr",
    lang: () => editor.lang,
    names: () => projectNames(roots()),
    roots,
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
