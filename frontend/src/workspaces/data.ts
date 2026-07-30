/* The Data workspace: a full-page BROWSER over everything the HMI can name — the
 * reflected mesh, the document's global variables and the served type table — with a
 * detail pane answering the questions the inspector cannot: what is this thing, and
 * where does this document use it. Two columns: a fixed explorer tree (the source
 * picker's folder idiom, but standing, not a popover) and the selected row's detail.
 *
 * Reconciled like the sidebars (workspaces/style.ts is the pattern): the shape is the
 * mesh's structure, the globals, the search text, expansion and the selection; live
 * values bind through the Panel value-sync, so a 30 Hz frame moves numbers in place.
 *
 * HONESTY RULE: a mesh entity has no broadcast value of its own — what exists is what
 * feeds deliver into slot cells. So the only live values shown for an entity are the
 * fed cells of its consumers, labeled by the widget.slot they arrive through. */

import { clear, el } from "../dom.js";
import { Editor, liveText } from "../editor.js";
import { iconMarkup, kindMark } from "../icons.js";
import { sideOf, verbOf } from "../inspector/flows.js";
import { newVariable, varCard, varShape } from "../inspector/vars.js";
import { bindField, bindText } from "../reconcile.js";
import { Feed, Json, MeshEntity, MeshField, MeshType, Widget } from "../types.js";

/* ---- module view state: per view, never synced ---- */

const expanded = new Set<string>(["network", "hmi"]);
let revision = 0;
let filter = "";
let selection = "";

/* the data selection is its own axis: it never touches the canvas/widget selection */
export function dataSelect(key: string): void {
  selection = key;
}

function toggle(editor: Editor, key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  revision++;
  editor.refresh();
}

function select(editor: Editor, key: string): void {
  selection = key;
  editor.refresh();
}

/* ---- shape: what decides which rows exist ---- */

/* every structural reference the document holds, so a where-used row's coming and
 * going rebuilds the pane while the values inside keep flowing */
function refShape(editor: Editor): Json[] {
  const out: Json[] = [];
  for (const page of editor.store.pages())
    for (const widget of editor.store.widgetsOn(page)) {
      for (const feed of widget.feeds ?? [])
        out.push(["f", widget.id, feed.slot, feed.src?.kind ?? "", feed.src?.name ?? "",
                  feed.path ?? "", (feed.xf ?? "") !== ""]);
      for (const flow of widget.flows ?? []) {
        for (const step of flow.do ?? [])
          if (step.kind === "move")
            out.push(["m", widget.id, step.id, step.from ?? null, step.to ?? null]);
          else if (step.kind === "tmr_start" || step.kind === "tmr_cancel")
            out.push(["t", widget.id, step.id, step.kind, step.timer ?? ""]);
      }
    }
  return out;
}

export function dataShape(editor: Editor): string {
  return JSON.stringify({
    filter,
    fold: revision,
    selection,
    /* the reflected mesh is structure: entity rows, their field tables, the types */
    mesh: editor.mesh.entities.map((e) => [
      e.kind, e.name, e.type, e.writable, e.forceable,
      e.fields.map((f) => [f.path, f.shape, (f.variants ?? []).length]),
      (e.returns ?? []).map((f) => [f.path, f.shape]),
    ]),
    types: editor.mesh.types.map((t) => [
      t.name,
      t.fields.map((f) => [f.path, f.shape]),
      t.entities.map((c) => c.kind + ":" + c.name),
    ]),
    globals: editor.store.globals().map(varShape),
    refs: refShape(editor),
    diag: editor.store.globals().flatMap((v) =>
      editor.diagNode(v.id).map((d) => v.id + ":" + d.code + ":" + d.message)),
  });
}

/* ---- the explorer tree ---- */

interface Row {
  depth: number;
  key: string;          /* expansion identity */
  label: string;
  kind?: string;        /* kind mark; folders carry an icon instead */
  icon?: string;
  shape?: string;       /* trailing type, dim */
  title?: string;
  group?: boolean;      /* a small heading row (a function's call/returns split) */
  expandable: boolean;
  select?: string;      /* the data-selection key this row stands for */
  live?: string;        /* a live cell bound beside the label (globals) */
}

