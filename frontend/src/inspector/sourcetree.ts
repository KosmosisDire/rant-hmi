/* THE picker: every place a feed or a flow names ANYTHING - a mesh entity, an HMI
 * variable, a flow temporary, one of this widget's own slots - picks it from ONE
 * hierarchical tree, rendered like a folder listing (the explorer's idiom). Two roots:
 * `hmi` (this widget's names: the flow's locals in scope, then the variables, then the
 * widget's own slots, then a fresh name) and `dart` (the reflected mesh, foldered by the
 * / segments of entity names). Picking a node carries its family, kind, name, field path
 * AND value type in one act, so the user never states where a thing lives: the pick
 * already knows, and the caller maps it onto the document's key-discriminated side forms.
 *
 * Same interaction shell as the color picker: a full-screen dismiss overlay owning one
 * popover, wheel events re-dispatched beneath, expansion state kept per tree key across
 * openings. A search box flattens the tree to matching leaves while it has text. */

import { el } from "../dom.js";
import { Editor } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { Json, MeshEntity, MeshField, SlotSpec, Var, Node } from "../types.js";
import { FlowScope } from "./flowscope.js";
import { openTypeTree, resolveTypeRef } from "./typetree.js";

export interface SourcePick {
  /* which side FORM the pick maps to: a mesh entity, a local/variable (by name), one of
     this widget's own slots, or the expression escape */
  family: "entity" | "local" | "slot" | "expr";
  kind: string;   /* V T F S on the mesh, L for a variable or local, "" otherwise */
  name: string;   /* entity/variable name; the slot's name; the expression's text */
  path: string;   /* the field within the entity or struct value; "" = the whole thing */
  shape: string;  /* the resolved value type ("" when nothing has said) */
  /* a TYPED fresh temporary (spec 2.7): the TypeRef the new name is declared with,
     zeroed per run at its declaring row */
  type?: string;
}

export interface SourceTreeOptions {
  /* descend into an entity's fields (a feed picks a value); false picks entities (a
     send names a target and the message build owns the fields) */
  fields: boolean;
  /* include the hmi root (locals, variables, slots); mesh-only pickers exclude it */
  hmi: boolean;
  /* keep entities a write cannot reach out of a target tree */
  writableOnly?: boolean;
  /* restrict to these kinds (unforce wants only variables); empty = all */
  kinds?: string[];
  /* an entity that expands into fields is ALSO pickable whole (path ""), for a row that
     moves a whole value in or out. Its caret then toggles and the rest of the row picks. */
  wholeEntity?: boolean;
  /* a flow row's scope: `x` and the locals standing at that row (temporaries first).
     When present it REPLACES the plain variable listing, because it already contains the
     declared variables and adds what the flow itself has made. */
  scope?: FlowScope;
  /* this widget's own slots (a move destination); the specs come from the registry */
  slots?: SlotSpec[];
  /* offer "+ new name" (a temporary, declared by being used; spec 2.7) */
  newName?: boolean;
  /* offer the "expression" escape at the top: the caller switches its side to {expr} */
  expr?: boolean;
}

interface Row {
  depth: number;
  key: string;         /* expansion identity */
  label: string;
  kind?: string;       /* kind mark on entity/variable rows */
  icon?: string;       /* icon instead of a kind mark (folders, the expression escape) */
  shape?: string;      /* trailing type, auto-populated */
  note?: string;       /* trailing note: "local", "temporary" */
  expandable: boolean;
  pick?: SourcePick;
}

/* one pick's identity, for finding the row that holds the CURRENT reference */
function pickKey(pick: SourcePick): string {
  return pick.family + ":" + pick.kind + ":" + pick.name + ":" + pick.path;
}

/* the same identity off a document SIDE ({kind,name,path} | {local,path} | {slot}) */
function sideKey(side: Json | undefined): string | null {
  if (!side || typeof side !== "object") return null;
  if (typeof side.slot === "string" && side.slot) return "slot::" + side.slot + ":";
  if (typeof side.local === "string" && side.local)
    return "local:L:" + side.local + ":" + (side.path ?? "");
  if (typeof side.kind === "string" && side.name) {
    if (side.kind === "L") return "local:L:" + side.name + ":" + (side.path ?? "");
    return "entity:" + side.kind + ":" + side.name + ":" + (side.path ?? "");
  }
  return null;
}

