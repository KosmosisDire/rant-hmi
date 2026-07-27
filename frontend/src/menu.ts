/* The context menu, ported from the old designer: a full-screen dismiss overlay with one
 * popover on it, so any click (or right-click) anywhere closes it and nothing else has to
 * track "is a menu open". Right-click on the desktop, long-press on touch. */

import { el } from "./dom.js";
import { iconMarkup } from "./icons.js";

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  separator?: boolean;
  run?: () => void;
}

let overlay: HTMLElement | null = null;
let popover: HTMLElement | null = null;
/* the pointerup that ends a long-press must not immediately close the menu it opened */
let swallow = false;

function ensure(): void {
  if (overlay) return;
  popover = el("div", { class: "popover" });
  overlay = el("div", { id: "ctx" }, [popover]);
  overlay.addEventListener("click", () => {
    if (swallow) {
      swallow = false;
      return;
    }
    closeMenu();
  });
  overlay.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    closeMenu();
  });
  document.body.appendChild(overlay);
}

export function armSwallow(): void {
  swallow = true;
}

export function openMenu(x: number, y: number, head: string, items: MenuItem[]): void {
  ensure();
  const box = popover as HTMLElement;
  box.innerHTML = "";
  if (head) box.appendChild(el("div", { class: "menu-head", text: head }));
  for (const item of items) {
    if (item.separator) {
      box.appendChild(el("div", { class: "menu-sep" }));
      continue;
    }
    box.appendChild(
      el("button", {
        class: item.danger ? "danger" : "",
        html: (item.icon ? iconMarkup(item.icon, 13, 1.6) : "") + "<span>" + (item.label ?? "") + "</span>",
        onclick: () => {
          closeMenu();
          item.run?.();
        },
      }),
    );
  }
  (overlay as HTMLElement).classList.add("on");
  /* measure, then keep it on screen */
  const width = box.offsetWidth || 180;
  const height = box.offsetHeight || 120;
  box.style.left = Math.min(x, window.innerWidth - width - 8) + "px";
  box.style.top = Math.min(y, window.innerHeight - height - 8) + "px";
}

export function closeMenu(): void {
  overlay?.classList.remove("on");
}

export function menuIsOpen(): boolean {
  return overlay?.classList.contains("on") ?? false;
}
