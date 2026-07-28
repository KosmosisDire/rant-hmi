/* Slot resolution (spec 2.3): a slot WITH a feed resolves to the live value or UNKNOWN,
 * never to a fallback; a slot without one resolves to the instance value, else the type
 * default.
 *
 * There are two readers, because the canvas and the inspector want different things from an
 * unfed slot. `resolveSlot` is the canvas's: it DRAWS the runtime, so the runtime's cell
 * wins wherever it has one. `editedSlot` is the inspector's: a field EDITS the document, so
 * an unfed slot reads what the document says. They agree exactly where it matters, on a fed
 * slot, which neither can source anywhere but the feed. */

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

/* What an INSPECTOR field shows, which is not what the canvas draws. The canvas renders the
 * runtime and so reads the live cell for every slot; a field is an INPUT, and an input must
 * show the thing it edits. So an unfed slot reads from the document: the runtime's cell for
 * it is a compiled copy, and reading that back would fight whatever the user just typed.
 * A fed slot has no authored value to show, so it is a read-only view of the feed: the live
 * value, or UNKNOWN until something arrives. */
export function editedSlot(
  widget: Widget,
  type: WidgetType | null,
  live: Live | null,
  fed: Set<string>,
  name: string,
): Json {
  if (!fed.has(name)) return authoredSlot(widget, type, name);
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