/* expand every folder on the way to the current reference, so the tree OPENS AT what
 * the chip already holds; only ever opens, never collapses */
function revealCurrent(side: Json | undefined): void {
  if (!side || typeof side !== "object") return;
  if (typeof side.kind === "string" && side.kind !== "L" && side.name) {
    expanded.add("dart");
    const segments = String(side.name).split("/");
    let prefix = "";
    for (let i = 0; i + 1 < segments.length; ++i) {
      prefix += segments[i];
      expanded.add("d:" + prefix);
      prefix += "/";
    }
    if (side.path) expanded.add("e:" + side.kind + ":" + side.name);
    return;
  }
  const local = typeof side.local === "string" ? side.local
    : side.kind === "L" ? String(side.name ?? "") : "";
  if (local) {
    expanded.add("hmi");
    if (side.path) expanded.add("v:" + local);
  } else if (typeof side.slot === "string" && side.slot) {
    expanded.add("hmi");
  }
}

const expanded = new Set<string>(["dart", "hmi", "hmi/local", "hmi/global"]);

let overlay: HTMLElement | null = null;
let popover: HTMLElement | null = null;
let active: (() => void) | null = null;

function ensure(): void {
  if (overlay) return;
  popover = el("div", { class: "stree-pop" });
  overlay = el("div", { id: "stree" }, [popover]);
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) closeSourceTree();
  });
  overlay.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (ev.target === overlay) closeSourceTree();
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

export function closeSourceTree(): void {
  overlay?.classList.remove("on");
  active = null;
}

/* ---- the model ---- */

/* A FUNCTION has two field tables and the tree shows the one the row will touch: a
 * read/feed decodes its RESPONSE, a write target fills its REQUEST (the arguments). */
function fieldsOf(entity: MeshEntity, write: boolean): MeshField[] {
  if (entity.kind !== "F") return entity.fields;
  return write ? entity.fields : entity.returns ?? [];
}

const SCALAR_SHAPE: Record<string, string> = { f64: "num", bool: "bool", str: "text" };

function varShape(type: string): string {
  return SCALAR_SHAPE[type] ?? type;
}

/* a variable's struct fields, when its type names a struct ROOT (spec 2.7); a dotted
 * TypeRef is an enum and holds no fields */
function varFields(editor: Editor, type: string): MeshField[] {
  if (!type || SCALAR_SHAPE[type] || type === "timer" || type.includes(".")) return [];
  return editor.mesh.types.find((t) => t.name === type)?.fields ?? [];
}

/* what a src/path pair resolves to, for the type chips outside the tree */
export function resolveShape(
  editor: Editor,
  widget: Node | null,
  ref: { kind?: string; name?: string } | undefined,
  path: string | undefined,
): string {
  if (!ref?.name) return "";
  if (ref.kind === "L") {
    const local = (widget?.locals ?? []).find((v) => v.name === ref.name);
    const found = local ?? editor.store.globals().find((v) => v.name === ref.name);
    if (!found) return "";
    if (!path) return varShape(found.type);
    return varFields(editor, found.type).find((f) => f.path === path)?.shape ?? "";
  }
  const entity = editor.mesh.entities.find((e) => e.kind === ref.kind && e.name === ref.name);
  if (!entity) return "";
  const fields = fieldsOf(entity, /*write=*/ false);
  if (!path && fields.length !== 1) return entity.type ?? "";
  const field = path ? fields.find((f) => f.path === path) : fields[0];
  return field?.shape ?? "";
}

/* nested folders from the / segments of entity names, explorer style */
interface Folder {
  folders: Map<string, Folder>;
  entities: MeshEntity[];
}

function fold_entities(entities: MeshEntity[]): Folder {
  const root: Folder = { folders: new Map(), entities: [] };
  for (const entity of entities) {
    const segments = entity.name.split("/");
    let at = root;
    for (let i = 0; i + 1 < segments.length; ++i) {
      let next = at.folders.get(segments[i]);
      if (!next) {
        next = { folders: new Map(), entities: [] };
        at.folders.set(segments[i], next);
      }
      at = next;
    }
    at.entities.push(entity);
  }
  return root;
}

