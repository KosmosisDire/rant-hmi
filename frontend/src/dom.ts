/* The whole "framework": element construction, event binding and a couple of input
 * helpers. There is no virtual DOM and no reactivity here on purpose. The document
 * lives on the backend, so a view re-renders a panel when a version arrives, and that
 * is cheap enough for a document a human authored. */

export type Attrs = Record<string, string | number | boolean | ((ev: any) => void) | undefined>;

export function el(tag: string, attrs: Attrs = {}, children: (Node | string | null)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value as any);
    else if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
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

/* a text input that commits on Enter or blur, never per keystroke: an op stream of
 * half-typed text would fight other views for the caret (spec 4.2) */
export function commitInput(
  value: string,
  commit: (text: string) => void,
  attrs: Attrs = {},
): HTMLInputElement {
  const input = el("input", {
    class: "field",
    type: "text",
    value,
    ...attrs,
    onkeydown: (ev: KeyboardEvent) => {
      if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
      if (ev.key === "Escape") {
        (ev.target as HTMLInputElement).value = value;
        (ev.target as HTMLInputElement).blur();
      }
    },
    onchange: (ev: Event) => commit((ev.target as HTMLInputElement).value),
  }) as HTMLInputElement;
  return input;
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

export function select(
  options: string[],
  value: string,
  commit: (choice: string) => void,
): HTMLElement {
  const node = el(
    "select",
    { class: "field", onchange: (ev: Event) => commit((ev.target as HTMLSelectElement).value) },
    options.map((option) => el("option", { value: option, text: option, selected: option === value })),
  );
  (node as HTMLSelectElement).value = value;
  return node;
}
