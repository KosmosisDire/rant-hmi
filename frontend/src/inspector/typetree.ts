/* The TYPE picker (spec 2.2, 3.7): a tree over the served type table, shaped like the
 * entity tree. Root struct types by name; every root BROWSES into its full field table
 * (so an unfamiliar name can be verified against what it carries), and an enum field is
 * itself pickable as `Root.path.to.field` (DART names only the root, so everything under
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
import { iconMarkup } from "../icons.js";
import { Mesh, MeshField, MeshType } from "../types.js";

export interface TypeTreeOptions {
  scalars?: boolean;   /* offer f64 / bool / str / timer */
  structs?: boolean;   /* offer struct roots */
  enums?: boolean;     /* offer enum fields as Root.path picks */
}

export interface TypePick {
  ref: string;                          /* what the document stores: "f64", "ValveCmd",
                                           "ValveCmd.mode" */
  kind: "scalar" | "struct" | "enum";
}

/* What a TypeRef lands on, from the served table: the same resolution the compiler runs
 * (find_type_ref), so what the view expands and what compiles can never disagree. */
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

const SCALARS = [
  { ref: "f64", label: "number" },
  { ref: "bool", label: "bool" },
  { ref: "str", label: "text" },
  { ref: "timer", label: "timer" },
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

const expanded = new Set<string>(["hmi", "dart"]);

let overlay: HTMLElement | null = null;
let popover: HTMLElement | null = null;

function ensure(): void {
  if (overlay) return;
  popover = el("div", { class: "stree-pop" });
  overlay = el("div", { id: "ttree" }, [popover]);
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) closeTypeTree();
  });
  overlay.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (ev.target === overlay) closeTypeTree();
  });
  overlay.addEventListener(
    "wheel",
    (ev) => {
      if (ev.target !== overlay) return;
      overlay!.style.pointerEvents = "none";
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      overlay!.style.pointerEvents = "";
      under?.dispatchEvent(new WheelEvent("wheel", ev));
    },
    { passive: true },
  );
  document.body.appendChild(overlay);
}

export function closeTypeTree(): void {
  overlay?.classList.remove("on");
}

function build_rows(editor: Editor, opts: TypeTreeOptions, filter: string): Row[] {
  const rows: Row[] = [];
  const match = (text: string) => !filter || text.toLowerCase().includes(filter);
  const searching = Boolean(filter);
  const openOr = (key: string) => searching || expanded.has(key);
  const depth0 = searching ? 0 : 1;

  /* the same two roots the entity tree has: `hmi` owns the four built-in scalars,
     `dart` owns everything the mesh serves */
  if (opts.scalars) {
    if (!searching)
      rows.push({ depth: 0, key: "hmi", label: "hmi", icon: "folder", expandable: true });
    if (openOr("hmi"))
      for (const scalar of SCALARS)
        if (match(scalar.label))
          rows.push({
            depth: depth0,
            key: "sc:" + scalar.ref,
            label: scalar.label,
            expandable: false,
            pick: { ref: scalar.ref, kind: "scalar" },
          });
  }

  if (!searching)
    rows.push({ depth: 0, key: "dart", label: "dart", icon: "folder", expandable: true });
  if (!openOr("dart")) return rows;
  for (const type of editor.mesh.types) {
    /* an unnamed root has no TypeRef (spec 2.2): it stays in the tree, labeled by the
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
): void {
  ensure();
  const box = popover as HTMLElement;
  box.innerHTML = "";

  const search = el("input", {
    class: "stree-search",
    placeholder: "search types",
    spellcheck: "false",
  }) as HTMLInputElement;
  const list = el("div", { class: "stree-list" });
  box.appendChild(search);
  box.appendChild(list);

  const render = () => {
    const filter = search.value.trim().toLowerCase();
    list.innerHTML = "";
    for (const row of build_rows(editor, opts, filter)) {
      const caret = row.expandable && !filter
        ? el("span", {
            class: "stree-caret",
            html: iconMarkup("chevron-down", 9, 2),
            style: expanded.has(row.key) ? "" : "transform:rotate(-90deg)",
          })
        : el("span", { class: "stree-caret" });
      const node = el(
        "button",
        {
          class: "stree-row" + (row.pick ? "" : " stree-folder"),
          style: "padding-left:" + (8 + row.depth * 14) + "px",
        },
        [
          caret,
          el("span", { class: "stree-foldicon", html: iconMarkup(row.icon ?? "layers", 11, 1.6) }),
          el("span", { class: "stree-label", text: row.label }),
          row.shape ? el("span", { class: "stree-shape", text: row.shape }) : null,
          row.note ? el("span", { class: "stree-local", text: row.note }) : null,
        ],
      );
      const toggle = () => {
        if (expanded.has(row.key)) expanded.delete(row.key);
        else expanded.add(row.key);
        render();
      };
      node.addEventListener("click", (ev) => {
        /* a row that both expands and picks splits at its ICON: everything left of it
           (the indent and the caret) folds, the name and what follows picks */
        if (row.expandable && row.pick && !filter) {
          const icon = node.children[1] as HTMLElement;
          if (ev.clientX < icon.getBoundingClientRect().left) {
            toggle();
            return;
          }
        }
        if (row.pick) {
          closeTypeTree();
          onPick(row.pick);
          return;
        }
        if (row.expandable) toggle();
      });
      list.appendChild(node);
    }
    if (!list.childElementCount)
      list.appendChild(el("div", { class: "stree-empty", text: "nothing matches" }));
  };
  search.addEventListener("input", render);
  render();

  (overlay as HTMLElement).classList.add("on");
  const at = anchor.getBoundingClientRect();
  const width = Math.max(box.offsetWidth || 240, 240);
  const height = box.offsetHeight || 200;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
  const top = at.bottom + height + 8 > window.innerHeight
    ? Math.max(8, at.top - height - 4)
    : at.bottom + 4;
  box.style.left = left + "px";
  box.style.top = top + "px";
  search.focus();
}
