// Where the pages and the objects' code name an object or a member, found from the names in
// their values and code without running them, as an inspector lists for each.

import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { paint } from "../ui/highlight";
import { split, state } from "./store";

export interface Place {
  /** The page it is on, none for an object's code. */
  page?: Page;
  element?: Element;
  /** The object whose code names it, none on a page. */
  object?: string;
  /** What names it there: a property, an event's handler, a rule's trigger. */
  what: string;
}

/** The code with strings and comments blanked, so names inside them are never taken. */
function bare(code: string): string {
  return paint(code)
    .map(([text, p]) => (p === "str" || p === "com" ? text.replace(/[^\n]/g, " ") : text))
    .join("");
}

/** A pattern finding `word` as a name of its own in code, not a field of another. */
const said = (word: string) => new RegExp(`(?<![\\w$.])${word.replace(/[$]/g, "\\$").replace(".", "\\s*\\.\\s*")}(?![\\w$])`);

/** Adds each element of `elements` and all they hold whose values or handlers `names` finds,
 *  past those `sees` turns down with all they hold. */
function namedIn(page: Page, elements: Element[], names: (text: string | undefined) => boolean, out: Place[], sees: (e: Element) => boolean = () => true) {
  for (const e of elements.filter(sees)) {
    for (const [key, value] of Object.entries(e.props)) if (key !== "name" && names(value)) out.push({ page, element: e, what: key });
    for (const h of e.handlers) if (names(h.code) || Object.values(h.attrs).some((a) => names(a))) out.push({ page, element: e, what: `${h.event} handler` });
    namedIn(page, e.children, names, out, sees);
  }
}

/** Every place that names `name`: an object, or a member by its key, which its own object's
 *  code names bare too. A component reads only its inputs, so pages alone can. */
export function usedBy(name: string): Place[] {
  const [owner, member] = split(name);
  const outside = said(name);
  const inside = member ? said(member) : outside;
  const out: Place[] = [];
  const names = (text: string | undefined, by = outside) => !!text && by.test(bare(text));
  for (const page of state.pages.filter((p) => p.interface === null)) {
    if (names(page.fill)) out.push({ page, what: "fill" });
    namedIn(page, page.children, names, out);
  }
  for (const o of state.objects) {
    const own = o.name === owner && member !== "";
    const reads = (text: string | undefined) => names(text) || (own && names(text, inside));
    const writes = (target: string) => target === name || (own && target === member);
    for (const c of o.computed) if (reads(c.get) || reads(c.set?.value) || (c.set && writes(c.set.target))) out.push({ object: o.name, what: `${c.name}, computed` });
    for (const r of o.records) if (reads(r.source)) out.push({ object: o.name, what: `${r.name}, its source` });
    for (const f of o.functions) if (reads(f.code)) out.push({ object: o.name, what: `${f.name}, its code` });
    for (const rule of o.logic) {
      const when = rule.when;
      const trigger = (when.kind === "turns" && reads(when.condition)) || (when.kind === "changes" && writes(when.name));
      if (trigger || reads(rule.code)) out.push({ object: o.name, what: `${rule.name}, ${trigger ? "its trigger" : "its code"}` });
    }
  }
  return out;
}

/** Every element that reads the state `name` that `page`, or its element `holder`, keeps: the
 *  holder and all it holds, past those a nearer state of that name hides it from. */
export function stateUsedBy(page: Page, holder: Element | undefined, name: string): Place[] {
  const by = said(name);
  const names = (text: string | undefined) => !!text && by.test(bare(text));
  const out: Place[] = [];
  if (!holder && names(page.fill)) out.push({ page, what: "fill" });
  namedIn(page, holder ? [holder] : page.children, names, out, (e) => e === holder || !e.state.some((v) => v.name === name));
  return out;
}
