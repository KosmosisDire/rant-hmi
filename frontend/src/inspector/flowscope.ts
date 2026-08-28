/* What a flow's names mean AT A GIVEN ROW.
 *
 * A DO list is read top to bottom and so is this: the locals a row may name are the ones
 * declared ABOVE it, `x` is whatever the last move into it produced, and a
 * struct local carries the field table of the type that was moved into it. One pass
 * answers all of that, because they are all the same question.
 *
 * The inference mirrors the compiler’s (`compile_assign`), and where the compiler would
 * know more than a view can, this says nothing rather than guessing: an unresolved shape
 * only widens what autocomplete offers, while a wrong one would offer the wrong
 * vocabulary and be believed. */

import { Editor } from "../editor.js";
import { eventKind, Flow, Json, MeshEntity, MeshField, Node,
         SCALAR_TYPES } from "../types.js";
/* scope.ts also imports scopeAt from here: a cycle on paper, but both edges are
 * function calls deferred past load, so neither module reads the other while loading */
import { variablesInScope } from "./scope.js";

export interface LocalInfo {
  name: string;
  /* "Num" | "Bool" | "Text" | "Struct" | ... ; "" when it could not be inferred */
  shape: string;
  /* aggregates: the element shape, and — where the elements are ROWS — what a row holds */
  elem?: string;
  leaf?: string;
  /* struct locals: the type name (may be "" for an unnamed root) and its field table */
  type?: string;
  fields?: MeshField[];
  /* where it came from, for the picker's right-hand note */
  note: "temporary" | "local" | "global" | "event parameter";
}

/* a scalar variable's shape IS its type now (SCALAR_TYPES in types.ts) */
const scalarShape = (type: string) => (SCALAR_TYPES.has(type) ? type : undefined);

/* the fields a WRITE may address on an entity: its value/request table, never the
 * response side (that is a feed's business) */
function writeFields(entity: MeshEntity | null): MeshField[] {
  return entity?.fields ?? [];
}

function typeFields(editor: Editor, name: string): MeshField[] {
  if (!name) return [];
  return editor.mesh.types.find((t) => t.name === name)?.fields ?? [];
}

/* the declared variables an instance's flows can name, before any move adds to them. A type
 * beyond the four scalars is a TypeRef: a struct root holds a struct of it,
 * and a dotted ref (`ValveCmd.mode`) holds that enum's value. */
function declared(editor: Editor, instance: Node | null): LocalInfo[] {
  const own = new Set((instance?.locals ?? []).map((v) => v.id));
  return variablesInScope(editor, instance)
    .filter((v) => v.type !== "Timer")
    .map((v) => {
      const note = own.has(v.id) ? ("local" as const) : ("global" as const);
      const scalar = scalarShape(v.type);
      if (scalar) return { name: v.name, shape: scalar, note };
      if (v.type === "List" || v.type === "Map")
        return { name: v.name, shape: v.type, elem: v.elem || undefined,
                 leaf: v.leaf || undefined, note };
      if (v.type.includes(".")) return { name: v.name, shape: "Enum", type: v.type, note };
      return {
        name: v.name,
        shape: "Struct",
        type: v.type,
        fields: typeFields(editor, v.type),
        note,
      };
    });
}

/* What one assignment's RVALUE yields, given what is in scope at that row. The rvalue
 * is always an expression now; the degenerate spellings a picker writes are worth
 * resolving here (a bare local name, `@entity`, `@entity.field`, a dotted local
 * field) and anything compound is left to the expression resolver, which has the
 * served tables. Mirrors the compiler (compile_assign): a whole fielded entity reads
 * as a struct, a single-field one as its scalar. */
