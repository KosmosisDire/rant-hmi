// Where the pages and the HMI's own handlers name a datapoint, found from the names in their
// values and code without running them, as the Data screen lists for each.

import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { state } from "./store";
import { bare } from "./uses";

export interface Place {
  /** The page it is on, none for one of the HMI's own handlers. */
  page?: Page;
  element?: Element;
  /** What names it there: a property, an event's handler, a handler's trigger. */
  what: string;
}

/** Every place that names `name`. A component reads only its inputs, so pages alone can. */
export function usedBy(name: string): Place[] {
  const said = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
  const names = (text: string | undefined) => !!text && said.test(bare(text));
  const out: Place[] = [];
  const walk = (page: Page, elements: Element[]) => {
    for (const e of elements) {
      for (const [key, value] of Object.entries(e.props)) if (key !== "name" && names(value)) out.push({ page, element: e, what: key });
      for (const h of e.handlers) if (names(h.code) || Object.values(h.attrs).some(names)) out.push({ page, element: e, what: `${h.event} handler` });
      walk(page, e.children);
    }
  };
  for (const page of state.pages.filter((p) => p.interface === null)) {
    if (names(page.fill)) out.push({ page, what: "fill" });
    walk(page, page.children);
  }
  for (const rule of state.rules) {
    const when = rule.when;
    const trigger = (when.kind === "turns" && names(when.condition)) || (when.kind === "changes" && when.name === name);
    if (trigger || names(rule.code)) out.push({ what: `${rule.name}, ${trigger ? "its trigger" : "its code"}` });
  }
  return out;
}