/* nested folders from the / segments of entity names, the explorer idiom */
interface Folder {
  folders: Map<string, Folder>;
  entities: MeshEntity[];
}

function foldEntities(entities: MeshEntity[]): Folder {
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

function leafName(name: string): string {
  const at = name.lastIndexOf("/");
  return at < 0 ? name : name.slice(at + 1);
}

const SCALAR_LABEL: Record<string, string> = {
  f64: "number", bool: "bool", str: "text", timer: "timer",
};

function typeKey(type: MeshType, index: number): string {
  return "t:" + (type.name || "#" + index);
}

function variantsText(field: MeshField): string {
  return (field.variants ?? []).map((v) => v.name + "=" + v.value).join(", ");
}

function buildRows(editor: Editor): Row[] {
  const rows: Row[] = [];
  const needle = filter.trim().toLowerCase();
  const searching = needle.length > 0;
  const match = (text: string) => !searching || text.toLowerCase().includes(needle);
  const openOr = (key: string) => searching || expanded.has(key);
  const depth0 = searching ? 0 : 1;

  /* ---- network: the reflected mesh ---- */
  const entityRows = (entity: MeshEntity, depth: number) => {
    const key = "e:" + entity.kind + ":" + entity.name;
    const fields = entity.fields;
    const returns = entity.returns ?? [];
    const descend = fields.length + returns.length > 0;
    const hit = match(entity.name);
    if (hit)
      rows.push({
        depth,
        key,
        label: searching ? entity.name : leafName(entity.name),
        kind: entity.kind,
        shape: entity.type || (fields.length === 1 ? fields[0].shape : ""),
        expandable: descend,
        select: key,
      });
    const fieldRow = (field: MeshField, at: number) =>
      rows.push({
        depth: at,
        key: key + "." + field.path,
        label: field.path,
        shape: field.shape,
        title: variantsText(field) || undefined,
        expandable: false,
        select: key,
      });
    if (hit && descend && openOr(key)) {
      /* a function's two tables are labeled: what a call fills, what it returns */
      if (entity.kind === "F") {
        if (fields.length) rows.push({ depth: depth + 1, key: key + "/call", label: "call",
                                       group: true, expandable: false });
        for (const field of fields) fieldRow(field, depth + 1);
        if (returns.length) rows.push({ depth: depth + 1, key: key + "/returns",
                                        label: "returns", group: true, expandable: false });
        for (const field of returns) fieldRow(field, depth + 1);
      } else {
        for (const field of fields) fieldRow(field, depth + 1);
      }
    } else if (!hit && searching) {
      /* the entity misses the filter; its field paths may still hit */
      for (const field of fields.concat(returns))
        if (match(entity.name + "." + field.path))
          rows.push({
            depth,
            key: key + "." + field.path,
            label: entity.name + " . " + field.path,
            kind: entity.kind,
            shape: field.shape,
            expandable: false,
            select: key,
          });
    }
  };

  const folderRows = (folder: Folder, prefix: string, depth: number) => {
    for (const [name, child] of [...folder.folders.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const key = "d:" + prefix + name;
      if (!searching) {
        rows.push({ depth, key, label: name, expandable: true });
        if (!openOr(key)) continue;
      }
      folderRows(child, prefix + name + "/", searching ? depth : depth + 1);
    }
    for (const entity of [...folder.entities].sort((a, b) => a.name.localeCompare(b.name)))
      entityRows(entity, depth);
  };

  if (!searching) rows.push({ depth: 0, key: "network", label: "network", expandable: true });
  if (openOr("network")) folderRows(foldEntities(editor.mesh.entities), "", depth0);

  /* ---- hmi: the document's own names ---- */
  if (!searching) rows.push({ depth: 0, key: "hmi", label: "hmi", expandable: true });
  if (openOr("hmi")) {
    for (const variable of editor.store.globals())
      if (match(variable.name))
        rows.push({
          depth: depth0,
          key: "v:" + variable.id,
          label: variable.name,
          kind: "g",
          shape: SCALAR_LABEL[variable.type] ?? variable.type,
          expandable: false,
          select: "v:" + variable.id,
          live: "v" + variable.id,
        });
    if (!searching)
      rows.push({ depth: depth0, key: "hmi/+var", label: "+ Variable", icon: "plus",
                  expandable: false });
    const typesKey = "hmi/types";
    if (!searching) {
      rows.push({ depth: depth0, key: typesKey, label: "types", expandable: true });
    }
    if (openOr(typesKey))
      editor.mesh.types.forEach((type, index) => {
        if (!match(type.name || "unnamed")) return;
        rows.push({
          depth: searching ? 0 : depth0 + 1,
          key: typeKey(type, index),
          label: type.name || "(unnamed)",
          icon: "layers",
          shape: type.fields.length + (type.fields.length === 1 ? " field" : " fields"),
          title: type.name ? undefined : "carried by " +
            (type.entities[0] ? type.entities[0].name : "nothing"),
          expandable: false,
          select: typeKey(type, index),
        });
      });
  }

  return rows;
}

export function renderDataTree(host: HTMLElement, editor: Editor): void {
  clear(host);

  const search = el("input", {
    class: "data-search",
    placeholder: "search",
    spellcheck: "false",
  }) as HTMLInputElement;
  search.addEventListener("input", () => {
    filter = search.value;
    editor.refresh();
  });
  bindField("data:search", search, () => filter);
  host.appendChild(search);

  const list = el("div", { class: "data-list" });
  host.appendChild(list);
  const searching = filter.trim().length > 0;

  for (const row of buildRows(editor)) {
    if (row.group) {
      list.appendChild(
        el("div", {
          class: "data-group",
          style: "padding-left:" + (8 + row.depth * 14) + "px",
          text: row.label,
        }),
      );
      continue;
    }
    if (row.key === "hmi/+var") {
      const add = el("button", {
        class: "data-add",
        style: "margin-left:" + (8 + row.depth * 14) + "px",
        text: "+ Variable",
        onclick: () => newVariable(editor, 0, "globals", editor.store.globals()),
      });
      list.appendChild(add);
      continue;
    }
    const caret = row.expandable && !searching
      ? el("span", {
          class: "stree-caret",
          html: iconMarkup("chevron-down", 9, 2),
          style: expanded.has(row.key) ? "" : "transform:rotate(-90deg)",
        })
      : el("span", { class: "stree-caret" });
    if (row.expandable)
      caret.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggle(editor, row.key);
      });
    const live = row.live ? el("span", { class: "data-live" }) : null;
    if (live && row.live) {
      const cell = row.live;
      bindText("data:live:" + cell, live, () => liveText(editor.live, cell));
    }
    const node = el(
      "button",
      {
        class: "stree-row data-row" + (row.select ? "" : " stree-folder") +
               (row.select && row.select === selection ? " current" : ""),
        style: "padding-left:" + (8 + row.depth * 14) + "px",
        "data-key": row.key,
        title: row.title,
      },
      [
        caret,
        row.kind ? kindMark(row.kind) : el("span", {
          class: "stree-foldicon",
          html: iconMarkup(row.icon ?? "folder", 11, 1.6),
        }),
        el("span", { class: "stree-label", text: row.label }),
        live,
        row.shape ? el("span", { class: "stree-shape", text: row.shape }) : null,
      ],
    );
    node.addEventListener("click", () => {
      if (row.select) select(editor, row.select);
      else if (row.expandable && !searching) toggle(editor, row.key);
    });
    list.appendChild(node);
  }
}

