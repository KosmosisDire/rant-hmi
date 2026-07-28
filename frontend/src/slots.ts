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
import { Json, Live, Registry, SlotSpec, WidgetType, Widget } from "./types.js";

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

/* Which slots the RUNTIME owns: a feed, an authored flow that assigns the slot, or the
 * type's default behavior. This is a union, not a decision: WHICH of them wins is the
 * backend's precedence rule (spec 2.3) and is not restated here. Whether the slot is
 * written at all does not depend on that, and it is all a view needs to know. */
export function runtimeSlots(widget: Widget, type: WidgetType | null): Set<string> {
  const out = fedSlots(widget);
  const assigned = (flows: Json[]) => {
    for (const flow of flows ?? [])
      for (const step of flow?.do ?? [])
        if (step?.kind === "assign" && typeof step.var === "string" &&
            step.var.startsWith("widget."))
          out.add(step.var.slice("widget.".length));
  };
  assigned(widget.flows ?? []);
  assigned((type?.behavior ?? []) as Json[]);
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
