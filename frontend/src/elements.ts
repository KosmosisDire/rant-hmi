/* The element index: one walk of a component's template, so the Layers tree and the
 * element-scoped inspector share one set of addresses.
 *
 * An element's address is its names joined with "." from the template root, and the ROOT
 * CARRIES NO SEGMENT: the root element IS the component, so the component's own
 * properties address bare (`value`) and an element's under its path (`bar.fill_color`).
 * That address IS the served slot's name, so which element owns a property is read
 * straight off the component's slot table — split at the last dot — and never guessed
 * from which programs happen to load which cell.
 *
 * Ownership is EXCLUSIVE: a property belongs to exactly one element, appears on exactly
 * one screen, and an element shows nothing its children own. An unnamed node
 * has no address of its own: it renders, and it can own nothing. */

import { Json, SlotSpec, ComponentType } from "./types.js";

/* one addressable node of a component's template, as the inspector reads it */
export interface ElementEntry {
  path: string; /* names joined with "." from the root; "" is the component itself */
  name: string;
  kind: string; /* frame | text | icon | path */
  slots: string[]; /* the slot addresses this node OWNS, declaration order */
  children: ElementEntry[];
}

export interface ElementIndex {
  root: ElementEntry;         /* the component itself: its slots are the top-level ones */
  roots: ElementEntry[];      /* the root's children */
  byPath: Map<string, ElementEntry>;
}

/* the element that owns a slot address, and the property name within it */
function slotOwner(address: string): string {
  const dot = address.lastIndexOf(".");
  return dot < 0 ? "" : address.slice(0, dot);
}

export function slotLeaf(address: string): string {
  const dot = address.lastIndexOf(".");
  return dot < 0 ? address : address.slice(dot + 1);
}

/* keyed by the served component OBJECT: a new snapshot serves new objects, so the cache can
   never go stale across reconnects the way a name key could */
const cache = new WeakMap<ComponentType, ElementIndex>();

export function elementIndex(type: ComponentType): ElementIndex {
  const held = cache.get(type);
  if (held) return held;

  /* address -> the element that owns it, from the slot table alone */
  const owned = new Map<string, string[]>();
  for (const spec of type.slots ?? []) {
    const path = slotOwner(spec.name);
    const list = owned.get(path);
    if (list) list.push(spec.name);
    else owned.set(path, [spec.name]);
  }

  const make = (node: Json, path: string, name: string): ElementEntry => ({
    path,
    name,
    kind: String(node?.kind ?? "frame"),
    slots: owned.get(path) ?? [],
    children: [],
  });

  const index: ElementIndex = {
    root: make(type.template, "", ""),
    roots: [],
    byPath: new Map(),
  };
  index.byPath.set("", index.root);

  const walk = (node: Json, path: string, into: ElementEntry[]): void => {
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

/* THE INPUTS an element owns, in declaration order; the component's own for "".
 *
 * PUBLIC ONLY, and this is the one place that rule is kept: the registry serves a
 * component's private variables too (their cells, addresses and scope entries are real,
 * and its own pictures read them), but they are not part of its interface and an instance
 * has no business seeing them. Every inspector row an instance shows comes through here. */
export function ownedSlots(type: ComponentType | null, path: string): SlotSpec[] {
  if (!type) return [];
  const node = elementIndex(type).byPath.get(path);
  if (!node) return [];
  const want = new Set(node.slots);
  return (type.slots ?? []).filter((spec) => want.has(spec.name) && spec.public !== false);
}
