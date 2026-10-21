// What a name in code stands for, one lookup for all who ask: the highlighter, completion, the
// uses list, a page's scope, and the names a new variable may not take.

import { createMemo, createRoot } from "solid-js";
import type { Kind } from "../protocol/Kind";
import { state } from "./store";

export interface Named {
  /** As code writes it: an alias, a name, `$accent`. */
  name: string;
  of: "import" | "variable" | "computed" | "record" | "enum" | "token";
  /** An import's Rant kind. */
  kind?: Kind;
  /** What it is in a few words, as the uses list and completion say it. */
  words: string;
  /** Why a page cannot write it, none when it can. */
  fixed?: string;
}

const index = createRoot(() =>
  createMemo(() => {
    const all = new Map<string, Named>();
    const put = (n: Named) => all.has(n.name) || all.set(n.name, n);
    for (const i of state.imports) {
      const fixed = i.kind === "variable" && i.intent === "write" ? undefined : `${i.alias} cannot be set from here`;
      put({ name: i.alias, of: "import", kind: i.kind, words: `${i.kind}, ${i.intent}`, fixed });
    }
    for (const v of state.variables) put({ name: v.name, of: "variable", words: v.per === "screen" ? "variable, per screen" : "variable, shared" });
    for (const c of state.computed) {
      const fixed = c.set ? undefined : `${c.name} is worked out from other values, and has no setter to write it`;
      put({ name: c.name, of: "computed", words: c.unit ? `computed, ${c.unit}` : "computed", fixed });
    }
    for (const r of state.records) put({ name: r.name, of: "record", words: `record of ${r.source}`, fixed: `${r.name} is a record, which only its source fills` });
    for (const e of state.enums) put({ name: e.name, of: "enum", words: "enum", fixed: `${e.name} is an enum of the mesh's, so it cannot be set` });
    for (const t of state.tokens) put({ name: `$${t.name}`, of: "token", words: "token", fixed: `$${t.name} is the theme's, so it cannot be set` });
    return all;
  }),
);

export const named = (name: string): Named | undefined => index().get(name);

/** Every name of the kinds asked for, imports first, then the HMI's own, enums and tokens. */
export const names = (...of: Named["of"][]): Named[] => [...index().values()].filter((n) => of.includes(n.of));

/** The HMI's own names, which share one space: a variable, a computed value, a record. */
const OWN: Named["of"][] = ["variable", "computed", "record"];

/** `base`, or it with the first number from 2 that `taken` leaves free. */
export function freeName(base: string, taken: (name: string) => boolean): string {
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}${n}`;
  return name;
}

/** A name none of the HMI's own has yet. */
export const freeLocal = (base: string) =>
  freeName(base, (n) => {
    const of = named(n)?.of;
    return !!of && OWN.includes(of);
  });
