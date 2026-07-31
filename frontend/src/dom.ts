/* The whole "framework": element construction, the small set of controls the sidebars are
 * built from, and nothing else. No virtual DOM and no reactivity on purpose: the document
 * lives on the backend, and reconcile.ts pushes each arriving value into the control that
 * already shows it. These constructors stay pure, so a control can be built once and then
 * driven for the rest of its life. */

import { iconMarkup } from "./icons.js";
import { shownValue } from "./reconcile.js";

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

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
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
 * half-typed text would fight other views for the caret (spec 4.2). Escape reverts to the
 * value the reconciler last put in, which is the document's current one; the value the
 * field was built with is only the fallback for an unbound field. */
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
        input.value = shownValue(input) ?? value;
        input.blur();
      }
    },
    onchange: (ev: Event) => commit((ev.target as HTMLInputElement).value),
  }) as HTMLInputElement;
}

/* the textarea form of commitInput, for TEXT VALUES that may hold explicit newlines
 * (a label or button caption): Enter still commits, Shift+Enter breaks the line. One
 * row tall always, so a slot row never changes height; longer content scrolls. */
export function commitTextInput(
  value: string,
  commit: (text: string) => void,
  attrs: Attrs = {},
): HTMLTextAreaElement {
  const node = el("textarea", {
    class: "field",
    rows: "1",
    value,
    ...attrs,
    onkeydown: (ev: KeyboardEvent) => {
      const input = ev.target as HTMLTextAreaElement;
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        input.blur();
      }
      if (ev.key === "Escape") {
        input.value = shownValue(input) ?? value;
        input.blur();
      }
    },
    onchange: (ev: Event) => commit((ev.target as HTMLTextAreaElement).value),
  }) as HTMLTextAreaElement;
  node.spellcheck = false;
  return node;
}

/* Click-drag SCRUBBING on a number field: dragging an UNFOCUSED field slides its value,
 * one `step` per pixel (Shift scrubs at a tenth-step for precision, switchable
 * mid-drag). A plain click still focuses the field for typing: the down edge is
 * suppressed so the drag never turns into text selection, and a click that never moved
 * replays the focus itself. A focused field is left alone, so dragging a caret through
 * the text works as ever. */
function attachScrub(field: HTMLInputElement, commit: (n: number) => void, step: number): void {
  let pointer = -1;
  let start = 0;
  let acc = 0;
  let lastX = 0;
  let travel = 0;
  let moved = false;
  const decimalsOf = (s: number) => (String(s).split(".")[1] ?? "").length;
  field.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || document.activeElement === field) return;
    ev.preventDefault();
    pointer = ev.pointerId;
    start = Number(field.value) || 0;
    acc = 0;
    lastX = ev.clientX;
    travel = 0;
    moved = false;
    field.setPointerCapture(pointer);
  });
  field.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== pointer) return;
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    if (!moved) {
      travel += Math.abs(dx);
      if (travel < 4) return; /* click slop: below it this is still a click */
      moved = true;
    }
    const grain = ev.shiftKey ? step / 10 : step;
    acc += dx * grain;
    const decimals = Math.min(6, decimalsOf(grain));
    const next = Number((start + Math.round(acc / grain) * grain).toFixed(decimals));
    if (String(next) !== field.value) {
      field.value = String(next);
      commit(next);
    }
  });
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    pointer = -1;
    if (!moved) {
      /* the click whose default we swallowed: focus and select for typing */
      field.focus();
      field.select();
    }
  };
  field.addEventListener("pointerup", end);
  field.addEventListener("pointercancel", (ev) => {
    if (ev.pointerId === pointer) pointer = -1;
  });
}

export function numberInput(
  value: number,
  commit: (n: number) => void,
  attrs: Attrs = {},
): HTMLInputElement {
  const field = el("input", {
    class: "field num",
    type: "number",
    value: String(value),
    ...attrs,
    onchange: (ev: Event) => {
      const n = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(n)) commit(n);
    },
  }) as HTMLInputElement;
  attachScrub(field, commit, Number(attrs.step) || 1);
  return field;
}

/* the picker inside a select field's wrapper, for callers that bind its value */
const pickers = new WeakMap<HTMLElement, HTMLSelectElement>();

export function pickerOf(wrap: HTMLElement): HTMLSelectElement {
  return pickers.get(wrap) as HTMLSelectElement;
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
  const wrap = el("span", { class: "select-wrap " + cls }, [
    picker,
    el("span", { class: "caret-mark", html: iconMarkup("chevron-down", 9, 2) }),
  ]);
  pickers.set(wrap, picker as HTMLSelectElement);
  return wrap;
}

export function chip(text: string, cls = "", title = ""): HTMLElement {
  return el("span", { class: "chip " + cls, text, title: title || undefined });
}

/* the content-alignment control: a 3x3 grid picking both axes at once, instead of a
 * nine-entry dropdown nobody can scan. Each button carries the value it stands for, so the
 * selection can be re-pointed without rebuilding the grid. */
const ALIGN_POSITIONS = [
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
];

export function alignGrid(value: string, commit: (v: string) => void): HTMLElement {
  return el(
    "div",
    { class: "align-grid" },
    ALIGN_POSITIONS.map((pos) =>
      el(
        "button",
        {
          class: pos === value ? "on" : "",
          title: pos,
          "data-value": pos,
          onclick: () => commit(pos),
        },
        [el("span", { class: "align-dot" })],
      ),
    ),
  );
}

/* a bool as a two-state pair, matching every other two-state control */
export function boolPair(value: boolean, commit: (v: boolean) => void): HTMLElement {
  const off = el("button", {
    text: "off",
    class: value ? "" : "on",
    "data-value": "off",
    onclick: () => commit(false),
  });
  const on = el("button", {
    text: "on",
    class: value ? "on" : "",
    "data-value": "on",
    onclick: () => commit(true),
  });
  return el("div", { class: "bool-pair" }, [off, on]);
}