function leaf_name(name: string): string {
  const at = name.lastIndexOf("/");
  return at < 0 ? name : name.slice(at + 1);
}

function build_rows(editor: Editor, widget: Node | null, opts: SourceTreeOptions,
                    filter: string): Row[] {
  const rows: Row[] = [];
  const match = (text: string) => !filter || text.toLowerCase().includes(filter);
  const wanted = (kind: string) => !opts.kinds || opts.kinds.includes(kind);
  const searching = Boolean(filter);
  const openOr = (key: string) => searching || expanded.has(key);
  const depth0 = searching ? 0 : 1;

  /* the escape hatch first: it is not a name, it is the other way to fill the side */
  if (opts.expr && !searching)
    rows.push({
      depth: 0,
      key: "expr",
      label: "expression",
      icon: "pencil",
      expandable: false,
      pick: { family: "expr", kind: "", name: "x", path: "", shape: "" },
    });

  /* ---- hmi: the names this widget owns. The flow's OWN names (x, its temporaries)
     and the widget's slots sit at the hmi level; the declared variables split into
     `local` and `global` folders, which is where they are declared too. ---- */
  if (opts.hmi) {
    if (!searching) rows.push({ depth: 0, key: "hmi", label: "hmi", expandable: true });
    if (openOr("hmi")) {
      /* one variable or flow local, with its struct fields when it has them */
      const name_rows = (name: string, shape: string, type: string | undefined,
                         fields: MeshField[], note: string, depth: number,
                         mark: string) => {
        const key = "v:" + name;
        const descend = fields.length > 0;
        if (match(name)) {
          rows.push({
            depth,
            key,
            label: name,
            kind: mark,
            shape: type || shape,
            note,
            expandable: descend,
            pick: { family: "local", kind: "L", name, path: "", shape: type || shape },
          });
          if (descend && openOr(key))
            for (const field of fields)
              rows.push({
                depth: depth + 1,
                key: key + "." + field.path,
                label: field.path,
                shape: field.shape,
                expandable: false,
                pick: { family: "local", kind: "L", name, path: field.path,
                        shape: field.shape },
              });
        } else if (descend) {
          for (const field of fields)
            if (match(name + "." + field.path))
              rows.push({
                depth,
                key: key + "." + field.path,
                label: name + " . " + field.path,
                kind: mark,
                shape: field.shape,
                expandable: false,
                pick: { family: "local", kind: "L", name, path: field.path,
                        shape: field.shape },
              });
        }
      };

      /* the variables, bucketed by scope */
      type NamedVar = { name: string; shape: string; type?: string; fields: MeshField[] };
      const buckets: Record<"local" | "global", NamedVar[]> = { local: [], global: [] };
      if (opts.scope) {
        /* the flow's own vocabulary first: x, then its temporaries */
        if (match("x"))
          rows.push({
            depth: depth0,
            key: "v:x",
            label: "x",
            kind: "l",
            shape: opts.scope.x?.shape ?? "",
            expandable: false,
            pick: { family: "local", kind: "L", name: "x", path: "",
                    shape: opts.scope.x?.shape ?? "" },
          });
        for (const local of opts.scope.locals) {
          const row = { name: local.name, shape: local.shape, type: local.type,
                        fields: local.fields ?? [] };
          if (local.note === "temporary")
            name_rows(row.name, row.shape, row.type, row.fields, "temporary", depth0, "l");
          else buckets[local.note].push(row);
        }
      } else if (wanted("L")) {
        const named = (variable: Var): NamedVar => ({
          name: variable.name,
          shape: varShape(variable.type),
          type: varFields(editor, variable.type).length ? variable.type : undefined,
          fields: varFields(editor, variable.type),
        });
        for (const variable of widget?.locals ?? []) buckets.local.push(named(variable));
        const shadowed = new Set((widget?.locals ?? []).map((v) => v.name));
        for (const variable of editor.store.globals())
          if (!shadowed.has(variable.name)) buckets.global.push(named(variable));
      }
      for (const scope of ["local", "global"] as const) {
        if (!buckets[scope].length) continue;
        const key = "hmi/" + scope;
        if (!searching) {
          rows.push({ depth: depth0, key, label: scope, expandable: true });
          if (!openOr(key)) continue;
        }
        for (const row of buckets[scope])
          name_rows(row.name, row.shape, row.type, row.fields, "",
                    searching ? depth0 : depth0 + 1, scope === "local" ? "l" : "g");
      }

      /* the widget's own slots: a move destination, named the way expressions read them */
      for (const spec of opts.slots ?? []) {
        const label = "widget." + spec.name;
        if (!match(label)) continue;
        rows.push({
          depth: depth0,
          key: "s:" + spec.name,
          label,
          icon: "layers",
          shape: spec.shape,
          expandable: false,
          pick: { family: "slot", kind: "", name: spec.name, path: "", shape: spec.shape },
        });
      }
    }
  }

  /* ---- dart: the mesh ---- */
  const entity_rows = (entity: MeshEntity, depth: number) => {
    /* a write-target tree (writableOnly) fills what it picks, so a function shows its
       ARGUMENTS; everywhere else a function is read and shows its response */
    const fields = fieldsOf(entity, Boolean(opts.writableOnly));
    const key = "e:" + entity.kind + ":" + entity.name;
    const descend = opts.fields && fields.length > 1;
    const label = searching ? entity.name : leaf_name(entity.name);
    const one = fields.length === 1 ? fields[0] : null;
    const whole: SourcePick = {
      family: "entity",
      kind: entity.kind,
      name: entity.name,
      path: "",
      shape: descend ? entity.type ?? "" : one?.shape ?? "",
    };
    if (match(entity.name)) {
      rows.push({
        depth,
        key,
        label,
        kind: entity.kind,
        shape: opts.fields ? whole.shape : "",
        expandable: descend,
        pick: descend && !opts.wholeEntity ? undefined : whole,
      });
      if (descend && openOr(key))
        for (const field of fields)
          rows.push({
            depth: depth + 1,
            key: key + "." + field.path,
            label: field.path,
            shape: field.shape,
            expandable: false,
            pick: { family: "entity", kind: entity.kind, name: entity.name,
                    path: field.path, shape: field.shape },
          });
    } else if (descend) {
      /* the entity itself misses the filter; its fields may still hit */
      for (const field of fields)
        if (match(entity.name + "." + field.path))
          rows.push({
            depth,
            key: key + "." + field.path,
            label: entity.name + " . " + field.path,
            kind: entity.kind,
            shape: field.shape,
            expandable: false,
            pick: { family: "entity", kind: entity.kind, name: entity.name,
                    path: field.path, shape: field.shape },
          });
    }
  };

  const folder_rows = (folder: Folder, prefix: string, depth: number) => {
    for (const [name, child] of [...folder.folders.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const key = "d:" + prefix + name;
      if (!searching) {
        rows.push({ depth, key, label: name, expandable: true });
        if (!openOr(key)) continue;
      }
      folder_rows(child, prefix + name + "/", searching ? depth : depth + 1);
    }
    for (const entity of [...folder.entities].sort((a, b) => a.name.localeCompare(b.name)))
      entity_rows(entity, depth);
  };

  const mesh_entities = editor.mesh.entities.filter(
    (entity) =>
      wanted(entity.kind) &&
      (!opts.writableOnly || entity.kind !== "V" || entity.writable),
  );
  /* searching flattens to matching leaves; the root folders only frame a browse */
  if (!searching) rows.push({ depth: 0, key: "dart", label: "dart", expandable: true });
  if (openOr("dart")) folder_rows(fold_entities(mesh_entities), "", depth0);

  return rows;
}

/* ---- the view ---- */

export function openSourceTree(
  anchor: HTMLElement,
  editor: Editor,
  widget: Node | null,
  opts: SourceTreeOptions,
  onPick: (pick: SourcePick) => void,
  current?: Json,
): void {
  ensure();
  const box = popover as HTMLElement;
  box.innerHTML = "";
  /* every open starts COLLAPSED to the two worlds' top level; the one exception is
     the path to what the chip already holds, revealed and landed on */
  expanded.clear();
  expanded.add("dart");
  expanded.add("hmi");
  expanded.add("hmi/local");
  expanded.add("hmi/global");
  revealCurrent(current);
  const wanted = sideKey(current);

  const search = el("input", {
    class: "stree-search",
    placeholder: "search",
    spellcheck: "false",
  }) as HTMLInputElement;
  const list = el("div", { class: "stree-list" });
  box.appendChild(search);
  box.appendChild(list);

  const render = () => {
    const filter = search.value.trim().toLowerCase();
    list.innerHTML = "";
    const rows = build_rows(editor, widget, opts, filter);
    for (const row of rows) {
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
          class: "stree-row" + (row.pick ? "" : " stree-folder") +
                 (wanted && row.pick && pickKey(row.pick) === wanted ? " current" : ""),
          style: "padding-left:" + (8 + row.depth * 14) + "px",
        },
        [
          caret,
          row.kind ? kindMark(row.kind) : el("span", {
            class: "stree-foldicon",
            html: iconMarkup(row.icon ?? "folder", 11, 1.6),
          }),
          el("span", { class: "stree-label", text: row.label }),
          row.note ? el("span", { class: "stree-local", text: row.note }) : null,
          row.shape ? el("span", { class: "stree-shape", text: row.shape }) : null,
        ],
      );
      const toggle = () => {
        if (expanded.has(row.key)) expanded.delete(row.key);
        else expanded.add(row.key);
        render();
      };
      node.addEventListener("click", (ev) => {
        /* a row that both expands and picks splits at its ICON: everything left of it
           (the indent and the caret) folds, the name and what follows picks. A click
           with no coordinates (keyboard, scripted) always picks. */
        if (row.expandable && row.pick && !filter && ev.detail !== 0) {
          const icon = node.children[1] as HTMLElement;
          if (ev.clientX < icon.getBoundingClientRect().left) {
            toggle();
            return;
          }
        }
        if (row.pick) {
          closeSourceTree();
          onPick(row.pick);
          return;
        }
        toggle();
      });
      list.appendChild(node);
    }

    /* A fresh temporary needs only a name (spec 2.7): a text row, Enter commits it,
       typed by what the move puts into it. The button beside it declares the name WITH
       a type instead: a per-run zeroed value of that type, which is where a clean
       message comes from. A struct pick aims the row at the type's first field, so the
       declaring row is immediately a useful one. */
    if (opts.newName && !filter) {
      const name = el("input", {
        class: "stree-new",
        placeholder: "+ new name",
        spellcheck: "false",
      }) as HTMLInputElement;
      name.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        const text = name.value.trim();
        if (!text) return;
        closeSourceTree();
        onPick({ family: "local", kind: "L", name: text, path: "", shape: "" });
      });
      name.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      const typed = el("button", {
        class: "icon-btn",
        title: "declare it with a type (a fresh zeroed value)",
        html: iconMarkup("layers", 11, 1.6),
      });
      typed.addEventListener("click", () => {
        const text = name.value.trim();
        if (!text) {
          name.focus();
          return;
        }
        openTypeTree(typed, editor, { structs: true, enums: true }, (pick) => {
          const resolved = resolveTypeRef(editor.mesh, pick.ref);
          const first = pick.kind === "struct"
            ? resolved?.type.fields.find((f) => f.shape !== "list" && f.shape !== "map")
            : undefined;
          closeSourceTree();
          onPick({ family: "local", kind: "L", name: text, path: first?.path ?? "",
                   shape: "", type: pick.ref });
        });
      });
      list.appendChild(el("div", { class: "stree-newrow" }, [name, typed]));
    }

    if (!rows.length && !opts.newName)
      list.appendChild(el("div", { class: "stree-empty", text: "nothing matches" }));
  };
  search.addEventListener("input", render);
  render();

  (overlay as HTMLElement).classList.add("on");
  active = render;
  /* land on what the chip already holds */
  list.querySelector(".stree-row.current")?.scrollIntoView({ block: "center" });
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

/* the mesh moved while the tree is open: re-render in place */
export function refreshSourceTree(): void {
  active?.();
}
