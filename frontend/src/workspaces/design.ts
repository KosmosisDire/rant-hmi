/* The Design workspace: where a component is pulled apart and modified.
 *
 * This is the SECOND hierarchy in the editor, and it is deliberately not in the Layers
 * sidebar. Layers is page composition — how widget instances are grouped and laid out on
 * a page — and a component instance is a leaf there. What is inside a component is a
 * different tree with a different lifetime (it belongs to the TYPE, not to the page), so
 * it gets its own workspace rather than a second section under the page's own tree.
 *
 * Three columns: the component list on the left, a live preview of the selected
 * component in the middle (shell.ts owns its own Viewport and render loop, mirroring the
 * Content stage; this module supplies the pure lookups it drives), the component/part
 * inspector on the right. */

import { Editor } from "../editor.js";
import { el } from "../dom.js";
import { diagIcon } from "../editor.js";
import { ICONS, iconMarkup } from "../icons.js";
import { componentInspectorShape, renderComponentInspector } from "../inspector/components.js";
import { MenuItem, openMenu } from "../menu.js";
import { bindText } from "../reconcile.js";
import { makeFold, PART_GLYPH, treeRow } from "../tree.js";
import { ComponentDef, Json } from "../types.js";

/* the component tree's own expansion state, independent of the Layers tree's */
const fold = makeFold();

function toggle(editor: Editor, key: string, dflt: boolean): void {
  fold.toggle(key, dflt, () => editor.refresh());
}

/* a doc component's part tree as structure (names are bound values; ids, kinds and
 * nesting decide which rows exist) */
function docPartShape(part: Json): Json {
  return [part?.id, part?.kind, part?.dir ?? "",
          ((part?.children ?? []) as Json[]).map(docPartShape)];
}

/* every finding under a component subtree, flattened: they pin marks on tree rows */
function componentDiagShape(editor: Editor, comp: ComponentDef): string[] {
  const out: string[] = [];
  const add = (id: number) => {
    for (const d of editor.diagNode(id))
      out.push(id + ":" + (d.where ?? "") + ":" + d.code + ":" + d.message);
  };
  add(comp.id);
  for (const prop of comp.props ?? []) add(prop.id);
  const walk = (part: Json): void => {
    if (typeof part?.id === "number") add(part.id);
    for (const prop of (part?.props ?? []) as Json[]) add(prop.id);
    for (const child of (part?.children ?? []) as Json[]) walk(child);
  };
  for (const part of comp.parts ?? []) walk(part);
  return out;
}

export function designShape(editor: Editor): string {
  const comps = editor.store.components();
  const shadowed = new Set(comps.map((c) => c.name));
  const builtinNames = new Set(editor.builtins.map((b: Json) => b?.name));
  return JSON.stringify({
    components: comps.map((c) => [c.id, builtinNames.has(c.name),
                                  (c.parts ?? []).map(docPartShape)]),
    builtins: editor.builtins.map((b: Json) => b?.name).filter((n: Json) => !shadowed.has(n)),
    sel: editor.componentSel ? [editor.componentSel.component, editor.componentSel.node] : null,
    builtinSel: editor.builtinSel ? [editor.builtinSel.name, editor.builtinSel.path] : null,
    fold: fold.revision(),
    diag: comps.flatMap((c) => componentDiagShape(editor, c)),
  });
}

export function renderDesignTree(host: HTMLElement, editor: Editor): void {
  const comps = editor.store.components();
  const shadowed = new Set(comps.map((c) => c.name));
  const builtinNames = new Set(editor.builtins.map((b: Json) => b?.name));
  const unshadowed = editor.builtins.filter((b: Json) => b?.name && !shadowed.has(b.name));

  host.appendChild(el("div", { class: "tree-head" }, [
    el("span", { class: "tree-title", text: "Components" }),
    el("span", { class: "count", text: String(comps.length) }),
  ]));
  host.appendChild(
    el("div", { class: "layers" }, [
      ...comps.flatMap((c) => docComponentRows(editor, c, builtinNames.has(c.name))),
      ...unshadowed.flatMap((b: Json) => builtinComponentRows(editor, b)),
    ]),
  );
  host.appendChild(
    el("button", { class: "dashed-btn", text: "+ Component",
                   onclick: () => editor.addComponent() }),
  );
}

