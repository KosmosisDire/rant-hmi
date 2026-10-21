// What handler code reads and writes, found from its names without running it: what it sets,
// calls, sends, opens and emits, and the mesh imports it only reads. The Logic tab lists these
// and a handler's box sums them up.

import { paint } from "../ui/highlight";
import type { Suggestion } from "./complete";
import { named } from "./names";

export type Verb = "sets" | "calls" | "sends" | "opens" | "emits";

export interface Use {
  name: string;
  /** For a write its verb, for a read what the name is. */
  what: string;
}

export interface Uses {
  reads: Use[];
  writes: (Use & { what: Verb })[];
}

/** The code with strings and comments blanked, so names inside them are never taken. */
export function bare(code: string): string {
  return paint(code)
    .map(([text, p]) => (p === "str" || p === "com" ? text.replace(/[^\n]/g, " ") : text))
    .join("");
}

/** What a name read here is, or undefined for one the HMI does not own. `names` stand for
 *  the mesh imports and variables where code reads something else, as a component does. */
function reading(name: string, names?: Suggestion[]): string | undefined {
  if (names) return names.find((n) => n.label === name)?.type;
  const n = named(name);
  return n && n.of !== "enum" && n.of !== "token" ? n.words : undefined;
}

/** What `code` uses, read with the names completion offers there. */
export function uses(code: string, names?: Suggestion[]): Uses {
  const src = bare(code);
  const writes = new Map<string, Verb>();
  const reads = new Map<string, string>();
  const ROOT = /(?<![\w$.])([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
  for (const m of src.matchAll(ROOT)) {
    const [whole, root, rest] = m;
    const fields = rest.replace(/\s+/g, "");
    const after = src.slice(m.index! + whole.length);
    const what = reading(root, names);
    if (!what) continue;
    if (fields === ".send" && /^\s*\(/.test(after)) writes.set(root, "sends");
    else if (!fields && /^\s*\(/.test(after) && /^(function|task)/.test(what)) writes.set(root, "calls");
    else if (/^\s*(?:[-+*/%]?=(?!=)|\+\+|--)/.test(after) || /(?:\+\+|--)\s*$/.test(src.slice(0, m.index))) writes.set(root + fields, "sets");
    else reads.set(root, what);
  }
  for (const m of src.matchAll(/\bopen\s*\(\s*Pages\s*\.\s*([A-Za-z_$][\w$]*)/g)) writes.set(m[1], "opens");
  for (const m of code.matchAll(/\bemit\s*\(\s*(["'])([\w$]+)\1/g)) writes.set(m[2], "emits");
  return {
    reads: [...reads].map(([name, what]) => ({ name, what })),
    writes: [...writes].map(([name, what]) => ({ name, what })),
  };
}

