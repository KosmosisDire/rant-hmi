/* The Design workspace: where a component is pulled apart and modified.
 *
 * This is the SECOND hierarchy in the editor, and it is deliberately not in the Layers
 * sidebar. Layers is page composition — how instances are grouped and laid out on
 * a page — and a component instance is a leaf there. What is inside a component is a
 * different tree with a different lifetime (it belongs to the TYPE, not to the page), so
 * it gets its own workspace rather than a second section under the page's own tree.
 *
 * Three columns: the component list on the left, the component/element inspector on the
 * right, and BETWEEN THEM AN EMPTY STAGE. The preview that stood there was a second
 * artboard driven by the SVG renderer, with a camera of its own; both are gone, and with
 * them the element addressing that translated a click on the glass into a selection. This
 * module is now the two side columns and nothing else. Authoring a component still works
 * end to end — the tree selects, the inspector edits — it just cannot be watched while it
 * happens, until the DOM preview lands and defines its own addressing. */

import { Editor } from "../editor.js";
import { el } from "../dom.js";
import { diagIcon } from "../editor.js";
import { ICONS, iconMarkup } from "../icons.js";
import { componentInspectorShape, renderComponentInspector } from "../inspector/components.js";
import { MenuItem, openMenu } from "../menu.js";
import { bindText } from "../reconcile.js";
import { makeFold, KIND_GLYPH, treeRow } from "../tree.js";
import { ComponentDef, Json } from "../types.js";

/* the component tree's own expansion state, independent of the Layers tree's */
const fold = makeFold();

function toggle(editor: Editor, key: string, dflt: boolean): void {
  fold.toggle(key, dflt, () => editor.refresh());
}

/* a doc component's node tree as structure (names are bound values; ids, kinds and
 * nesting decide which rows exist) */
function docElementShape(element: Json): Json {
  return [element?.id, element?.kind, element?.dir ?? "",
          ((element?.children ?? []) as Json[]).map(docElementShape)];
}

/* every finding under a component subtree, flattened: they pin marks on tree rows */
function componentDiagShape(editor: Editor, comp: ComponentDef): string[] {
  const out: string[] = [];
  const add = (id: number) => {
    for (const d of editor.diagNode(id))
      out.push(id + ":" + (d.where ?? "") + ":" + d.code + ":" + d.message);
  };
  add(comp.id);
  for (const variable of comp.locals ?? []) add(variable.id);
  const walk = (element: Json): void => {
    if (typeof element?.id === "number") add(element.id);
    for (const variable of (element?.locals ?? []) as Json[]) add(variable.id);
    for (const child of (element?.children ?? []) as Json[]) walk(child);
  };
  for (const element of comp.children ?? []) walk(element);
  return out;
}

