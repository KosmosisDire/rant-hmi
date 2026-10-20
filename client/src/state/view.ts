// Where this screen stands in the editor: its tab and the page open in Design and Run. The
// browser remembers them, and keeps each move in its history, so its back and forward step
// through what was opened. The page falls back to the first while the chosen one is missing.

import { createSignal } from "solid-js";
import { remembered } from "./remember";
import { page, state } from "./store";

export const TABS = ["data", "design", "logic", "run"] as const;
export type Tab = (typeof TABS)[number];

const KEY = "rant-hmi.page";
const TOP = "rant-hmi.history-top";

function saved(key: string): string {
  try {
    return (key === TOP ? sessionStorage : localStorage).getItem(key) ?? "";
  } catch {
    return "";
  }
}

function keep(key: string, value: string) {
  try {
    (key === TOP ? sessionStorage : localStorage).setItem(key, value);
  } catch {
    // storage is off: the choice lasts until reload
  }
}

/** One move, as the history keeps it: where it went, and its place among the moves. */
interface Spot {
  tab: Tab;
  page: string;
  n: number;
}

const spotOf = (s: unknown) => (s as { hmi?: Spot } | null)?.hmi;

// a reload shows what this tab's own history says it showed, before anything draws
const reloaded = spotOf(window.history.state);
const [tab, setTab] = remembered<Tab>("tab", "data", TABS);
const [chosen, setChosen] = createSignal(saved(KEY));
if (reloaded) show(reloaded);

export const currentTab = tab;

export function currentPage() {
  return page(chosen()) ?? state.pages.find((p) => p.interface === null);
}

// this move's place, and the last one forward of it, which back leaves in the history
const [at, setAt] = createSignal({ n: reloaded?.n ?? 0, top: Math.max(reloaded?.n ?? 0, Number(saved(TOP)) || 0) });

export const canGoBack = () => at().n > 0;
export const canGoForward = () => at().n < at().top;

function show(spot: { tab: Tab; page: string }) {
  setTab(spot.tab);
  setChosen(spot.page);
  keep(KEY, spot.page);
}

function go(to: { tab: Tab; page: string }) {
  if (to.tab === tab() && to.page === chosen()) return;
  show(to);
  const n = at().n + 1;
  setAt({ n, top: n });
  keep(TOP, String(n));
  window.history.pushState({ hmi: { ...to, n } satisfies Spot }, "");
}

export function openTab(t: Tab) {
  go({ tab: t, page: chosen() });
}

/** Opens a page or component, in `t` when given, else on the tab open now. */
export function openPage(id: string, t: Tab = tab()) {
  go({ tab: t, page: id });
}

/** Follows the browser's back and forward from here on. The editor's alone: an operator's
 *  screen keeps its own page stack in the history. */
export function followHistory() {
  if (!reloaded) {
    window.history.replaceState({ hmi: { tab: tab(), page: chosen(), n: 0 } satisfies Spot }, "");
    keep(TOP, "0");
  }
  window.addEventListener("popstate", (e) => {
    const spot = spotOf(e.state);
    if (!spot) return;
    show(spot);
    setAt({ n: spot.n, top: at().top });
  });
}
