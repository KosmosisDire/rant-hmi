/* Slot resolution (spec 2.3): a slot WITH a feed resolves to the live value or UNKNOWN,
 * never to a fallback; a slot without one resolves to the instance value, else the type
 * default.
 *
 * There are two readers, because the canvas and the inspector want different things from a
 * slot. `resolveSlot` is the canvas's: it DRAWS the runtime, so the runtime's cell wins
 * wherever it has one. `editedSlot` is the inspector's, and what it shows depends on who
 * OWNS the slot:
 *
 *   nobody writes it   the document IS the value, so the field shows the document. Reading
 *                      the runtime's compiled copy back would fight what the user typed.
 *   something writes it (a feed, an authored flow, or the type's own default behavior)
 *                      the document is only where the runtime STARTED. The field shows the
 *                      live value, because that is the thing the user is reasoning about
 *                      (spec 3.10), and editing it restates where the runtime starts. */

import { Cells } from "./program.js";
import { Json, Live, Mesh, MeshField, MeshType, Registry, SlotSpec, WidgetType, Widget } from "./types.js";

/* What a TypeRef lands on, from the served table: the same resolution the compiler runs
 * (find_type_ref), so what the view expands and what compiles can never disagree. Lives
 * here (the pure slot layer) because the canvas resolves option lists too; the type
 * tree re-exports it. */
export function resolveTypeRef(
  mesh: Mesh,
  ref: string,
): { kind: "struct" | "enum"; type: MeshType; field?: MeshField } | null {
  if (!ref) return null;
  const dot = ref.indexOf(".");
  const root = mesh.types.find((t) => t.name && t.name === (dot < 0 ? ref : ref.slice(0, dot)));
  if (!root) return null;
  if (dot < 0) return { kind: "struct", type: root };
  const field = root.fields.find((f) => f.path === ref.slice(dot + 1));
  return field?.variants?.length ? { kind: "enum", type: root, field } : null;
}

/* the variant names a TypeRef expands to (a Dropdown's options; spec 6.2) */
export function variantNames(mesh: Mesh, ref: string): string[] {
  const found = resolveTypeRef(mesh, ref);
  return found?.field?.variants?.map((v) => v.name) ?? [];
}

/* an options slot resolves to a name list: a literal array, or a TypeRef expanded
 * against the served type table */
export function optionNames(mesh: Mesh | null, raw: Json): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw && mesh) return variantNames(mesh, raw);
  return [];
}

export function typeOf(registry: Registry | null, name: string): WidgetType | null {
  if (!registry) return null;
  return registry.types.find((t) => t.name === name) ?? null;
}

export function slotSpec(type: WidgetType | null, name: string): SlotSpec | null {
  if (!type) return null;
  return type.slots.find((s) => s.name === name) ?? null;
}

/* which slots this widget instance feeds from the mesh (at most one feed per slot) */
export function fedSlots(widget: Widget): Set<string> {
  return new Set((widget.feeds ?? []).map((feed) => feed.slot));
}

/* Which slots the RUNTIME owns: a feed, an authored flow whose move writes the slot, or
 * the type's default behavior. This is a union, not a decision: WHICH of them wins is the
 * backend's precedence rule (spec 2.3) and is not restated here. Whether the slot is
 * written at all does not depend on that, and it is all a view needs to know. */
export function runtimeSlots(widget: Widget, type: WidgetType | null): Set<string> {
  const out = fedSlots(widget);
  const written = (flows: Json[]) => {
    for (const flow of flows ?? [])
      for (const step of flow?.do ?? [])
        if (step?.kind === "move" && typeof step.to?.slot === "string" && step.to.slot)
          out.add(step.to.slot);
  };
  written(widget.flows ?? []);
  written((type?.behavior ?? []) as Json[]);
  return out;
}

/* the live cell key for a widget slot; the backend owns this naming */
export function slotCell(widget: Widget, slot: string): string {
  return widget.id + "." + slot;
}

export function resolveSlot(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  fed: Set<string>,
  name: string,
): Json {
  const value = live?.values?.[slotCell(widget, name)];
  if (value !== undefined) return value;
  if (fed.has(name)) return null; /* fed but nothing delivered yet: UNKNOWN */
  return authoredSlot(widget, type, name);
}

/* what the DOCUMENT says a slot is: the instance value, else the type default */
export function authoredSlot(widget: Widget, type: WidgetType | null, name: string): Json {
  const instance = widget.slots?.[name];
  if (instance !== undefined) return instance;
  const spec = slotSpec(type, name);
  return spec ? spec.default : null;
}

/* What an INSPECTOR field shows. `runtime` is the set of slots something writes
 * (runtimeSlots): for those the field is a live view of the cell, and its authored value is
 * only where that cell started. For the rest the document IS the value and the field shows
 * it, so typing is never fought by a compiled copy of the old one. */
export function editedSlot(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  runtime: Set<string>,
  name: string,
): Json {
  if (!runtime.has(name)) return authoredSlot(widget, type, name);
  const value = live?.values?.[slotCell(widget, name)];
  return value === undefined ? null : value;
}

/* the cell space a template program reads: slots, this view's interaction state, and
 * the tile's own metrics */
export function cellsFor(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  state: Record<string, Json>,
  mesh: Mesh | null = null,
): Cells {
  const fed = fedSlots(widget);
  return (cell: string): Json => {
    const colon = cell.indexOf(":");
    const kind = colon < 0 ? "" : cell.slice(0, colon);
    const name = colon < 0 ? cell : cell.slice(colon + 1);
    switch (kind) {
      case "slot":
        return resolveSlot(widget, type, live, fed, name);
      case "state":
        /* per-view, animation only; interaction lands with the scheduler stage */
        return state[name] ?? false;
      case "tile":
        if (name === "w") return widget.geom.w;
        if (name === "h") return widget.geom.h;
        if (name === "aspect") return widget.geom.h ? widget.geom.w / widget.geom.h : 1;
        return null;
      case "optfrac": {
        /* "optfrac:<value slot>@<options slot>": where the value slot's NAME sits in
           the options slot's list, as a 0..1 fraction (a Selector's pointer angle).
           Unknown value, unknown options or a name outside the list resolve to null,
           and the pointer part draws nothing: never an invented position. */
        const at = name.indexOf("@");
        if (at < 0) return null;
        const value = resolveSlot(widget, type, live, fed, name.slice(0, at));
        const options = optionNames(mesh, resolveSlot(widget, type, live, fed, name.slice(at + 1)));
        if (typeof value !== "string" || options.length < 2) return null;
        const index = options.indexOf(value);
        return index < 0 ? null : index / (options.length - 1);
      }
      default:
        return null;
    }
  };
}

/* "#rrggbb00" and friends are not painted: transparent is a real, common default */
export function opaqueEnough(color: Json): string | null {
  if (typeof color !== "string" || !color.startsWith("#")) return null;
  if (color.length === 9 && color.slice(7).toLowerCase() === "00") return null;
  return color;
}
