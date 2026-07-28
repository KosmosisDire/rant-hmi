/* What the rails need from the shell, plus the two things every panel shares: the fold
 * state (per view, never synced) and the section header.
 *
 * There is no separate "live" update path any more. A live frame and a document echo are
 * the same event to a rail: the shape is unchanged, so every binding re-reads and assigns.
 * One reconciliation path with two triggers (reconcile.ts). */

import { ViewState } from "./canvas.js";
import { DocStore } from "./doc.js";
import { el } from "./dom.js";
import { iconMarkup } from "./icons.js";
import { Diag, Json, Live, Mesh, Op, Page, Registry, Var, Widget } from "./types.js";

export interface Editor {
  store: DocStore;
  registry: Registry | null;
  live: Live | null;
  /* the reflected mesh (the "dart" root of the source picker); empty when offline */
  mesh: Mesh;
  view: ViewState;
  page(): Page | null;
  selectedWidget(): Widget | null;
  apply(ops: Op[]): void;
  setPage(id: number): void;
  select(ids: number[]): void;
  /* what the compiler said about this widget or anything inside it */
  diagFor(widget: number): Diag[];
  /* the findings pinned to one node, or to one field of it (spec 3.8: a finding sits on
     the row that is wrong). No `where` asks for the node's own findings only. */
  diagAt(node: number, where?: string): Diag[];
  /* re-render the rails: a fold or a menu changed, not the document */
  refresh(): void;
}

/* The inline finding mark: a small icon on the offending row, its popover on hover. The
 * popover is one shared element on the body, so a rail rebuild can never strand it. */
let pop: HTMLElement | null = null;

function showPop(anchor: HTMLElement, diags: Diag[]): void {
  hidePop();
  pop = el(
    "div",
    { class: "diag-pop" },
    diags.map((row) =>
      el("div", { class: "diag-pop-row " + row.grade }, [
        el("span", { class: "grade", text: row.grade }),
        el("span", { class: "message", text: row.message }),
      ]),
    ),
  );
  document.body.appendChild(pop);
  const at = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - box.width - 8));
  const top = at.bottom + box.height + 8 > window.innerHeight ? at.top - box.height - 6 : at.bottom + 6;
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

function hidePop(): void {
  pop?.remove();
  pop = null;
}

export function diagIcon(diags: Diag[]): HTMLElement | null {
  if (!diags.length) return null;
  const worst = diags.some((d) => d.grade === "error")
    ? "error"
    : diags.some((d) => d.grade === "warning")
      ? "warning"
      : "info";
  const dot = el("span", {
    class: "diag-dot " + worst,
    html: iconMarkup("alert", 11, 2),
  });
  dot.addEventListener("mouseenter", () => showPop(dot, diags));
  dot.addEventListener("mouseleave", hidePop);
  return dot;
}

const folded = new Map<string, boolean>();

/* the header is the whole row, the caret rotates rather than swapping glyph, and the state
 * is remembered per section key across selection changes (spec 3.2). Folding is a pure
 * view act: it toggles one style and never asks for a rebuild. */
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
