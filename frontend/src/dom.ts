/* The whole "framework": element construction, the small set of controls the rails are
 * built from, and nothing else. No virtual DOM and no reactivity on purpose: the document
 * lives on the backend, so a panel re-renders when a version arrives. */

import { iconMarkup } from "./icons.js";

export type Attrs = Record<string, string | number | boolean | ((ev: any) => void) | undefined>;
export type Kids = (Node | string | null)[];

export function el(tag: string, attrs: Attrs = {}, children: Kids = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value as any);
    else if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "value") (node as HTMLInputElement).value = String(value);
    else if (key === "checked") (node as HTMLInputElement).checked = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* A panel is rebuilt wholesale when a version arrives, so the control the user is in has
 * to be found again afterwards. Its address is its position in the tree: the structure is
 * generated from the document, so the same path lands on the same control, and when it
 * does not (the structure changed) the caller simply leaves focus alone. */
export function pathOf(root: Element, node: Element): number[] | null {
  const path: number[] = [];
  let cur: Element | null = node;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return cur === root ? path : null;
}

export function nodeAt(root: Element, path: number[]): Element | null {
  let cur: Element | null = root;
  for (const index of path) {
    if (!cur) return null;
    cur = cur.children[index] ?? null;
  }
  return cur;
}

export function mark(name: string, size = 10, cls = ""): HTMLElement {
  return el("span", { class: cls || "mark", html: iconMarkup(name, size) });
}

export function iconButton(
  name: string,
  title: string,
  onclick: () => void,
  framed = false,
): HTMLElement {
  return el("button", {
    class: "icon-btn" + (framed ? " framed" : ""),
    title,
    html: iconMarkup(name, 11),
    onclick,
  });
}

/* a text input that commits on Enter or blur, never per keystroke: an op stream of
 * half-typed text would fight other views for the caret (spec 4.2) */
export function commitInput(
  value: string,
  commit: (text: string) => void,
  attrs: Attrs = {},
): HTMLInputElement {
  return el("input", {
    class: "field",
    type: "text",
    value,
    ...attrs,
    onkeydown: (ev: KeyboardEvent) => {
      const input = ev.target as HTMLInputElement;
      if (ev.key === "Enter") input.blur();
      if (ev.key === "Escape") {
        input.value = value;
        input.blur();
      }
    },
    onchange: (ev: Event) => commit((ev.target as HTMLInputElement).value),
  }) as HTMLInputElement;
}

export function numberInput(
  value: number,
  commit: (n: number) => void,
  attrs: Attrs = {},
): HTMLInputElement {
  return el("input", {
    class: "field num",
    type: "number",
    value: String(value),
    ...attrs,
    onchange: (ev: Event) => {
      const n = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(n)) commit(n);
    },
  }) as HTMLInputElement;
}

/* a select carries its own caret mark: the native arrow is not part of the language */
export function selectField(
  options: { value: string; label?: string }[],
  value: string,
  commit: (choice: string) => void,
  cls = "",
): HTMLElement {
  const picker = el(
    "select",
    { class: "field", onchange: (ev: Event) => commit((ev.target as HTMLSelectElement).value) },
    options.map((option) =>
      el("option", {
        value: option.value,
        text: option.label ?? option.value,
        selected: option.value === value,
      }),
    ),
  );
  (picker as HTMLSelectElement).value = value;
  return el("span", { class: "select-wrap " + cls }, [
    picker,
    el("span", { class: "caret-mark", html: iconMarkup("chevron-down", 9, 2) }),
  ]);
}

export function chip(text: string, cls = "", title = ""): HTMLElement {
  return el("span", { class: "chip " + cls, text, title: title || undefined });
}

/* a bool as a two-state pair, matching every other two-state control */
export function boolPair(value: boolean, commit: (v: boolean) => void): HTMLElement {
  const off = el("button", { text: "off", class: value ? "" : "on", onclick: () => commit(false) });
  const on = el("button", { text: "on", class: value ? "on" : "", onclick: () => commit(true) });
  return el("div", { class: "bool-pair" }, [off, on]);
}

export function arrow(direction: "left" | "right"): HTMLElement {
  return el("span", {
    class: "arrow",
    html: iconMarkup(direction === "left" ? "arrow-left" : "arrow-right", 10, 1.5),
  });
}
