/* The context menu, ported from the old designer: the popover shell's full-screen
 * dismiss overlay with one menu box on it. Right-click on the desktop, long-press on
 * touch. It dismisses on any bubbled click (rows close themselves or stop
 * propagation), which is what lets the swallow flag reopen a submenu from a run(). */

import { el } from "./dom.js";
import { iconMarkup } from "./icons.js";
import { makeShell, Shell } from "./popover.js";

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  separator?: boolean;
  run?: () => void;
  /* a custom row (an inline edit field): appended as-is, and it owns its own clicks */
  node?: HTMLElement;
}

let shell: Shell | null = null;

function ensure(): Shell {
  return (shell ??= makeShell({ id: "ctx", boxClass: "popover", dismiss: "click" }));
}

export function armSwallow(): void {
  ensure().armSwallow();
}

export function openMenu(x: number, y: number, head: string, items: MenuItem[]): void {
  const sh = ensure();
  const box = sh.box;
  box.innerHTML = "";
  if (head) box.appendChild(el("div", { class: "menu-head", text: head }));
  for (const item of items) {
    if (item.separator) {
      box.appendChild(el("div", { class: "menu-sep" }));
      continue;
    }
    if (item.node) {
      /* a click inside the row must not fall through to the dismiss overlay */
      item.node.addEventListener("click", (ev) => ev.stopPropagation());
      box.appendChild(item.node);
      continue;
    }
    box.appendChild(
      el("button", {
        class: "menu-row" + (item.danger ? " danger" : ""),
        html: (item.icon ? iconMarkup(item.icon, 13, 1.6) : "") + "<span>" + (item.label ?? "") + "</span>",
        onclick: () => {
          closeMenu();
          item.run?.();
        },
      }),
    );
  }
  sh.openAt(x, y, { fallbackW: 180, fallbackH: 120 });
}

export function closeMenu(): void {
  shell?.close();
}
