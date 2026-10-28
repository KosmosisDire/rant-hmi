// What this screen reads of the mesh members and computed values, which the backend sends it: the
// paths its shown pages read, or while the editor's Data tab previews them, each as the HMI
// brings it and the field the tab peeks at.

import { createMemo, createRoot, createSignal, getOwner, onCleanup } from "solid-js";
import type { Path } from "../lang/reads.js";
import type { Page } from "../protocol/Page";
import { operator } from "./mode";
import { pathsOf } from "./paths";
import { stack } from "./stack";
import { names } from "./names";
import { page } from "./store";
import { boardPages, currentTab } from "./view";

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
 *  sends as the HMI brings it, its big ones slower. */
export function previewing(): boolean {
  return !operator && currentTab() === "data";
}

/** The field the Data tab peeks at, a path from its import's name, which comes while it does
 *  though nothing else reads it. */
export const [peeked, peek] = createSignal<Path | null>(null);

/** The pages this screen shows. */
function shownPages(): (Page | undefined)[] {
  const stacked = () => stack().map((o) => page(o.id));
  if (operator) return stacked();
  switch (currentTab()) {
    case "logic":
      return [];
    case "design":
      return boardPages().map(page);
    default:
      return stacked();
  }
}

/** What the shown pages read, worked out again only as they or their reads change, since every
 *  value drawn asks for it. */
const shownPaths = createRoot(() => createMemo(() => pathsOf(shownPages().filter((p) => p !== undefined))));

/** The paths this screen reads, sorted, or null for all of every name. A name read as the screen
 *  draws that its pages' text does not show comes whole. */
export function watched(): Path[] | null {
  if (previewing()) {
    const p = peeked();
    return p ? [p] : [];
  }
  const sent = new Set(names("import", "computed").map((n) => n.name));
  const { paths, all } = shownPaths();
  if (all) return null;
  const out = paths.filter((p) => sent.has(p[0]));
  const seen = new Set(out.map((p) => p[0]));
  for (const n of readers.keys()) if (sent.has(n) && !seen.has(n)) out.push([n]);
  return out.sort((a, b) => (a.join(".") < b.join(".") ? -1 : 1));
}

/** The names this screen shows, sorted, or null for every one. */
export function watchedNames(): string[] | null {
  if (previewing()) return null;
  const paths = watched();
  return paths && [...new Set(paths.map((p) => p[0]))].sort();
}
