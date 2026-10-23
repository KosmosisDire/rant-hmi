// The pages a screen's Run view has open, bottom first, kept in the browser's history on /run.
// A page a handler waits on answers when it closes, null when the person closed it.

import { createSignal } from "solid-js";
import type { Value } from "../protocol/Value";

export interface Open {
  id: string;
  /** The handler's wait for what this page closes with. */
  ask: number | null;
}

const [stack, setStack] = createSignal<Open[]>([]);
let history = false;
let answer: (ask: number, value: Value) => void = () => {};

export { stack };

/** Who hears what a waited on page closed with. */
export function onAnswer(f: typeof answer) {
  answer = f;
}

/** Starts over from one page. */
export function startStack(id: string, withHistory = false) {
  drop(stack());
  history = withHistory;
  setStack([{ id, ask: null }]);
  if (history) window.history.replaceState({ depth: 1 }, "");
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
    setStack([...s.slice(0, -1), { id, ask }]);
    if (history) window.history.replaceState({ depth: s.length }, "");
    return;
  }
  setStack([...s, { id, ask }]);
  if (history) window.history.pushState({ depth: s.length + 1 }, "");
}

/** Closes the top `n` pages, never the last one. Their waits hear nothing. */
export function back(n = 1) {
  const s = stack();
  const k = Math.min(n, s.length - 1);
  if (k <= 0) return;
  if (history) return window.history.go(-k);
  drop(s.slice(s.length - k));
  setStack(s.slice(0, s.length - k));
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
  const depth = Math.max(1, typeof e.state?.depth === "number" ? e.state.depth : 1);
  drop(stack().slice(depth));
  setStack((s) => s.slice(0, depth));
});
