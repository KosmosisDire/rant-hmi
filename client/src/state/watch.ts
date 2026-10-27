// What this screen reads of the imports and computed values, which the backend sends it: the
// paths its shown pages read, all of each while the editor's Data tab previews them.

import { getOwner, onCleanup } from "solid-js";
import type { Path } from "../lang/reads.js";
import type { Page } from "../protocol/Page";
import { operator } from "./mode";
import { pathsOf } from "./paths";
import { stack } from "./stack";
import { page, state } from "./store";
import { currentPage, currentTab } from "./view";

/** How many of what is drawn now read each name, and how many of those read it whole: each read
 *  counts until what made it runs again or goes. */
const readers = new Map<string, { all: number; whole: number }>();

/** Counts a read of `name` by what draws now, and calls `changed` when it starts or stops being
 *  read, or read whole. A read outside anything drawn, as a handler's, counts for nothing. */
export function countRead(name: string, whole: boolean, changed: () => void) {
  if (!getOwner()) return;
  let r = readers.get(name);
  if (!r) readers.set(name, (r = { all: 0, whole: 0 }));
  const n = r;
  n.all++;
  if (whole) n.whole++;
  if (n.all === 1 || (whole && n.whole === 1)) changed();
  onCleanup(() => {
    n.all--;
    if (whole) n.whole--;
    if (n.all === 0 && readers.get(name) === n) readers.delete(name);
    if (n.all === 0 || (whole && n.whole === 0)) changed();
  });
}

/** The names something drawn reads whole, sorted, whose lists the main thread needs. */
export function wholeNames(): string[] {
  return [...readers].flatMap(([name, r]) => (r.whole > 0 ? [name] : [])).sort();
}

/** Whether this screen previews every value, as the editor's Data tab does, which the backend
 *  sends its big ones slower for. */
export function previewing(): boolean {
  return !operator && currentTab() === "data";
}

/** The pages this screen shows, or null while it previews every value. */
function shownPages(): (Page | undefined)[] | null {
  if (previewing()) return null;
  const stacked = () => stack().map((o) => page(o.id));
  if (operator) return stacked();
  switch (currentTab()) {
    case "logic":
      return [];
    case "design":
      return [currentPage()];
    default:
      return stacked();
  }
}

/** The paths this screen reads, sorted, or null for all of every name. A name read as the screen
 *  draws that its pages' text does not show comes whole. */
export function watched(): Path[] | null {
  const pages = shownPages();
  if (pages === null) return null;
  const names = new Set([...state.imports.map((i) => i.alias), ...state.computed.map((c) => c.name)]);
  const { paths, all } = pathsOf(pages.filter((p) => p !== undefined));
  if (all) return null;
  const out = paths.filter((p) => names.has(p[0]));
  const seen = new Set(out.map((p) => p[0]));
  for (const n of readers.keys()) if (names.has(n) && !seen.has(n)) out.push([n]);
  return out.sort((a, b) => (a.join(".") < b.join(".") ? -1 : 1));
}

/** The names this screen shows, sorted, or null for every one. */
export function watchedNames(): string[] | null {
  const paths = watched();
  return paths && [...new Set(paths.map((p) => p[0]))].sort();
}
