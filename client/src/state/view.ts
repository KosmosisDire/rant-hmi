// Where this screen stands in the editor: its tab and the page open in Design and Run. The
// browser remembers them, and keeps each move in its history, so its back and forward step
// through what was opened. The page falls back to the first while the chosen one is missing.

import { createSignal } from "solid-js";
import { remembered } from "./remember";
import { page, state } from "./store";

export const TABS = ["data", "design", "logic", "run"] as const;
export type Tab = (typeof TABS)[number];

const KEY = "rant-hmi.page";

function saved(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function keep(value: string) {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // storage is off: the choice lasts until reload
  }
}

/** One move, as the history keeps it. */
interface Spot {
  tab: Tab;
  page: string;
}

const spotOf = (s: unknown) => (s as { hmi?: Spot } | null)?.hmi;

// a reload shows what this tab's own history says it showed, before anything draws
const reloaded = spotOf(window.history.state);
const [tab, setTab] = remembered<Tab>("tab", "data", TABS);
const [chosen, setChosen] = createSignal(saved());
if (reloaded) show(reloaded);

export const currentTab = tab;

export function currentPage() {
  return page(chosen()) ?? state.pages.find((p) => p.interface === null);
}

function show(spot: Spot) {
  setTab(spot.tab);
  setChosen(spot.page);
  keep(spot.page);
}

function go(to: Spot) {
  if (to.tab === tab() && to.page === chosen()) return;
  show(to);
  window.history.pushState({ hmi: to }, "");
}

export function openTab(t: Tab) {
  go({ tab: t, page: chosen() });
}

/** Opens a page or component, in `t` when given, else on the tab open now. */
export function openPage(id: string, t: Tab = tab()) {
  go({ tab: t, page: id });
}

/** An element Design is asked to show, and its handler to type in, until Design takes it. */
export interface Wanted {
  page: string;
  element: string;
  event?: string;
}

const [wanted, setWanted] = createSignal<Wanted | null>(null);
export { wanted };

/** Opens an element's page in Design with it selected, and the caret in its `event` handler. */
export function openElement(w: Wanted) {
  setWanted(w);
  openPage(w.page, "design");
}

/** Design took what was asked for. */
export const tookWanted = () => setWanted(null);

/** Follows the browser's back and forward from here on. The editor's alone: an operator's
 *  screen keeps its own page stack in the history. */
export function followHistory() {
  if (!reloaded) window.history.replaceState({ hmi: { tab: tab(), page: chosen() } satisfies Spot }, "");
  window.addEventListener("popstate", (e) => {
    const spot = spotOf(e.state);
    if (spot) show(spot);
  });
}