/* ---- where-used: the document's structural references, never an expression scan ---- */

interface FeedUse {
  widget: Widget;
  feed: Feed;
}

interface FlowUse {
  widget: Widget;
  text: string;
}

function widgetLabel(widget: Widget): string {
  return widget.label || widget.type;
}

function eachWidget(editor: Editor, visit: (widget: Widget) => void): void {
  for (const page of editor.store.pages())
    for (const widget of editor.store.widgetsOn(page)) visit(widget);
}

function feedUses(editor: Editor, wants: (feed: Feed, widget: Widget) => boolean): FeedUse[] {
  const out: FeedUse[] = [];
  eachWidget(editor, (widget) => {
    for (const feed of widget.feeds ?? [])
      if (wants(feed, widget)) out.push({ widget, feed });
  });
  return out;
}

function flowUses(editor: Editor, wants: (step: Json, widget: Widget) => boolean): FlowUse[] {
  const out: FlowUse[] = [];
  eachWidget(editor, (widget) => {
    for (const flow of widget.flows ?? [])
      for (const step of flow.do ?? [])
        if (wants(step, widget))
          out.push({ widget, text: widgetLabel(widget) + " flow: " + verbOf(step) });
  });
  return out;
}

/* a widget whose OWN local carries the name shadows the global: its references are
 * to the local, so they never count as uses of the global */
