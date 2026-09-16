/* The TYPE picker: a tree over the served type table, shaped like the
 * entity tree. Root struct types by name; every root BROWSES into its full field table
 * (so an unfamiliar name can be verified against what it carries), and an enum field is
 * itself pickable as `Root.path.to.field` (RANT names only the root, so everything under
 * it is addressed by the path to where it is used) and expands once more to show its
 * variants, name = value. An UNNAMED root is still in the tree, labeled by the entity
 * carrying it, browsable but not pickable: no name, no TypeRef.
 *
 * Filtered to what the row can accept, and a root with nothing pickable under the
 * constraint is HIDDEN, not shown dead: a Dropdown's options (enums only) lists exactly
 * the types that contain an enum; a variable's type offers the four scalars, the struct
 * roots and every enum field.
 *
 * Same interaction shell as the source tree: one overlay, one popover, expansion state
 * persistent, a search box that flattens to matching picks. */

import { el } from "../dom.js";
import { Editor } from "../editor.js";
import { makeShell, placeBox, Shell } from "../popover.js";
import { scrollToCurrent, streeTree } from "../streerows.js";
import { resolveTypeRef, variantNames } from "../slots.js";

/* resolution moved to slots.ts (the canvas needs it too); re-exported so pickers and
 * editors keep importing it from the type-tree module they already know */
export { resolveTypeRef, variantNames };

export interface TypeTreeOptions {
  scalars?: boolean;   /* offer Num / Bool / Text / Color / Icon / Timer / List / Map */
  /* a component's variable is storage PER PLACEMENT, and a timer has no per-placement
     form — so the one surface that cannot offer it says so here */
  timers?: boolean;
  structs?: boolean;   /* offer struct roots */
  enums?: boolean;     /* offer enum fields as Root.path picks */
}

export interface TypePick {
  ref: string;                          /* what the document stores: "Num", "ValveCmd",
                                           "ValveCmd.mode" */
  kind: "scalar" | "struct" | "enum";
}

const SCALARS = [
  { ref: "Num", label: "Number" },
  { ref: "Bool", label: "Bool" },
  { ref: "Text", label: "Text" },
  /* a colour is a scalar like any other; it was only ever a property SHAPE because
     properties used to be a separate kind of row */
  { ref: "Color", label: "Color" },
  /* an icon variable holds a glyph NAME (text at runtime); the declared type is
     what earns its editors the icon grid */
  { ref: "Icon", label: "Icon" },
  { ref: "Timer", label: "Timer" },
  { ref: "List", label: "List" },
  { ref: "Map", label: "Map" },
];

interface Row {
  depth: number;
  key: string;
  label: string;
  icon?: string;       /* folder roots; types themselves show the layers mark */
  shape?: string;      /* trailing type note */
  note?: string;       /* variant values, the unnamed mark */
  expandable: boolean;
  pick?: TypePick;
}

const expanded = new Set<string>(["hmi", "rant"]);

/* its own shell instance: #ttree stacks ABOVE #stree, because it opens on top of it */
let shell: Shell | null = null;

function ensure(): Shell {
  return (shell ??= makeShell({
    id: "ttree",
    boxClass: "stree-pop",
    dismiss: "backdrop",
    contextDismiss: "backdrop",
    wheel: "passive",
  }));
}

export function closeTypeTree(): void {
  shell?.close();
}