export function designShape(editor: Editor): string {
  const comps = editor.store.components();
  const shadowed = new Set(comps.map((c) => c.name));
  const builtinNames = new Set(editor.builtins.map((b: Json) => b?.name));
  return JSON.stringify({
    components: comps.map((c) => [c.id, builtinNames.has(c.name),
                                  (c.children ?? []).map(docElementShape)]),
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

/* the inspector column: exactly the component/element views, which already route between
   a doc component, one of its element nodes, and a browsed built-in */
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

/* the row-level verb menu: every doc/built-in component row gets
 * one kebab opening the menu.ts context menu at the click point, so all of a row's
 * verbs are one gesture away without crowding the row with icons — the row itself
 * stays a single click to SELECT. */
function componentMenuButton(name: string, items: () => MenuItem[]): HTMLElement {
  const btn = el("button", {
    class: "icon-btn layer-menu",
    title: "duplicate, override or revert " + name,
    tabindex: "-1",
    html: iconMarkup("ellipsis-vertical", 16, 1.7),
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
  const elements = comp.children ?? [];
  const label = el("span", { class: "layer-label" + (shadows ? " shadows" : "") });
  bindText(comp.id + ":name.layer", label, () =>
    (editor.store.node(comp.id) as Json)?.name ?? "");
  const row = treeRow(
    key,
    0,
    "component" + (editor.componentSel?.node === comp.id ? " current" : ""),
    elements.length ? { open, toggle: () => toggle(editor, key, false) } : null,
    [
      el("span", {
        class: "icon-mark layer-glyph",
        html: iconMarkup(ICONS[comp.name] ? comp.name : "layers", 16, 1.5),
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
  if (open) for (const element of elements) rows.push(...docElementTreeRows(editor, comp, element, 1));
  return rows;
}

function docElementTreeRows(editor: Editor, comp: ComponentDef, element: Json, depth: number): HTMLElement[] {
  const key = "c" + comp.id + "/" + element.id;
  const open = fold.open(key, true);
  const children = (element.children ?? []) as Json[];
  const glyph = KIND_GLYPH[element.kind] ?? "·";
  const label = el("span", { class: "layer-label" });
  bindText(element.id + ":name.layer", label, () =>
    (editor.store.node(element.id) as Json)?.name ?? "");
  const row = treeRow(
    key,
    depth,
    "element" + (editor.componentSel?.node === element.id ? " current" : ""),
    children.length ? { open, toggle: () => toggle(editor, key, true) } : null,
    [el("span", { class: "icon-mark layer-glyph draw", text: glyph }), label,
     diagIcon(editor.diagNode(element.id))],
    () => editor.selectComponent(comp.id, element.id),
    element.name + " (" + element.kind + ")",
  );
  const rows = [row];
  if (open)
    for (const child of children) rows.push(...docElementTreeRows(editor, comp, child, depth + 1));
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
 * address is its name plus a CHILD-INDEX path into its elements. */
function builtinComponentRows(editor: Editor, comp: Json): HTMLElement[] {
  const name = String(comp?.name ?? "");
  const key = "b:" + name;
  const open = fold.open(key, false);
  const elements = Array.isArray(comp?.children) ? (comp.children as Json[]) : [];
  const current = editor.builtinSel?.name === name && !editor.builtinSel.path;
  const row = treeRow(
    key,
    0,
    "component builtin" + (current ? " current" : ""),
    elements.length ? { open, toggle: () => toggle(editor, key, false) } : null,
    [
      el("span", {
        class: "icon-mark layer-glyph",
        html: iconMarkup(ICONS[name] ? name : "layers", 16, 1.5),
      }),
      el("span", { class: "layer-label", text: name }),
      componentMenuButton(name, () => builtinComponentMenu(editor, name)),
    ],
    () => editor.selectBuiltin(name, ""),
    name + " (built-in, read-only)",
  );
  const rows = [row];
  if (open)
    elements.forEach((element, i) => rows.push(...builtinElementRows(editor, name, String(i), element, 1)));
  return rows;
}

function builtinElementRows(
  editor: Editor,
  comp: string,
  path: string,
  element: Json,
  depth: number,
): HTMLElement[] {
  const name = String(element?.name ?? "");
  const key = "b:" + comp + "/" + path;
  const open = fold.open(key, true);
  const children = Array.isArray(element?.children) ? (element.children as Json[]) : [];
  const glyph = KIND_GLYPH[element?.kind] ?? "·";
  const current = editor.builtinSel?.name === comp && editor.builtinSel.path === path;
  const row = treeRow(
    key,
    depth,
    "element builtin" + (current ? " current" : ""),
    children.length ? { open, toggle: () => toggle(editor, key, true) } : null,
    [el("span", { class: "icon-mark layer-glyph draw", text: glyph }),
     el("span", { class: "layer-label", text: name || "(unnamed)" })],
    () => editor.selectBuiltin(comp, path),
    name + " (" + element?.kind + ", read-only)",
  );
  const rows = [row];
  if (open)
    children.forEach((child, i) =>
      rows.push(...builtinElementRows(editor, comp, path + "." + i, child, depth + 1)));
  return rows;
}
