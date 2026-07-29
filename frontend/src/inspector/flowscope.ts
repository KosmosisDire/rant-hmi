/* What a flow's names mean AT A GIVEN ROW.
 *
 * A DO list is read top to bottom and so is this: the locals a row may name are the ones
 * declared ABOVE it (spec 3.7), `x` is whatever the last move into it produced, and a
 * struct local carries the field table of the type that was moved into it. One pass
 * answers all of that, because they are all the same question.
 *
 * The inference mirrors the compiler's (`move_into_local`), and where the compiler would
 * know more than a view can, this says nothing rather than guessing: an unresolved shape
 * only widens what autocomplete offers, while a wrong one would offer the wrong
 * vocabulary and be believed. */

import { Editor, variablesInScope } from "../editor.js";
import { Flow, Json, MeshEntity, MeshField, Widget } from "../types.js";

export interface LocalInfo {
  name: string;
  /* "num" | "bool" | "text" | "struct" | ... ; "" when it could not be inferred */
  shape: string;
  elem?: string;
  /* struct locals: the type name (may be "" for an unnamed root) and its field table */
  type?: string;
  fields?: MeshField[];
  /* where it came from, for the picker's right-hand note */
  note: "temporary" | "local" | "global";
}

const VAR_SHAPE: Record<string, string> = { f64: "num", bool: "bool", str: "text" };

export function entityOf(editor: Editor, ref: Json): MeshEntity | null {
  if (!ref || !ref.kind || !ref.name) return null;
  return editor.mesh.entities.find((e) => e.kind === ref.kind && e.name === ref.name) ?? null;
}

/* the fields a WRITE may address on an entity: its value/request table, never the
 * response side (that is a feed's business) */
export function writeFields(entity: MeshEntity | null): MeshField[] {
  return entity?.fields ?? [];
}

export function typeFields(editor: Editor, name: string): MeshField[] {
  if (!name) return [];
  return editor.mesh.types.find((t) => t.name === name)?.fields ?? [];
}

/* the declared variables a widget's flows can name, before any move adds to them. A type
 * beyond the four scalars is a TypeRef (spec 2.7): a struct root holds a struct of it,
 * and a dotted ref (`ValveCmd.mode`) holds that enum's value. */
function declared(editor: Editor, widget: Widget | null): LocalInfo[] {
  const own = new Set((widget?.locals ?? []).map((v) => v.id));
  return variablesInScope(editor, widget)
    .filter((v) => v.type !== "timer")
    .map((v) => {
      const note = own.has(v.id) ? ("local" as const) : ("global" as const);
      const scalar = VAR_SHAPE[v.type];
      if (scalar) return { name: v.name, shape: scalar, note };
      if (v.type.includes(".")) return { name: v.name, shape: "enum", type: v.type, note };
      return {
        name: v.name,
        shape: "struct",
        type: v.type,
        fields: typeFields(editor, v.type),
        note,
      };
    });
}

/* what one move SOURCE yields, given what is in scope at that row */
function sourceShape(
  editor: Editor,
  from: Json,
  scope: Map<string, LocalInfo>,
): { shape: string; elem?: string; type?: string; fields?: MeshField[] } | null {
  if (!from || typeof from !== "object") return null;

  if (typeof from.local === "string") {
    const held = scope.get(from.local);
    if (!held) return null;
    if (!from.path) return held;
    const field = (held.fields ?? []).find((f) => f.path === from.path);
    return field ? { shape: field.shape, elem: field.elem } : null;
  }

  if (typeof from.kind === "string") {
    const entity = entityOf(editor, from);
    if (!entity) return null;
    const fields = writeFields(entity);
    if (!from.path) {
      /* a whole-entity read is a struct wherever the entity has a type to be; a
         single-field entity reads as that field, which is what the compiler does */
      if (entity.type || fields.length > 1)
        return { shape: "struct", type: entity.type, fields };
      return fields.length === 1 ? { shape: fields[0].shape, elem: fields[0].elem } : null;
    }
    const field = fields.find((f) => f.path === from.path);
    return field ? { shape: field.shape, elem: field.elem } : null;
  }

  if (typeof from.expr === "string") {
    /* one bare name is worth resolving, since that is what a picker writes; anything
       compound is left to the expression resolver, which has the served tables */
    const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(from.expr.trim());
    if (bare) {
      const held = scope.get(bare[0]);
      if (held) return held;
    }
    return null;
  }
  return null;
}

export interface FlowScope {
  /* every name legal at this row: the declared variables plus the temporaries above it */
  locals: LocalInfo[];
  /* what `x` holds at this row, or null when it could not be inferred; a struct x
     carries its field table so completion offers fields */
  x: { shape: string; elem?: string; fields?: MeshField[] } | null;
}

/* Walk the DO list down to `stepId` (or to the end when it names no step) and report the
 * scope standing at that point. */
export function scopeAt(
  editor: Editor,
  widget: Widget | null,
  flow: Flow,
  stepId: number,
): FlowScope {
  const scope = new Map<string, LocalInfo>();
  for (const variable of declared(editor, widget)) scope.set(variable.name, variable);

  /* x starts as the value the widget proposes for the trigger event (spec 2.6) */
  const type = editor.registry?.types.find((t) => t.name === widget?.type) ?? null;
  const trigger = (flow?.when ?? []).find((w: Json) => w?.kind === "event");
  const event = trigger ? type?.events.find((e) => e.name === trigger.name) : null;
  let x: FlowScope["x"] = event?.x ? { shape: event.x } : null;

  for (const step of (flow?.do ?? []) as Json[]) {
    if (step?.id === stepId) break;
    if (step?.kind !== "move") continue;
    const to = step.to ?? {};
    if (typeof to.local !== "string" || !to.local) continue;
    const produced = sourceShape(editor, step.from ?? {}, scope);

    if (to.local === "x" && !to.path) {
      x = produced
        ? { shape: produced.shape, elem: produced.elem, fields: produced.fields }
        : null;
      continue;
    }
    /* a TYPED destination declares a fresh temporary right here (spec 2.7), zeroed
       per run, whichever field the row goes on to fill */
    if (typeof to.type === "string" && to.type && !scope.has(to.local)) {
      scope.set(to.local, to.type.includes(".")
        ? { name: to.local, shape: "enum", type: to.type, note: "temporary" }
        : { name: to.local, shape: "struct", type: to.type,
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
  widget: Widget | null,
  flow: Flow,
  stepId: number,
  name: string,
): LocalInfo | null {
  if (!name) return null;
  return scopeAt(editor, widget, flow, stepId).locals.find((l) => l.name === name) ?? null;
}