/* the inspector column: exactly the component/part views, which already route between a
   doc component, one of its part nodes, and a browsed built-in */
export function renderDesignInspector(host: HTMLElement, editor: Editor): void {
  if (componentInspectorShape(editor)) {
    renderComponentInspector(host, editor);
    return;
  }
  host.appendChild(
    el("div", { class: "inspector-head" }, [
      el("span", { class: "type", text: "nothing selected" }),
    ]),
  );
  host.appendChild(
    el("div", { class: "inspector-body" }, [
      el("p", { class: "empty", text: "pick a component to pull it apart" }),
    ]),
  );
}

export function designInspectorShape(editor: Editor): string {
  return componentInspectorShape(editor) ?? "empty";
}

/* ---- rows ---- */

/* the row-level verb menu (spec 2.3 Forking): every doc/built-in component row gets
 * one kebab opening the menu.ts context menu at the click point, so all of a row's
 * verbs are one gesture away without crowding the row with icons — the row itself
 * stays a single click to SELECT. */
function componentMenuButton(name: string, items: () => MenuItem[]): HTMLElement {
  const btn = el("span", {
    class: "icon-btn layer-menu",
    title: "duplicate, override or revert " + name,
    html: iconMarkup("ellipsis-vertical", 12),
  });
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const at = (btn as HTMLElement).getBoundingClientRect();
    openMenu(at.left, at.bottom + 4, name, items());
  });
  return btn;
}

/* a doc component's own verbs: "Duplicate as…" always (it may itself be duplicated
 * again), then EITHER "Revert to built-in" — only where it actually shadows one,
 * since that is what restores the built-in — or an ordinary "Delete" otherwise,
 * deleting a component with no built-in behind it just destroys it (spec: the
 * component that shadows nothing has nothing to "revert" to). Both destructive
 * verbs read danger-styled, the menu's own confirm idiom (menu.ts). */
function docComponentMenu(editor: Editor, comp: ComponentDef, shadows: boolean): MenuItem[] {
  /* read the live name rather than the render-time `comp`: a rename does not change
     the row's SHAPE, so this closure can outlive it */
  const liveName = () => ((editor.store.node(comp.id) as Json)?.name as string) ?? comp.name;
  return [
    { label: "Duplicate as…", icon: "copy", run: () => editor.duplicateComponent(liveName()) },
    shadows
      ? { label: "Revert to built-in", icon: "rotate-ccw", danger: true,
          run: () => editor.apply([{ op: "remove", node: comp.id }]) }
      : { label: "Delete", icon: "trash", danger: true,
          run: () => editor.apply([{ op: "remove", node: comp.id }]) },
  ];
}

function docComponentRows(editor: Editor, comp: ComponentDef, shadows: boolean): HTMLElement[] {
  const key = "c" + comp.id;
  const open = fold.open(key, false);
  const parts = comp.parts ?? [];
  const label = el("span", { class: "layer-label" + (shadows ? " shadows" : "") });
  bindText(comp.id + ":name.layer", label, () =>
    (editor.store.node(comp.id) as Json)?.name ?? "");
  const row = treeRow(
    key,
    0,
    "component" + (editor.componentSel?.node === comp.id ? " current" : ""),
    parts.length ? { open, toggle: () => toggle(editor, key, false) } : null,
    [
      el("span", {
        class: "layer-glyph",
        html: iconMarkup(ICONS[comp.name] ? comp.name : "layers", 11, 1.7),
      }),
      label,
      diagIcon(editor.diagNode(comp.id)),
      /* legible in the row itself, not only the tooltip below: which types are
         customized should read from the list alone */
      shadows ? el("span", { class: "badge shadow", text: "override" }) : null,
      componentMenuButton(comp.name, () => docComponentMenu(editor, comp, shadows)),
    ],
    () => editor.selectComponent(comp.id, comp.id),
    shadows ? "overrides built-in" : comp.name,
  );
  const rows = [row];
  if (open) for (const part of parts) rows.push(...docPartTreeRows(editor, comp, part, 1));
  return rows;
}

