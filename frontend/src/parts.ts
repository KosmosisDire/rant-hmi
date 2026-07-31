/* The part index: one walk of a widget type's template, so the Layers tree and the
 * part-scoped inspector share one set of addresses.
 *
 * A part's address is its names joined with "." from the template root, and the ROOT
 * CARRIES NO SEGMENT: the root part is the widget itself, so the widget's own
 * properties address bare (`value`) and a part's under its path (`bar.fill_color`).
 * That address IS the served slot's name, so which part owns a property is read
 * straight off the type's slot table — split at the last dot — and never guessed from
 * which programs happen to load which cell.
 *
 * Ownership is EXCLUSIVE: a property belongs to exactly one part, appears on exactly
 * one screen, and a part shows nothing its children own. An unnamed node
 * has no address of its own: it renders, and it can own nothing. */

import { Json, SlotSpec, WidgetType } from "./types.js";

/* one addressable node of a type's template, as the inspector reads it */
export interface PartEntry {
  path: string; /* names joined with "." from the root; "" is the instance itself */
  name: string;
  kind: string; /* frame | text | icon | path */
  layout: string; /* a frame's own layout; "" on a leaf */
  slots: string[]; /* the slot addresses this node OWNS, declaration order */
  children: PartEntry[];
}

export interface PartIndex {
  root: PartEntry;         /* the instance: its slots are the component-level ones */
  roots: PartEntry[];      /* the root's children */
  byPath: Map<string, PartEntry>;
}

/* the part that owns a slot address, and the property name within it */
function slotOwner(address: string): string {
  const dot = address.lastIndexOf(".");
  return dot < 0 ? "" : address.slice(0, dot);
}

export function slotLeaf(address: string): string {
  const dot = address.lastIndexOf(".");
  return dot < 0 ? address : address.slice(dot + 1);
}

/* keyed by the served type OBJECT: a new snapshot serves new objects, so the cache can
   never go stale across reconnects the way a name key could */
const cache = new WeakMap<WidgetType, PartIndex>();

export function partIndex(type: WidgetType): PartIndex {
  const held = cache.get(type);
  if (held) return held;

  /* address -> the part that owns it, from the slot table alone */
  const owned = new Map<string, string[]>();
  for (const spec of type.slots ?? []) {
    const path = slotOwner(spec.name);
    const list = owned.get(path);
    if (list) list.push(spec.name);
    else owned.set(path, [spec.name]);
  }

  const make = (node: Json, path: string, name: string): PartEntry => ({
    path,
    name,
    kind: String(node?.kind ?? "frame"),
    layout: node?.kind === "frame" ? String(node?.layout ?? "free") : "",
    slots: owned.get(path) ?? [],
    children: [],
  });

  const index: PartIndex = {
    root: make(type.template, "", ""),
    roots: [],
    byPath: new Map(),
  };
  index.byPath.set("", index.root);

  const walk = (node: Json, path: string, into: PartEntry[]): void => {
    for (const child of ((node?.children ?? []) as Json[])) {
      const name = typeof (child as Json).name === "string" ? ((child as Json).name as string) : "";
      /* an unnamed node cannot be addressed: it renders, and its children hang off the
         nearest named ancestor rather than acquiring a path of their own */
      if (!name) {
        walk(child, path, into);
        continue;
      }
      const at = path ? path + "." + name : name;
      const entry = make(child, at, name);
      into.push(entry);
      index.byPath.set(at, entry);
      walk(child, at, entry.children);
    }
  };
  walk(type.template, "", index.roots);
  index.root.children = index.roots;

  cache.set(type, index);
  return index;
}

/* the specs a part owns, in the type's declaration order; the widget's own for "" */
export function ownedSlots(type: WidgetType | null, path: string): SlotSpec[] {
  if (!type) return [];
  const node = partIndex(type).byPath.get(path);
  if (!node) return [];
  const want = new Set(node.slots);
  return (type.slots ?? []).filter((spec) => want.has(spec.name));
}
