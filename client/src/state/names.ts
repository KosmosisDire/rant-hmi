// What a name in code stands for, one lookup for all who ask: the highlighter, completion, the
// uses list, a page's scope, and the names a new member may not take. A member goes by its key.

import { createMemo, createRoot } from "solid-js";
import type { Import } from "../protocol/Import";
import type { Kind } from "../protocol/Kind";
import type { Object as Thing } from "../protocol/Object";
import { ENUM_FIXED, NO_SETTER, NOT_VARIABLE, READ_ONLY, RECORD, type Shape, TOKEN_FIXED } from "../protocol/rules";
import { state } from "./store";

/** The object every project has, which holds what the HMI as a whole keeps. */
export const HMI = "Hmi";

export interface Named {
  /** As code outside its object writes it: an object, a member's key `Line.Speed`, `$accent`. */
  name: string;
  of: "object" | "import" | "variable" | "computed" | "record" | "function" | "enum" | "token";
  /** An import's Rant kind. */
  kind?: Kind;
  /** What it is in a few words, as the uses list and completion say it. */
  words: string;
  /** Why a page cannot write it, none when it can. */
  fixed?: string;
  /** A variable each screen holds its own of. */
  screen?: boolean;
  /** The object a member is of. */
  object?: string;
  /** A member only its object's own code reads. */
  local?: boolean;
}

/** The key of `object`'s member `member`, as the backend keeps its value. */
export const key = (object: string, member: string) => `${object}.${member}`;

const index = createRoot(() =>
  createMemo(() => {
    const all = new Map<string, Named>();
    const put = (n: Named) => all.has(n.name) || all.set(n.name, n);
    for (const o of state.objects) {
      put({ name: o.name, of: "object", words: o.name === HMI ? "the HMI's own object" : "object" });
      const at = (member: string) => ({ name: key(o.name, member), object: o.name, local: o.local.includes(member) });
      for (const i of o.imports) {
        const k = key(o.name, i.alias);
        const fixed = i.kind !== "variable" ? say(NOT_VARIABLE, k) : i.intent !== "write" ? say(READ_ONLY, k) : undefined;
        put({ ...at(i.alias), of: "import", kind: i.kind, words: `${i.kind}, ${i.intent}`, fixed });
      }
      for (const v of o.variables) put({ ...at(v.name), of: "variable", words: v.per === "screen" ? "variable, per screen" : "variable, shared", screen: v.per === "screen" });
      for (const c of o.computed) put({ ...at(c.name), of: "computed", words: c.unit ? `computed, ${c.unit}` : "computed", fixed: c.set ? undefined : say(NO_SETTER, key(o.name, c.name)) });
      for (const r of o.records) put({ ...at(r.name), of: "record", words: `record of ${r.source}`, fixed: say(RECORD, key(o.name, r.name)) });
      for (const f of o.functions) put({ ...at(f.name), of: "function", words: f.takes.length > 0 ? `function of ${f.takes.join(", ")}` : "function", fixed: say(NOT_VARIABLE, key(o.name, f.name)) });
    }
    for (const e of state.enums) put({ name: e.name, of: "enum", words: "enum", fixed: say(ENUM_FIXED, e.name) });
    for (const t of state.tokens) put({ name: `$${t.name}`, of: "token", words: "token", fixed: say(TOKEN_FIXED, `$${t.name}`) });
    return all;
  }),
);

export const named = (name: string): Named | undefined => index().get(name);

/** Every name of the kinds asked for, objects and their members first, then enums and tokens. */
export const names = (...of: Named["of"][]): Named[] => [...index().values()].filter((n) => of.includes(n.of));

/** An object by its name. */
export const object = (name: string): Thing | undefined => state.objects.find((o) => o.name === name);

/** A mesh member's entity in full: from its object's mesh root, or the mesh's own for `/x`. */
export const entityOf = (o: Thing, path: string) => (path.startsWith("/") ? path.slice(1) : o.mesh ? `${o.mesh}/${path}` : path);

/** Every object's mesh members, each by its key with its entity in full. */
export const imports = createRoot(() => createMemo(() => state.objects.flatMap((o) => o.imports.map((i): Import => ({ ...i, alias: key(o.name, i.alias), entity: entityOf(o, i.entity) })))));

/** A mesh member by its key. */
export const imported = (k: string): Import | undefined => imports().find((i) => i.alias === k);

/** The mesh member that brings an entity, by its path in full. */
export const importOf = (entity: string): Import | undefined => imports().find((i) => i.entity === entity);

/** The members of `object` code reads: its Global ones from outside, all of them in its own. */
export const members = (object: string, own = false): Named[] => names("import", "variable", "computed", "record", "function").filter((n) => n.object === object && (own || !n.local));

/** The key a path of names in code starts at, and the steps after it: `Line.Speed.x` is the key
 *  `Line.Speed` and x. Code of the object `own` names its members bare too, nearer than any
 *  object. Undefined for a path that names no member code there reads. */
export function keyOf(path: readonly string[], own?: string): { key: string; rest: string[] } | undefined {
  const [root, member, ...rest] = path;
  if (own !== undefined && named(key(own, root))) return { key: key(own, root), rest: path.slice(1) };
  const n = member === undefined ? undefined : named(key(root, member));
  return n && n.of !== "object" && (!n.local || n.object === own) ? { key: n.name, rest } : undefined;
}

/** A reason from the rules with the name in it. */
export const say = (why: string, name: string) => why.replaceAll("{name}", name);

/** Whether `name` is spelled as `shape` asks and is none it keeps clear of. */
export const fits = (shape: Shape, name: string) => shape.pattern.test(name) && !shape.except.includes(name);

/** `base`, or it with the first number from 2 that `taken` leaves free. */
export function freeName(base: string, taken: (name: string) => boolean): string {
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}${n}`;
  return name;
}

/** A name none of `object`'s members has yet. */
export const freeMember = (object: string, base: string) => freeName(base, (n) => !!named(key(object, n)));