function sourceShape(
  editor: Editor,
  from: Json,
  scope: Map<string, LocalInfo>,
): { shape: string; elem?: string; leaf?: string; type?: string;
     fields?: MeshField[] } | null {
  if (!from || typeof from !== "object") return null;
  if (typeof from.expr !== "string") return null;
  const text = from.expr.trim();

  const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(text);
  if (bare) return scope.get(bare[0]) ?? null;

  /* a local's field: `m.position` where m is a struct in scope */
  const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_.]+)$/.exec(text);
  if (dotted) {
    const held = scope.get(dotted[1]);
    const field = (held?.fields ?? []).find((f) => f.path === dotted[2]);
    return field ? { shape: field.shape, elem: field.elem } : null;
  }

  /* a mesh read by name: `@name` whole, `@name.field` one field. Entity names are
     path-spelled (slashes), the field separated by the last dot. */
  if (text.startsWith("@")) {
    const ref = text.slice(1);
    const whole = editor.mesh.entities.find((e) => e.name === ref);
    if (whole) {
      const fields = writeFields(whole);
      if (whole.type || fields.length > 1)
        return { shape: "Struct", type: whole.type, fields };
      return fields.length === 1
        ? { shape: fields[0].shape, elem: fields[0].elem }
        : null;
    }
    const dot = ref.lastIndexOf(".");
    if (dot > 0) {
      const entity = editor.mesh.entities.find((e) => e.name === ref.slice(0, dot));
      const field = entity ? writeFields(entity).find((f) => f.path === ref.slice(dot + 1))
                           : undefined;
      if (field) return { shape: field.shape, elem: field.elem };
    }
  }
  return null;
}

export interface FlowScope {
  /* every name legal at this row: the declared variables plus the temporaries above it */
  locals: LocalInfo[];
  /* what `x` holds at this row, or null when it could not be inferred; a struct x
     carries its field table so completion offers fields */
  x: { shape: string; elem?: string; leaf?: string; fields?: MeshField[] } | null;
}

/* Walk the DO list down to `stepId` (or to the end when it names no step) and report the
 * scope standing at that point. */
export function scopeAt(
  editor: Editor,
  instance: Node | null,
  flow: Flow,
  stepId: number,
): FlowScope {
  const scope = new Map<string, LocalInfo>();
  for (const variable of declared(editor, instance)) scope.set(variable.name, variable);

  /* the trigger's PARAMETER binds by name (an event is a function call and this flow is
     its body); x is the pipeline register and starts Nil until a step sets it */
  const type = editor.registry?.components.find((t) => t.name === instance?.type) ?? null;
  const trigger = (flow?.when ?? []).find((w: Json) => w?.kind === "event");
  if (trigger) {
    const name = String(trigger.name ?? "");
    const params = eventKind(name)?.params ??
      type?.events.find((e) => e.name === name)?.params ?? [];
    for (const p of params)
      scope.set(p.name, { name: p.name, shape: p.shape, note: "event parameter" });
  }
  let x: FlowScope["x"] = null;

  for (const step of (flow?.do ?? []) as Json[]) {
    if (step?.id === stepId) break;
    if (step?.kind !== "assign") continue;
    const to = step.to ?? {};
    if (typeof to.local !== "string" || !to.local) continue;
    const produced = sourceShape(editor, step.from ?? {}, scope);

    if (to.local === "x" && !to.path) {
      x = produced
        ? { shape: produced.shape, elem: produced.elem, leaf: produced.leaf,
            fields: produced.fields }
        : null;
      continue;
    }
    /* a TYPED destination declares a fresh temporary right here, zeroed
       per run, whichever field the row goes on to fill */
    if (typeof to.type === "string" && to.type && !scope.has(to.local)) {
      scope.set(to.local, to.type.includes(".")
        ? { name: to.local, shape: "Enum", type: to.type, note: "temporary" }
        : { name: to.local, shape: "Struct", type: to.type,
            fields: typeFields(editor, to.type), note: "temporary" });
    }
    /* a field write says nothing about the whole value, so it declares nothing */
    if (to.path) continue;
    /* a declared variable keeps the type its author gave it */
    const standing = scope.get(to.local);
    if (standing && standing.note !== "temporary") continue;
    if (!produced) continue;
    scope.set(to.local, {
      name: to.local,
      shape: produced.shape,
      elem: produced.elem,
      leaf: produced.leaf,
      type: produced.type,
      fields: produced.fields,
      note: "temporary",
    });
  }

  /* temporaries first: they are this flow's own vocabulary and the likely pick */
  const locals = [...scope.values()].sort((a, b) =>
    a.note === b.note ? a.name.localeCompare(b.name) : a.note === "temporary" ? -1 : 1,
  );
  return { locals, x };
}

/* the struct local a row's destination names, resolved for its path picker */
export function localAt(
  editor: Editor,
  instance: Node | null,
  flow: Flow,
  stepId: number,
  name: string,
): LocalInfo | null {
  if (!name) return null;
  return scopeAt(editor, instance, flow, stepId).locals.find((l) => l.name === name) ?? null;
}
