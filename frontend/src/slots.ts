/* Slot resolution (spec 2.3): what a slot IS, read from the document and the runtime.
 *
 * There used to be two readers here, because the canvas and the inspector wanted different
 * things from a slot. The CANVAS's half — `resolveSlot`, plus the theme-aware, option-
 * expanding and cell-space readers layered on it — went with the renderer that was its only
 * caller; the rebuild re-adds its own consumers against real DOM rather than inheriting a
 * shape drawn for SVG. What is left is the INSPECTOR's, and what it shows depends on who
 * OWNS the slot:
 *
 *   nobody writes it   the document IS the value, so the field shows the document. Reading
 *                      the runtime's compiled copy back would fight what the user typed.
 *   something writes it (a feed, an authored flow, or the type's own default behavior)
 *                      the document is only where the runtime STARTED. The field shows the
 *                      live value, because that is the thing the user is reasoning about
 *                      (spec 3.10), and editing it restates where the runtime starts. */

import { Json, Live, Mesh, MeshField, MeshType, Registry, SlotSpec, Token, WidgetType, Widget } from "./types.js";

/* ---- theme tokens (spec 2.10) ---- */

export type ThemeMode = "dark" | "light";

/* "$<name>" -> the token's value in this mode; a literal passes through untouched; an
 * unknown token is transparent, matching the backend's compile-time fallback */
export function resolveColor(value: Json, tokens: Token[], mode: ThemeMode): Json {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const token = tokens.find((t) => t.name === value.slice(1));
  if (!token) return "#00000000";
  return mode === "light" ? token.light : token.dark;
}

/* What a TypeRef lands on, from the served table: the same resolution the compiler runs
 * (find_type_ref), so what the view expands and what compiles can never disagree. Lives
 * here, in the pure slot layer, and the type tree re-exports it for Data and Vars. */
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

/* ---- nested slot values (spec 2.3) ----
 *
 * A slot's NAME is its address: bare for the widget's own properties, prefixed by the
 * owning part's path for the ones a part declares (`bar.fill_color`). An instance
 * stores them the same way it reads them — nested, one object per part — so the shape
 * of a widget's `slots` mirrors the shape of its type. */

/* what the document authors at one address, or undefined when it authors nothing there
   (including when the path runs into a non-object: a stale value is not a value) */
export function slotValue(slots: Json, address: string): Json {
  let at: Json = slots;
  for (const segment of address.split(".")) {
    if (!at || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = at[segment];
  }
  return at;
}

/* the same object with one address set, copied down the path it touches: op application
   replaces the widget's whole `slots` value, and nothing else may be disturbed */
export function withSlot(slots: Json, address: string, value: Json): Json {
  const segments = address.split(".");
  const root: Json = { ...((slots ?? {}) as Record<string, Json>) };
  let at = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const held = at[segments[i]];
    at[segments[i]] =
      held && typeof held === "object" && !Array.isArray(held) ? { ...held } : {};
    at = at[segments[i]];
  }
  at[segments[segments.length - 1]] = value;
  return root;
}

/* what the DOCUMENT says a slot is: the instance value, else the type default */
export function authoredSlot(widget: Widget, type: WidgetType | null, name: string): Json {
  const instance = slotValue(widget.slots, name);
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

/* "#rrggbb00" and friends are not painted: transparent is a real, common default */
export function opaqueEnough(color: Json): string | null {
  if (typeof color !== "string" || !color.startsWith("#")) return null;
  if (color.length === 9 && color.slice(7).toLowerCase() === "00") return null;
  return color;
}
