// Every problem this screen finds, in one list the editor shows: a page's faults while an element
// shows them, and each fault of a run or of the HMI's own code, counted as it comes again.

import { createStore, produce } from "solid-js/store";
import type { Level } from "../protocol/Level";
import type { Problem } from "../protocol/Problem";
import type { Found } from "./caught";
import { notify } from "./store";

/** How many faults of runs and of the HMI are kept, the oldest going first. */
const KEPT = 100;

const [problems, setProblems] = createStore<Problem[]>([]);
export { problems };

/** The same for each time a problem comes again. */
export const keyOf = (p: Found) => [p.source, p.page ?? "", p.element ?? "", p.text].join("\n");

/** How many elements show each page fault now, by its key. */
const shown = new Map<string, number>();

/** Notes that `p` came now, once more when it came before. */
export function report(p: Found) {
  const key = keyOf(p);
  const at = Date.now();
  setProblems(
    produce((all) => {
      const had = all.find((x) => keyOf(x) === key);
      if (had) {
        had.count++;
        had.at = at;
        if (p.detail) had.detail = p.detail;
        return;
      }
      all.push({ ...p, count: 1, at });
      const passed = all.filter((x) => x.source !== "page");
      if (passed.length > KEPT) all.splice(all.indexOf(passed[0]), 1);
    }),
  );
}

/** Lists a page's fault while an element shows it, until the last to show it lets go. */
export function hold(p: Found): () => void {
  const key = keyOf(p);
  const n = shown.get(key) ?? 0;
  shown.set(key, n + 1);
  // appended without reading the list, so the element's effect that holds it never follows it
  if (n === 0) setProblems(produce((all) => void all.push({ ...p, count: 1, at: Date.now() })));
  return () => {
    const left = (shown.get(key) ?? 1) - 1;
    if (left > 0) return void shown.set(key, left);
    shown.delete(key);
    setProblems((all) => all.filter((x) => keyOf(x) !== key));
  };
}

/** Where a handler sits: what names it to the person, and its page or component and element. */
export interface From {
  label: string;
  page: string;
  element: string;
}

/** Tells the person at the screen what stopped a handler's run, and notes it. */
export function ranInto(from: From, text: string, level: Level) {
  notify(`${from.label}: ${text}`, level);
  report({ source: "run", level, text: `${from.label}: ${text}`, detail: null, page: from.page, element: from.element });
}
