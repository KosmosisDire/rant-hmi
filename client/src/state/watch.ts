// The imports and computed values this screen shows, which the backend sends it the values of:
// those the pages it shows name in their properties and the conditions their handlers carry,
// and any other something drawn reads now, as an expression may make a name its text does not
// spell. A media element's source is left to what it reads, as one that plays an import's video
// never reads its pictures. Every one while the editor's Data tab previews them, none on its
// Logic tab. A handler's code runs on the system, so what it reads never comes here for it.
// Reads whole are counted apart, as only they need a big value's lists on the main thread.

import { getOwner, onCleanup } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { operator } from "./mode";
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

/** The names this screen shows, sorted, or null for every one. */
export function watched(): string[] | null {
  const pages = shownPages();
  if (pages === null) return null;
  const names = [...state.imports.map((i) => i.alias), ...state.computed.map((c) => c.name)];
  if (names.length === 0) return [];
  const said = new RegExp(`(?<![\\w$.])(${names.map((n) => n.replace(/[$]/g, "\\$")).join("|")})(?![\\w$])`, "g");
  const read = new Set<string>(names.filter((n) => readers.has(n)));
  const scan = (text: string | null | undefined) => {
    if (text) for (const m of text.matchAll(said)) read.add(m[1]);
  };
  const walk = (elements: Element[]) => {
    for (const e of elements) {
      for (const [key, value] of Object.entries(e.props)) if (key !== "name" && !(e.tag === "media" && key === "src")) scan(value);
      for (const h of e.handlers) Object.values(h.attrs).forEach(scan);
      walk(e.children);
    }
  };
  for (const p of pages) {
    if (!p) continue;
    scan(p.fill);
    walk(p.children);
  }
  return [...read].sort();
}
