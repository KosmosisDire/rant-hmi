// The pages a screen's Run view has open, bottom first, kept in the browser's history on /run
// with what each view that navigates shows. A page a handler waits on answers when it closes,
// null when the person closed it.

import { batch, createSignal } from "solid-js";
import type { Value } from "../protocol/Value";

export interface Open {
  id: string;
  /** The handler's wait for what this page closes with. */
  ask: number | null;
}

const [stack, setStack] = createSignal<Open[]>([]);
let history = false;
let answer: (ask: number, value: Value) => void = () => {};

/** What the views that navigate show, which the address module works out. */
export interface Views {
  /** The address of what shows, and the page each view shows by the key of its state. */
  address(): { url: string; views: Record<string, string> };
  /** Shows again what each view showed at a step. */
  show(views: Record<string, string>): void;
  /** Opens a page in the view the page a handler ran on is shown through, false when that
   *  view does not navigate. */
  open(via: string, id: string, replace: boolean): boolean;
}

let views: Views = { address: () => ({ url: location.pathname + location.search, views: {} }), show: () => {}, open: () => false };

/** Who works out what the views show. */
export function onViews(v: Views) {
  views = v;
}

/** A step of the browser's history: how many pages were open, its place among the steps, and
 *  the page each view that navigates showed, by the key of its state. */
interface Step {
  depth: number;
  at: number;
  views: Record<string, string>;
}

/** How many pages were open at each step this screen made, and the step it is at. */
let depths: number[] = [];
let at = 0;

/** Writes what shows now as a new step of the browser's history, or in place of this one. */
export function record(how: "push" | "replace") {
  if (!history) return;
  if (how === "push") depths = [...depths.slice(0, at + 1), stack().length];
  else depths[at] = stack().length;
  if (how === "push") at = depths.length - 1;
  const { url, views: shown } = views.address();
  const step: Step = { depth: stack().length, at, views: shown };
  if (how === "push") window.history.pushState(step, "", url);
  else window.history.replaceState(step, "", url);
}

/** The views as the step this screen is at had them, to tell a change of them from one it
 *  made itself. */
export const recorded = (): Record<string, string> | null => (history ? ((window.history.state as Step | null)?.views ?? null) : null);

export { stack };

/** Who hears what a waited on page closed with. */
export function onAnswer(f: typeof answer) {
  answer = f;
}

/** Opens a page a handler asks for: in the view its page is shown through when that view
 *  navigates, whose opener waits for nothing as it never closes, else as `push` does. */
export function opened(via: string, id: string, full: boolean, replace: boolean, ask: number) {
  if (via && full && views.open(via, id, replace)) answer(ask, null);
  else push(id, replace, ask);
}

/** Starts over from one page. */
export function startStack(id: string, withHistory = false) {
  drop(stack());
  history = withHistory;
  depths = [1];
  at = 0;
  batch(() => {
    setStack([{ id, ask: null }]);
    record("replace");
  });
}

/** Opens a page on top, or in place of the top one. One already open is gone back to, so a
 *  header that opens pages never grows the stack. */
export function push(id: string, replace = false, ask: number | null = null) {
  const s = stack();
  const at = s.findIndex((o) => o.id === id);
  if (at >= 0) {
    // going back closes the page the opener waits from, so its wait ends here, else its
    // handler would run on and drop every later press
    if (ask !== null) answer(ask, null);
    return back(s.length - 1 - at);
  }
  if (replace && s.length > 0) {
    drop(s.slice(-1));
    batch(() => {
      setStack([...s.slice(0, -1), { id, ask }]);
      record("replace");
    });
    return;
  }
  batch(() => {
    setStack([...s, { id, ask }]);
    record("push");
  });
}

/** Closes the top `n` pages, never the last one. Their waits hear nothing. With history it goes
 *  back to the last step with that many open, so what a view changed since is undone too. */
export function back(n = 1) {
  const s = stack();
  const k = Math.min(n, s.length - 1);
  if (k <= 0) return;
  const step = history ? depths.slice(0, at + 1).lastIndexOf(s.length - k) : -1;
  if (step >= 0) return window.history.go(step - at);
  drop(s.slice(s.length - k));
  batch(() => {
    setStack(s.slice(0, s.length - k));
    record("push");
  });
}

/** Undoes the last step, a page opened or a view's change, as the browser's Back does. */
export function undo() {
  if (history && at > 0) window.history.go(-1);
  else back();
}

/** Closes the top page with an answer for whoever waits on it. */
export function closeWith(value: Value) {
  const top = stack().at(-1);
  if (stack().length < 2 || !top) return;
  if (top.ask !== null) answer(top.ask, value);
  setStack((s) => [...s.slice(0, -1), { ...top, ask: null }]);
  back();
}

/** Keeps a page open under its new id when a rename moved it. */
export function follow(from: string, to: string) {
  setStack((s) => s.map((o) => (o.id === from ? { ...o, id: to } : o)));
}

/** Closes the pages that no longer exist, their waits hearing nothing. */
export function prune(exists: (id: string) => boolean) {
  const s = stack();
  if (s.every((o) => exists(o.id))) return;
  drop(s.filter((o) => !exists(o.id)));
  setStack(s.filter((o) => exists(o.id)));
}

/** Answers nothing to the waits of pages that close. */
function drop(closed: Open[]) {
  for (const o of closed) if (o.ask !== null) answer(o.ask, null);
}

window.addEventListener("popstate", (e) => {
  if (!history) return;
  const step = e.state as Partial<Step> | null;
  const depth = Math.max(1, typeof step?.depth === "number" ? step.depth : 1);
  if (typeof step?.at === "number") at = step.at;
  drop(stack().slice(depth));
  batch(() => {
    setStack((s) => s.slice(0, depth));
    if (step?.views) views.show(step.views);
  });
});
