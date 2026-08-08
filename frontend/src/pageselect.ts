/* The topbar page selector: the one place pages are switched, renamed and added (the
 * left sidebar's Layers tree shows the CURRENT page only). A quiet button naming the
 * current page; clicking opens the shared menu (menu.ts) listing every page with a
 * check on the current one, then an inline rename field for it, then "+ New page".
 * Reconciled like a sidebar: which pages exist is shape, the names are values. */

import { clear, commitInput, el } from "./dom.js";
import { Editor } from "./editor.js";
import { iconMarkup } from "./icons.js";
import { closeMenu, MenuItem, openMenu } from "./menu.js";
import { bindText } from "./reconcile.js";

export function pageSelectShape(editor: Editor): string {
  return JSON.stringify({
    pages: editor.store.pages().map((p) => p.id),
    current: editor.page()?.id ?? 0,
  });
}

export function renderPageSelect(host: HTMLElement, editor: Editor): void {
  clear(host);
  const name = el("span", { class: "name" });
  bindText("pagesel:name", name, () => editor.page()?.name ?? "");
  const button = el("button", { class: "page-select", title: "switch, rename or add pages" }, [
    name,
    el("span", { class: "icon-mark page-caret", html: iconMarkup("chevron-down", 9, 2) }),
  ]);
  button.addEventListener("click", () => openPageMenu(button, editor));
  host.appendChild(button);
}

function openPageMenu(anchor: HTMLElement, editor: Editor): void {
  const current = editor.page();
  const items: MenuItem[] = editor.store.pages().map((page) => ({
    label: page.name,
    icon: page.id === current?.id ? "check" : undefined,
    run: () => editor.setPage(page.id),
  }));
  items.push({ separator: true });
  if (current) {
    /* rename lives IN the menu: an inline commit field over the current page's name */
    const rename = commitInput(
      current.name,
      (text) => {
        if (text && text !== editor.page()?.name)
          editor.apply([{ op: "set_prop", node: current.id, key: "name", value: text }]);
        closeMenu();
      },
      { class: "field grow", placeholder: "page name", title: "rename this page" },
    );
    items.push({ node: el("div", { class: "menu-edit" }, [rename]) });
  }
  items.push({ label: "+ New page", icon: "plus", run: () => editor.addPage() });
  /* the last page always stands: a document with no page has nothing to draw */
  if (current && editor.store.pages().length > 1)
    items.push({
      label: "Remove page",
      icon: "trash",
      danger: true,
      run: () => editor.apply([{ op: "remove", node: current.id }]),
    });
  const at = anchor.getBoundingClientRect();
  openMenu(at.left, at.bottom + 4, "Pages", items);
}
