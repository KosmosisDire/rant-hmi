/* The source picker: every place a feed or a flow names something on the network picks
 * it from ONE hierarchical tree, rendered like a folder listing (the explorer's idiom).
 * Two roots: `dart` (the reflected mesh: topics, functions, variables, signals, foldered
 * by the / segments of their names) and `hmi` (this widget's locals, then the globals).
 * Picking a node carries its kind, name, field path AND value type in one act, so the
 * user never chooses a kind or a type from a dropdown: the network already knows.
 *
 * Same interaction shell as the color picker: a full-screen dismiss overlay owning one
 * popover, wheel events re-dispatched beneath, expansion state kept per tree key across
 * openings. A search box flattens the tree to matching leaves while it has text. */

import { el } from "../dom.js";
import { Editor } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { MeshEntity, MeshField, Var, Widget } from "../types.js";

export interface SourcePick {
  kind: string;   /* V T F S on the mesh, L for an HMI variable */
  name: string;
  path: string;   /* the field within the entity; "" = the entity itself */
  shape: string;  /* the resolved value type ("" when the mesh has not said) */
}

export interface SourceTreeOptions {
  /* descend into an entity's fields (a feed picks a value); false picks entities (a
     send names a target and the message build owns the fields) */
  fields: boolean;
  /* include the hmi root (local + global variables); mesh targets exclude it */
  hmi: boolean;
  /* keep entities a write cannot reach out of a target tree */
  writableOnly?: boolean;
  /* restrict to these kinds (unforce wants only variables); empty = all */
  kinds?: string[];
}

interface Row {
  depth: number;
  key: string;         /* expansion identity */
  label: string;
  kind?: string;       /* kind mark on entity/variable rows */
  shape?: string;      /* trailing type, auto-populated */
  local?: boolean;
  expandable: boolean;
  pick?: SourcePick;
}

const expanded = new Set<string>(["dart", "hmi"]);

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

function fieldsOf(entity: MeshEntity): MeshField[] {
  return entity.kind === "F" ? (entity.returns ?? []) : entity.fields;
}

function varShape(type: string): string {
  return type === "f64" ? "num" : type === "bool" ? "bool" : type === "str" ? "text" : type;
}

/* what a src/path pair resolves to, for the type chips outside the tree */
export function resolveShape(
  editor: Editor,
  widget: Widget | null,
  ref: { kind?: string; name?: string } | undefined,
  path: string | undefined,
): string {
  if (!ref?.name) return "";
  if (ref.kind === "L") {
    const local = widget?.locals.find((v) => v.name === ref.name);
    const found = local ?? editor.store.globals().find((v) => v.name === ref.name);
    return found ? varShape(found.type) : "";
  }
  const entity = editor.mesh.entities.find((e) => e.kind === ref.kind && e.name === ref.name);
  if (!entity) return "";
  const fields = fieldsOf(entity);
  const field = path ? fields.find((f) => f.path === path)
                     : fields.length === 1 ? fields[0] : null;
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

function build_rows(editor: Editor, widget: Widget | null, opts: SourceTreeOptions,
                    filter: string): Row[] {
  const rows: Row[] = [];
  const match = (text: string) => !filter || text.toLowerCase().includes(filter);
  const wanted = (kind: string) => !opts.kinds || opts.kinds.includes(kind);
  const searching = Boolean(filter);
  const openOr = (key: string) => searching || expanded.has(key);

  const entity_rows = (entity: MeshEntity, depth: number) => {
    const fields = fieldsOf(entity);
    const key = "e:" + entity.kind + ":" + entity.name;
    const descend = opts.fields && fields.length > 1;
    const label = searching ? entity.name : leaf_name(entity.name);
    const one = fields.length === 1 ? fields[0] : null;
    if (match(entity.name)) {
      rows.push({
        depth,
        key,
        label,
        kind: entity.kind,
        shape: opts.fields ? (one?.shape ?? "") : "",
        expandable: descend,
        pick: descend
          ? undefined
          : { kind: entity.kind, name: entity.name, path: "", shape: one?.shape ?? "" },
      });
      if (descend && openOr(key))
        for (const field of fields)
          rows.push({
            depth: depth + 1,
            key: key + "." + field.path,
            label: field.path,
            shape: field.shape,
            expandable: false,
            pick: { kind: entity.kind, name: entity.name, path: field.path,
                    shape: field.shape },
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
            pick: { kind: entity.kind, name: entity.name, path: field.path,
                    shape: field.shape },
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
  if (openOr("dart")) folder_rows(fold_entities(mesh_entities), "", searching ? 0 : 1);

  if (opts.hmi && wanted("L")) {
    if (!searching) rows.push({ depth: 0, key: "hmi", label: "hmi", expandable: true });
    if (openOr("hmi")) {
      const variable_row = (variable: Var, local: boolean) => {
        if (!match(variable.name)) return;
        rows.push({
          depth: searching ? 0 : 1,
          key: "v:" + variable.id,
          label: variable.name,
          kind: "L",
          shape: varShape(variable.type),
          local,
          expandable: false,
          pick: { kind: "L", name: variable.name, path: "", shape: varShape(variable.type) },
        });
      };
      for (const variable of widget?.locals ?? []) variable_row(variable, true);
      const shadowed = new Set((widget?.locals ?? []).map((v) => v.name));
      for (const variable of editor.store.globals())
        if (!shadowed.has(variable.name)) variable_row(variable, false);
    }
  }
  return rows;
}

/* ---- the view ---- */

export function openSourceTree(
  anchor: HTMLElement,
  editor: Editor,
  widget: Widget | null,
  opts: SourceTreeOptions,
  onPick: (pick: SourcePick) => void,
): void {
  ensure();
  const box = popover as HTMLElement;
  box.innerHTML = "";

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
          class: "stree-row" + (row.pick ? "" : " stree-folder"),
          style: "padding-left:" + (8 + row.depth * 14) + "px",
        },
        [
          caret,
          row.kind ? kindMark(row.kind) : el("span", {
            class: "stree-foldicon",
            html: iconMarkup("folder", 11, 1.6),
          }),
          el("span", { class: "stree-label", text: row.label }),
          row.local ? el("span", { class: "stree-local", text: "local" }) : null,
          row.shape ? el("span", { class: "stree-shape", text: row.shape }) : null,
        ],
      );
      node.addEventListener("click", () => {
        if (row.pick) {
          closeSourceTree();
          onPick(row.pick);
          return;
        }
        if (expanded.has(row.key)) expanded.delete(row.key);
        else expanded.add(row.key);
        render();
      });
      list.appendChild(node);
    }
    if (!rows.length)
      list.appendChild(el("div", { class: "stree-empty", text: "nothing matches" }));
  };
  search.addEventListener("input", render);
  render();

  (overlay as HTMLElement).classList.add("on");
  active = render;
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
