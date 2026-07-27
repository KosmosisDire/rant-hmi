/* What the rails need from the shell, plus the two things every panel shares: the fold
 * state (per view, never synced) and the section header. */

import { ViewState } from "./canvas.js";
import { DocStore } from "./doc.js";
import { el } from "./dom.js";
import { iconMarkup } from "./icons.js";
import { Json, Live, Op, Page, Registry, Var, Widget } from "./types.js";

export interface Editor {
  store: DocStore;
  registry: Registry | null;
  live: Live | null;
  view: ViewState;
  page(): Page | null;
  selectedWidget(): Widget | null;
  apply(ops: Op[]): void;
  setPage(id: number): void;
  select(ids: number[]): void;
  /* re-render the rails: a fold or a menu changed, not the document */
  refresh(): void;
}

const folded = new Map<string, boolean>();

/* the header is the whole row, the caret rotates rather than swapping glyph, and the state
 * is remembered per section key across selection changes (spec 3.2) */
export function section(
  key: string,
  title: string,
  badge: string | null,
  body: () => (HTMLElement | null)[],
): HTMLElement[] {
  const open = !folded.get(key);
  const panel = el(
    "div",
    { class: "section-body" },
    body().filter(Boolean) as HTMLElement[],
  );
  if (!open) panel.style.display = "none";
  const head = el("button", { class: "section-head" }, [
    el("span", { class: "caret", html: iconMarkup("chevron-down", 10, 2) }),
    el("span", { class: "section-title", text: title }),
    badge !== null ? el("span", { class: "badge", text: badge }) : null,
    el("span", { class: "rule" }),
  ]);
  if (open) head.classList.add("open");
  head.addEventListener("click", () => {
    const opening = panel.style.display === "none";
    panel.style.display = opening ? "" : "none";
    head.classList.toggle("open", opening);
    folded.set(key, !opening);
  });
  return [head, panel];
}

/* a live value, or the UNKNOWN mark: never a fabricated number */
export function liveText(live: Live | null, cell: string): string {
  const value = live?.values?.[cell];
  if (value === undefined || value === null) return "--";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  return String(value);
}

export function liveIsOn(live: Live | null, cell: string): boolean {
  const value = live?.values?.[cell];
  if (value === true) return true;
  return typeof value === "object" && value !== null && (value as Json).running === true;
}

/* every variable a widget's flows can name: its own locals shadow the globals */
export function variablesInScope(editor: Editor, widget: Widget | null): Var[] {
  const locals = widget?.locals ?? [];
  const shadowed = new Set(locals.map((v) => v.name));
  return locals.concat(editor.store.globals().filter((v) => !shadowed.has(v.name)));
}