function docPartTreeRows(editor: Editor, comp: ComponentDef, part: Json, depth: number): HTMLElement[] {
  const key = "c" + comp.id + "/" + part.id;
  const open = fold.open(key, true);
  const children = (part.children ?? []) as Json[];
  const glyph = PART_GLYPH[part.kind === "box" ? (part.dir ?? "stack") : part.kind] ?? "·";
  const label = el("span", { class: "layer-label" });
  bindText(part.id + ":name.layer", label, () =>
    (editor.store.node(part.id) as Json)?.name ?? "");
  const row = treeRow(
    key,
    depth,
    "part" + (editor.componentSel?.node === part.id ? " current" : ""),
    children.length ? { open, toggle: () => toggle(editor, key, true) } : null,
    [el("span", { class: "layer-glyph draw", text: glyph }), label,
     diagIcon(editor.diagNode(part.id))],
    () => editor.selectComponent(comp.id, part.id),
    part.name + " (" + part.kind + ")",
  );
  const rows = [row];
  if (open)
    for (const child of children) rows.push(...docPartTreeRows(editor, comp, child, depth + 1));
  return rows;
}

/* a built-in's own two verbs: "Override <Name>" shadows it under its own name (every
 * existing instance follows automatically), "Duplicate as…" copies it under a fresh
 * name instead, leaving the built-in and its instances alone — the verb the fork icon
 * alone could not say. The built-ins are snapshot-only (spec: never change at runtime),
 * so closing over `name` here is safe unlike the doc component menu above. */
function builtinComponentMenu(editor: Editor, name: string): MenuItem[] {
  return [
    { label: "Override " + name, icon: "git-branch", run: () => editor.forkBuiltin(name) },
    { label: "Duplicate as…", icon: "copy", run: () => editor.duplicateComponent(name) },
  ];
}

/* A built-in row SELECTS, exactly as a doc component's does; what differs is only what
 * the inspector then shows (the definition, read-only) and how the row is addressed:
 * a built-in is not in the document, so there is no node id to name it by and the
 * address is its name plus a CHILD-INDEX path into its parts. */
function builtinComponentRows(editor: Editor, comp: Json): HTMLElement[] {
  const name = String(comp?.name ?? "");
  const key = "b:" + name;
  const open = fold.open(key, false);
  const parts = Array.isArray(comp?.parts) ? (comp.parts as Json[]) : [];
  const current = editor.builtinSel?.name === name && !editor.builtinSel.path;
  const row = treeRow(
    key,
    0,
    "component builtin" + (current ? " current" : ""),
    parts.length ? { open, toggle: () => toggle(editor, key, false) } : null,
    [
      el("span", {
        class: "layer-glyph",
        html: iconMarkup(ICONS[name] ? name : "layers", 11, 1.7),
      }),
      el("span", { class: "layer-label", text: name }),
      componentMenuButton(name, () => builtinComponentMenu(editor, name)),
    ],
    () => editor.selectBuiltin(name, ""),
    name + " (built-in, read-only)",
  );
  const rows = [row];
  if (open)
    parts.forEach((part, i) => rows.push(...builtinPartRows(editor, name, String(i), part, 1)));
  return rows;
}

function builtinPartRows(
  editor: Editor,
  comp: string,
  path: string,
  part: Json,
  depth: number,
): HTMLElement[] {
  const name = String(part?.name ?? "");
  const key = "b:" + comp + "/" + path;
  const open = fold.open(key, true);
  const children = Array.isArray(part?.children) ? (part.children as Json[]) : [];
  const glyph = PART_GLYPH[part?.kind === "box" ? (part?.dir ?? "stack") : part?.kind] ?? "·";
  const current = editor.builtinSel?.name === comp && editor.builtinSel.path === path;
  const row = treeRow(
    key,
    depth,
    "part builtin" + (current ? " current" : ""),
    children.length ? { open, toggle: () => toggle(editor, key, true) } : null,
    [el("span", { class: "layer-glyph draw", text: glyph }),
     el("span", { class: "layer-label", text: name || "(unnamed)" })],
    () => editor.selectBuiltin(comp, path),
    name + " (" + part?.kind + ", read-only)",
  );
  const rows = [row];
  if (open)
    children.forEach((child, i) =>
      rows.push(...builtinPartRows(editor, comp, path + "." + i, child, depth + 1)));
  return rows;
}