function build_rows(editor: Editor, opts: TypeTreeOptions, filter: string): Row[] {
  const rows: Row[] = [];
  const match = (text: string) => !filter || text.toLowerCase().includes(filter);
  const searching = Boolean(filter);
  const openOr = (key: string) => searching || expanded.has(key);
  const depth0 = searching ? 0 : 1;

  /* the same two roots the entity tree has: `hmi` owns the four built-in scalars,
     `rant` owns everything the mesh serves */
  if (opts.scalars) {
    if (!searching)
      rows.push({ depth: 0, key: "hmi", label: "hmi", icon: "folder", expandable: true });
    if (openOr("hmi"))
      for (const scalar of SCALARS)
        if (match(scalar.label) && (scalar.ref !== "Timer" || opts.timers !== false))
          rows.push({
            depth: depth0,
            key: "sc:" + scalar.ref,
            label: scalar.label,
            expandable: false,
            pick: { ref: scalar.ref, kind: "scalar" },
          });
  }

  if (!searching)
    rows.push({ depth: 0, key: "rant", label: "rant", icon: "folder", expandable: true });
  if (!openOr("rant")) return rows;
  for (const type of editor.mesh.types) {
    /* an unnamed root has no TypeRef: it stays in the tree, labeled by the
       entity carrying it, so its fields can be browsed, but nothing under it picks */
    const named = Boolean(type.name);
    const label = type.name || (type.entities[0]?.name ?? "?");
    const key = "t:" + (type.name || "@" + label);
    const hasEnum = type.fields.some((f) => f.variants?.length);
    const rootPicks = Boolean(opts.structs) && named;
    const fieldPicks = Boolean(opts.enums) && named && hasEnum;
    /* a constrained list HIDES what cannot be picked: an enums-only picker lists
       exactly the types that contain one */
    if (!rootPicks && !fieldPicks && !(opts.structs && !named)) continue;
    if (match(label)) {
      rows.push({
        depth: depth0,
        key,
        label,
        note: named ? "" : "unnamed",
        expandable: true,
        pick: rootPicks ? { ref: type.name, kind: "struct" } : undefined,
      });
    } else if (!fieldPicks) {
      continue;
    }
    if (!searching && !openOr(key)) continue;
    for (const field of type.fields) {
      const isEnum = Boolean(field.variants?.length);
      const picks = isEnum && Boolean(opts.enums) && named;
      const ref = type.name + "." + field.path;
      /* searching flattens to PICKS; browsing shows the whole table for verification */
      if (searching && (!picks || !match(ref))) continue;
      const fkey = key + "." + field.path;
      rows.push({
        depth: searching ? 0 : depth0 + 1,
        key: fkey,
        label: searching ? ref : field.path,
        shape: field.shape,
        expandable: isEnum,
        pick: picks ? { ref, kind: "enum" } : undefined,
      });
      if (isEnum && openOr(fkey) && !searching)
        for (const variant of field.variants ?? [])
          rows.push({
            depth: depth0 + 2,
            key: fkey + ":" + variant.name,
            label: variant.name,
            note: "= " + variant.value,
            expandable: false,
          });
    }
  }
  return rows;
}

export function openTypeTree(
  anchor: HTMLElement,
  editor: Editor,
  opts: TypeTreeOptions,
  onPick: (pick: TypePick) => void,
  current?: string,
): void {
  const sh = ensure();
  const box = sh.box;
  box.innerHTML = "";
  /* every open starts COLLAPSED to the two roots; the one exception is the path to
     what the row already holds, revealed and landed on */
  expanded.clear();
  expanded.add("hmi");
  expanded.add("rant");
  if (current) {
    const dot = current.indexOf(".");
    if (dot > 0) expanded.add("t:" + current.slice(0, dot));
  }

  const tree = streeTree({
    placeholder: "search types",
    expanded,
    defaultIcon: "layers",
    rows: (filter) =>
      build_rows(editor, opts, filter).map((row) => {
        const pick = row.pick;
        return {
          depth: row.depth,
          key: row.key,
          label: row.label,
          icon: row.icon,
          current: Boolean(current && pick?.ref === current),
          expandable: row.expandable,
          onPick: pick && (() => {
            closeTypeTree();
            onPick(pick);
          }),
          trail: [
            row.shape ? el("span", { class: "stree-shape", text: row.shape }) : null,
            row.note ? el("span", { class: "stree-local", text: row.note }) : null,
          ],
        };
      }),
  });
  box.appendChild(tree.search);
  box.appendChild(tree.list);
  tree.render();

  sh.show(anchor);
  scrollToCurrent(tree.list);
  placeBox(box, anchor.getBoundingClientRect(),
           { fallbackW: 240, minW: 240, fallbackH: 200, clampFlip: true });
  tree.search.focus();
}