function shadows(widget: Widget, name: string): boolean {
  return (widget.locals ?? []).some((v) => v.name === name);
}

function sideNames(side: Json, name: string): boolean {
  return sideOf(side) === "local" && side.local === name;
}

/* one clickable consumer row: landing on the consumer is the point of the listing */
function usedRow(editor: Editor, widget: Widget, cells: (HTMLElement | null)[]): HTMLElement {
  const row = el("button", { class: "used-row", title: "go to " + widgetLabel(widget) }, cells);
  row.addEventListener("click", () => editor.reveal(widget.id));
  return row;
}

function feedUseRow(editor: Editor, use: FeedUse): HTMLElement {
  const cell = use.widget.id + "." + use.feed.slot;
  const live = el("span", {
    class: "data-live",
    title: "live value via " + widgetLabel(use.widget) + "." + use.feed.slot +
           " (the entity itself broadcasts no value)",
  });
  bindText("data:used:" + use.feed.id, live, () => liveText(editor.live, cell));
  return usedRow(editor, use.widget, [
    el("span", { class: "used-name", text: widgetLabel(use.widget) + "." + use.feed.slot }),
    el("span", { class: "op", text: "←" }),
    el("span", {
      class: "used-path",
      text: (use.feed.path || "whole") + (use.feed.xf ? "  f " + use.feed.xf : ""),
    }),
    live,
  ]);
}

function flowUseRow(editor: Editor, use: FlowUse): HTMLElement {
  return usedRow(editor, use.widget, [el("span", { class: "used-name", text: use.text })]);
}

function whereUsed(host: HTMLElement, rows: HTMLElement[]): void {
  host.appendChild(el("div", { class: "detail-sect", text: "WHERE USED" }));
  if (rows.length) host.append(...rows);
  else host.appendChild(el("p", { class: "data-empty",
                              text: "nothing in the document reads or writes it" }));
}

/* ---- the detail pane ---- */

function fieldTable(fields: MeshField[]): HTMLElement {
  return el(
    "div",
    { class: "field-table" },
    fields.flatMap((field) => [
      el("span", { class: "path", text: field.path }),
      el("span", { class: "shape", text: field.shape }),
      el("span", { class: "variants", text: variantsText(field),
                   title: variantsText(field) || undefined }),
    ]),
  );
}

function entityDetail(host: HTMLElement, editor: Editor, kind: string, name: string): void {
  const entity = editor.mesh.entities.find((e) => e.kind === kind && e.name === name);
  host.appendChild(
    el("div", { class: "detail-head" }, [
      kindMark(kind),
      el("span", { class: "detail-name", text: name }),
      entity?.type ? el("span", { class: "detail-type", text: entity.type }) : null,
      entity?.writable ? el("span", { class: "detail-chip", text: "writable" }) : null,
      entity?.forceable ? el("span", { class: "detail-chip", text: "forceable" }) : null,
    ]),
  );
  if (!entity) {
    host.appendChild(el("p", { class: "data-empty", text: "not on the mesh right now" }));
  } else if (entity.kind === "F") {
    if (entity.fields.length) {
      host.appendChild(el("div", { class: "detail-sect", text: "CALL" }));
      host.appendChild(fieldTable(entity.fields));
    }
    if ((entity.returns ?? []).length) {
      host.appendChild(el("div", { class: "detail-sect", text: "RETURNS" }));
      host.appendChild(fieldTable(entity.returns ?? []));
    }
  } else if (entity.fields.length) {
    host.appendChild(el("div", { class: "detail-sect", text: "FIELDS" }));
    host.appendChild(fieldTable(entity.fields));
  }

  const feeds = feedUses(editor, (feed) => feed.src?.kind === kind && feed.src?.name === name);
  const flows = flowUses(editor, (step) =>
    step.kind === "move" &&
    ((sideOf(step.from) === "entity" && step.from.kind === kind && step.from.name === name) ||
     (sideOf(step.to) === "entity" && step.to.kind === kind && step.to.name === name)));
  whereUsed(host, [
    ...feeds.map((use) => feedUseRow(editor, use)),
    ...flows.map((use) => flowUseRow(editor, use)),
  ]);
}

