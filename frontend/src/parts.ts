/* The slot-to-part index: one walk of a widget type's template, so the Layers tree and
 * the part-scoped inspector can answer "which slots does this part consume" without
 * re-scanning programs per render. A node consumes a slot when any of its attr programs
 * (or its interact's param programs) LOADs a `slot:` cell; a part's SUBTREE union is what
 * the inspector scopes to, because a part's look is everything it lays out. Unnamed nodes
 * have no address of their own (spec 2.3): their slots and named descendants fold into
 * the nearest named ancestor. */

import { Attrs, Json, TemplateNode, WidgetType } from "./types.js";

export interface PartNode {
  path: string; /* names joined with "/" from the template root: the part's address */
  name: string;
  kind: string; /* a box's dir, or a part's draw */
  box: boolean;
  slots: string[]; /* consumed by THIS node's own programs, declaration order */
  children: PartNode[];
}

export interface PartIndex {
  roots: PartNode[];
  byPath: Map<string, PartNode>;
  union: Map<string, string[]>; /* path -> slots consumed anywhere in the subtree */
}

function scanPrograms(attrs: Attrs | undefined, into: Set<string>): void {
  for (const key of Object.keys(attrs ?? {}))
    for (const instr of ((attrs as Json)[key]?.code ?? []) as Json[])
      if (instr.op === "LOAD" && typeof instr.cell === "string" && instr.cell.startsWith("slot:"))
        into.add(instr.cell.slice("slot:".length));
}

/* keyed by the served type OBJECT: a new snapshot serves new objects, so the cache can
   never go stale across reconnects the way a name key could */
const cache = new WeakMap<WidgetType, PartIndex>();

export function partIndex(type: WidgetType): PartIndex {
  const held = cache.get(type);
  if (held) return held;
  const index: PartIndex = { roots: [], byPath: new Map(), union: new Map() };

  /* returns the slots the walked subtree consumes, so a parent's union folds up;
     `own` is the nearest named ancestor's slot set, for unnamed nodes to add to */
  const walk = (
    node: TemplateNode | null,
    prefix: string,
    into: PartNode[],
    own: Set<string>,
  ): Set<string> => {
    if (!node) return new Set();
    const consumed = new Set<string>();
    scanPrograms((node as Json).attrs, consumed);
    scanPrograms((node as Json).interact?.params, consumed);
    const name = typeof (node as Json).name === "string" ? ((node as Json).name as string) : "";
    if (!name) {
      for (const slot of consumed) own.add(slot);
      const sub = new Set(consumed);
      for (const child of ((node as Json).children ?? []) as TemplateNode[])
        for (const slot of walk(child, prefix, into, own)) sub.add(slot);
      return sub;
    }
    const path = prefix ? prefix + "/" + name : name;
    const entry: PartNode = {
      path,
      name,
      kind: node.kind === "box" ? node.dir : node.draw,
      box: node.kind === "box",
      slots: [],
      children: [],
    };
    into.push(entry);
    index.byPath.set(path, entry);
    const mine = new Set(consumed);
    const sub = new Set(consumed);
    for (const child of ((node as Json).children ?? []) as TemplateNode[])
      for (const slot of walk(child, path, entry.children, mine)) sub.add(slot);
    entry.slots = Array.from(mine);
    index.union.set(path, Array.from(sub));
    return sub;
  };

  walk(type.template, "", index.roots, new Set());
  cache.set(type, index);
  return index;
}

/* every slot the part at `path` (or anything under it) consumes; [] for an unknown path */
export function subtreeSlots(type: WidgetType, path: string): string[] {
  return partIndex(type).union.get(path) ?? [];
}
