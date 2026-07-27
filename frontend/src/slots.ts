/* Slot resolution, the one rule both the canvas and the inspector must agree on
 * (spec 2.3): a slot WITH a feed resolves to the live value or UNKNOWN, never to a
 * fallback; a slot without one resolves to the instance value, else the type default. */

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
  const instance = widget.slots?.[name];
  if (instance !== undefined) return instance;
  const spec = slotSpec(type, name);
  return spec ? spec.default : null;
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
