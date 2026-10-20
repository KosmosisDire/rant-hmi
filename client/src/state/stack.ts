// The pages a screen's Run view has open, bottom first. Handlers open and close them through
// the backend, and Escape closes the top one. In the operator view the browser's history
// follows the stack, so its back button closes too.

import { createSignal } from "solid-js";

const [stack, setStack] = createSignal<string[]>([]);
let history = false;

export { stack };

/** Starts over from one page. */
export function startStack(id: string, withHistory = false) {
  history = withHistory;
  setStack([id]);
  if (history) window.history.replaceState({ depth: 1 }, "");
}

/** Opens a page on top, or in place of the top one. One already open is gone back to, so a
 *  header that opens pages never grows the stack. */
export function push(id: string, replace = false) {
  const s = stack();
  const at = s.indexOf(id);
  if (at >= 0) return back(s.length - 1 - at);
  if (replace && s.length > 0) {
    setStack([...s.slice(0, -1), id]);
    if (history) window.history.replaceState({ depth: s.length }, "");
    return;
  }
  setStack([...s, id]);
  if (history) window.history.pushState({ depth: s.length + 1 }, "");
}

/** Closes the top `n` pages, never the last one. */
export function back(n = 1) {
  const s = stack();
  const k = Math.min(n, s.length - 1);
  if (k <= 0) return;
  if (history) window.history.go(-k);
  else setStack(s.slice(0, s.length - k));
}

window.addEventListener("popstate", (e) => {
  if (!history) return;
  const depth = typeof e.state?.depth === "number" ? e.state.depth : 1;
  setStack((s) => s.slice(0, Math.max(1, depth)));
});