function varDetail(host: HTMLElement, editor: Editor, id: number): void {
  const variable = editor.store.globals().find((v) => v.id === id);
  if (!variable) {
    host.appendChild(el("p", { class: "data-empty", text: "this variable is gone" }));
    return;
  }
  host.appendChild(varCard(editor, variable, "global"));

  const name = variable.name;
  const feeds = feedUses(editor, (feed, widget) =>
    feed.src?.kind === "L" && feed.src?.name === name && !shadows(widget, name));
  const flows = flowUses(editor, (step, widget) => {
    if (shadows(widget, name)) return false;
    if (step.kind === "move") return sideNames(step.from, name) || sideNames(step.to, name);
    if (step.kind === "tmr_start" || step.kind === "tmr_cancel") return step.timer === name;
    return false;
  });
  whereUsed(host, [
    ...feeds.map((use) => feedUseRow(editor, use)),
    ...flows.map((use) => flowUseRow(editor, use)),
  ]);
}

function typeDetail(host: HTMLElement, editor: Editor, key: string): void {
  const index = editor.mesh.types.findIndex((t, i) => typeKey(t, i) === key);
  const type = editor.mesh.types[index];
  if (!type) {
    host.appendChild(el("p", { class: "data-empty", text: "this type is gone" }));
    return;
  }
  host.appendChild(
    el("div", { class: "detail-head" }, [
      el("span", { class: "stree-foldicon", html: iconMarkup("layers", 13, 1.6) }),
      el("span", { class: "detail-name", text: type.name || "(unnamed)" }),
      el("span", { class: "detail-type", text: "type" }),
    ]),
  );
  host.appendChild(el("div", { class: "detail-sect", text: "FIELDS" }));
  host.appendChild(fieldTable(type.fields));

  host.appendChild(el("div", { class: "detail-sect", text: "CARRIED BY" }));
  for (const carrier of type.entities) {
    const row = el("button", { class: "used-row" }, [
      kindMark(carrier.kind),
      el("span", { class: "used-name", text: carrier.name }),
    ]);
    /* jumping to the carrier selects its entity row, revealed in the tree */
    row.addEventListener("click", () => {
      expanded.add("network");
      const segments = carrier.name.split("/");
      let prefix = "";
      for (let i = 0; i + 1 < segments.length; ++i) {
        prefix += segments[i];
        expanded.add("d:" + prefix);
        prefix += "/";
      }
      revision++;
      select(editor, "e:" + carrier.kind + ":" + carrier.name);
    });
    host.appendChild(row);
  }
  if (!type.entities.length)
    host.appendChild(el("p", { class: "data-empty", text: "no entity carries it" }));
}

export function renderDataDetail(host: HTMLElement, editor: Editor): void {
  clear(host);
  const sheet = el("div", { class: "detail-sheet" });
  host.appendChild(sheet);
  const entity = /^e:([A-Z]):(.*)$/.exec(selection);
  if (entity) {
    entityDetail(sheet, editor, entity[1], entity[2]);
    return;
  }
  if (selection.startsWith("v:")) {
    varDetail(sheet, editor, Number(selection.slice(2)));
    return;
  }
  if (selection.startsWith("t:")) {
    typeDetail(sheet, editor, selection);
    return;
  }
  sheet.appendChild(
    el("p", { class: "data-empty", text: "select an entity, a variable or a type" }),
  );
}
