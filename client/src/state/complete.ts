// What may be typed next at the caret: names, then after a dot the fields with their type and
// live value. It reads only the text before the caret, so the code need not parse.

import { apiIn } from "../lang/api.js";
import { kind, LIBRARY, METHODS_OF } from "../lang/math.js";
import type { FieldInfo } from "../protocol/FieldInfo";
import type { Import } from "../protocol/Import";
import type { Kind } from "../protocol/Kind";
import type { Page } from "../protocol/Page";
import type { TypeInfo } from "../protocol/TypeInfo";
import type { Value } from "../protocol/Value";
import { partNames, tokenValue } from "./bind";
import { fields, typeLabel } from "./format";
import { entity, live, state } from "./store";

export interface Suggestion {
  label: string;
  /** What replaces the word being typed. */
  insert: string;
  icon: Kind | "local" | "api" | "member" | "token" | "enum";
  type?: string;
  value?: Value | null;
  known?: boolean;
  /** What a dot after it offers, for a name completion knows no schema for. */
  members?: Suggestion[];
}

export interface Completion {
  /** Where the word being typed starts. */
  from: number;
  items: Suggestion[];
}

/** Where code runs: a property's expression reads, a page's handler also acts on the
 *  backend, and a component's handler acts on its own inputs and sends events. */
export type Place = "expression" | "handler" | "component";

const MOST = 12;
const WORD = /[A-Za-z0-9_$]/;

/** The theme's tokens, which every place but a backend handler reads, in the editor's mode,
 *  each with what its value offers after a dot, as a colour's methods. */
function tokens(): Suggestion[] {
  return state.tokens.map((t) => {
    let value: Value | null = null;
    try {
      value = tokenValue(t) as Value;
    } catch {
      // one that cannot be worked out still completes, without a value
    }
    return { label: `$${t.name}`, insert: `$${t.name}`, icon: "token", type: "token", value, known: value !== null, members: mathMethods(value, value !== null) };
  });
}

/** The language's own names in `place`, from the one list of them, a function's typed with
 *  its bracket. */
const own = (place: Place): Suggestion[] => apiIn(place).map((a) => ({ label: a.name, insert: a.insert ?? (a.takes ? `${a.name}(` : a.name), icon: "api", type: a.words }));

/** How each math method is typed in, and what it gives. */
const METHOD_WORDS: Record<string, [string, string]> = {
  length: ["length()", "its length"],
  normalized: ["normalized()", "the same way, of length 1"],
  dot: ["dot(", "the dot product with another"],
  cross: ["cross(", "the cross product with another"],
  distance: ["distance(", "how far to another"],
  lerp: ["lerp(", "toward another by t"],
  equals: ["equals(", "the same, within a hair"],
  rotate: ["rotate(", "a 3D vector turned by it"],
  inverse: ["inverse()", "the way back"],
  euler: ["euler()", "roll, pitch and yaw, in radians"],
  apply: ["apply(", "a point moved by it"],
  lighten: ["lighten(", "toward white by t, 0 to 1"],
  darken: ["darken(", "toward black by t, 0 to 1"],
  alpha: ["alpha(", "with this alpha, 0 to 1"],
  fade: ["fade(", "its alpha times k"],
  mix: ["mix(", "toward another colour by t"],
};

/** What a vector, quaternion or pose offers of the math library after a dot. One taking
 *  nothing shows what it gives now. */
function mathMethods(value: Value | null, known: boolean): Suggestion[] {
  const k = kind(value);
  if (!k) return [];
  const call = LIBRARY.__method as (target: unknown, name: string) => unknown;
  return METHODS_OF[k].map((m): Suggestion => {
    const [insert, type] = METHOD_WORDS[m] ?? [`${m}(`, ""];
    const now = insert.endsWith("()") ? (call(value, m) as Value) : null;
    return { label: m, insert, icon: "member", type, value: now, known: known && now !== null };
  });
}

/** What a repeated element and all inside it read of their copy. */
export const REPEAT: Suggestion[] = [
  { label: "index", insert: "index", icon: "local", type: "the copy, from 0" },
  { label: "item", insert: "item", icon: "local", type: "the copy's item" },
];

/** The completion at `caret`, or null where none fits, such as inside a string. `names` stand
 *  for the mesh imports where code reads something else, as a component reads its own, and
 *  `also` adds to them, as a repeat adds `index` and `item`. */
export function complete(text: string, caret: number, place: Place, names?: Suggestion[], also?: Suggestion[]): Completion | null {
  const before = text.slice(0, caret);
  if (inString(before)) return null;
  let from = caret;
  while (from > 0 && WORD.test(before[from - 1])) from--;
  const word = before.slice(from);
  if (/^\d/.test(word)) return null;
  const items =
    before[from - 1] === "."
      ? given(chain(before.slice(0, from - 1)), place, names, also)
      : [...(names ?? top(place)), ...(also ?? []), ...(place === "handler" ? [] : tokens()), ...own(place)];
  const q = word.toLowerCase();
  const starts = items.filter((s) => s.label.toLowerCase().startsWith(q));
  const inside = items.filter((s) => !s.label.toLowerCase().startsWith(q) && s.label.toLowerCase().includes(q));
  const found = [...starts, ...inside].slice(0, MOST);
  // a word typed out in full needs no list
  if (found.length === 0 || (found.length === 1 && found[0].label === word)) return null;
  return { from, items: found };
}

/** What a call takes, shown while the caret is inside its brackets. */
export interface Signature {
  /** Where the call's name starts. */
  from: number;
  /** The call as typed, such as `CageJog.send`. */
  call: string;
  /** Its values in order, each a name and a type. */
  params: { name: string; type: string }[];
  /** The value the caret is in, from 0. */
  at: number;
  /** The type its values make up, which may go as one value instead. */
  whole?: string;
  /** What a function answers. */
  gives?: string;
  /** Why the values are not known. */
  unknown?: string;
}

/** The call the caret is inside: one of the language's own functions, or in a handler that
 *  reaches the mesh a send or a function import. */
export function signature(text: string, caret: number, place: Place): Signature | null {
  const open = opened(text.slice(0, caret));
  if (!open) return null;
  const head = text.slice(0, open.at).trimEnd();
  const path = chain(head);
  const call = path.join(".");
  const from = head.length - call.length;
  const fn = path.length === 1 ? apiIn(place).find((a) => a.name === path[0] && a.takes) : undefined;
  if (fn?.takes) {
    // the rest of the values all fall to a last `...` one
    const rest = fn.takes.at(-1)?.startsWith("...") ? fn.takes.length - 1 : Infinity;
    return { from, call, params: fn.takes.map((name) => ({ name, type: "" })), at: Math.min(open.commas, rest) };
  }
  if (place !== "handler") return null;
  const imp = state.imports.find((i) => i.alias === path[0]);
  const sends = imp?.kind === "topic" && path.length === 2 && path[1] === "send";
  if (!imp || !(sends || (imp.kind === "function" && path.length === 1))) return null;
  const e = entity(imp.entity);
  if (!e?.schema) return { from, call, params: [], at: open.commas, unknown: `its type is not known while ${imp.entity} is off the mesh` };
  return { from, call, ...takes(e.schema), at: open.commas, gives: sends ? undefined : e.response?.name || (e.response ? typeLabel(e.response.fields[0]) : undefined) };
}

/** A type as values passed one by one: a bare type is one value, a struct its fields. */
function takes(t: TypeInfo): Pick<Signature, "params" | "whole"> {
  const one = bareType(t.fields);
  if (one) return { params: [{ name: "value", type: one }] };
  return { params: t.fields.map((f) => ({ name: f.name, type: typeLabel(f) })), whole: (t.fields.length > 0 && t.name) || undefined };
}

/** The innermost round bracket left open before the end, and how many commas follow it there.
 *  Strings and comments are passed over. */
function opened(before: string): { at: number; commas: number } | null {
  const stack: { ch: string; at: number; commas: number }[] = [];
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < before.length && before[i] !== c) i += before[i] === "\\" ? 2 : 1;
    } else if (c === "/" && before[i + 1] === "/") {
      while (i < before.length && before[i] !== "\n") i++;
    } else if (c === "/" && before[i + 1] === "*") {
      const end = before.indexOf("*/", i + 2);
      i = end < 0 ? before.length : end + 1;
    } else if (c === "(" || c === "[" || c === "{") {
      stack.push({ ch: c, at: i, commas: 0 });
    } else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
    } else if (c === "," && stack.length > 0) {
      stack[stack.length - 1].commas++;
    }
  }
  const top = stack.at(-1);
  return top?.ch === "(" ? { at: top.at, commas: top.commas } : null;
}

/** What a part's pointer state holds. */
const POINTER_STATE: Suggestion[] = [
  { label: "pressed", insert: "pressed", icon: "member", type: "true while pressed" },
  { label: "hovered", insert: "hovered", icon: "member", type: "true while the pointer is over it" },
  { label: "heldFor", insert: "heldFor", icon: "member", type: "ms pressed, 0 while not" },
];

/** What a component's code names: its inputs, its variables and its parts. */
export function componentNames(c: Page): Suggestion[] {
  const i = c.interface;
  return [
    ...(i?.inputs ?? []).map((x): Suggestion => ({ label: x.name, insert: x.name, icon: "local", type: x.bindable ? "two way input" : "input" })),
    ...(i?.variables ?? []).map((x): Suggestion => ({ label: x.name, insert: x.name, icon: "local", type: "variable" })),
    ...partNames(c)
      .filter((n) => !i?.inputs.some((x) => x.name === n) && !i?.variables.some((x) => x.name === n))
      .map((n): Suggestion => ({ label: n, insert: n, icon: "member", type: n === "root" ? "the whole, for the pointer" : "a part, for the pointer", members: POINTER_STATE })),
  ];
}

/** After a dot, what the name before it offers: one given its members, else an import's or
 *  variable's fields where code reads those. */
function given(path: string[], place: Place, names?: Suggestion[], also?: Suggestion[]): Suggestion[] {
  const token = path[0].startsWith("$") && place !== "handler" ? tokens().find((t) => t.label === path[0]) : undefined;
  if (token) return path.length === 1 ? (token.members ?? []) : [];
  const own = [...(names ?? []), ...(also ?? [])].find((n) => n.label === path[0]);
  if (own || names) return path.length === 1 ? (own?.members ?? []) : [];
  return members(path, place);
}

function top(place: Place): Suggestion[] {
  // an expression only reads, so nothing it could call is offered there
  const callable = (i: Import) => i.kind === "function" || i.kind === "task";
  const imports = state.imports.filter((i) => place !== "expression" || !callable(i)).map((i): Suggestion => {
    const v = live(i.alias);
    const t = entity(i.entity)?.schema;
    const insert = i.kind === "function" ? `await ${i.alias}(` : i.alias;
    return { label: i.alias, insert, icon: i.kind, type: t?.name || bareType(t?.fields) || i.kind, value: v.value, known: v.known };
  });
  const variables = state.variables.map((x): Suggestion => {
    const v = live(x.name);
    return { label: x.name, insert: x.name, icon: "local", type: "variable", value: v.value, known: v.known };
  });
  // a record shows its latest value, the list being too long to preview
  const records = state.records.map((r): Suggestion => {
    const list = live(r.name).value;
    const last = Array.isArray(list) ? (list.at(-1) as { v?: Value } | undefined)?.v : undefined;
    return { label: r.name, insert: r.name, icon: "local", type: `record of ${r.source}`, value: last ?? null, known: last !== undefined };
  });
  const computed = state.computed.map((c): Suggestion => {
    const v = live(c.name);
    return { label: c.name, insert: c.name, icon: "local", type: c.unit ? `computed, ${c.unit}` : "computed", value: v.value, known: v.known };
  });
  const enums = state.enums.map((e): Suggestion => ({ label: e.name, insert: e.name, icon: "enum", type: "enum", members: [options(e.options)] }));
  return [...imports, ...variables, ...computed, ...records, ...enums];
}

/** What an enum offers after a dot: its option names, as a list. */
function options(names: string[]): Suggestion {
  return { label: "options", insert: "options", icon: "member", type: "its names, a list", value: [...names], known: true };
}

function bareType(fields: FieldInfo[] | undefined): string | undefined {
  return fields?.length === 1 && fields[0].name === "" ? typeLabel(fields[0]) : undefined;
}

/** True when the text ends inside a string, where names are only text. */
function inString(before: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
  }
  return quote !== null;
}

/** The path a dot follows, read backwards: `Joints.position[2]` gives Joints, position, 2. */
function chain(before: string): string[] {
  const out: string[] = [];
  let i = before.length;
  for (;;) {
    if (before[i - 1] === "]") {
      const open = before.lastIndexOf("[", i - 1);
      const index = before.slice(open + 1, i - 1).trim();
      if (open < 0 || !/^\d+$/.test(index)) return [];
      out.unshift(index);
      i = open;
      continue;
    }
    let j = i;
    while (j > 0 && WORD.test(before[j - 1])) j--;
    if (j === i) return [];
    out.unshift(before.slice(j, i));
    if (before[j - 1] !== ".") return out;
    i = j - 1;
  }
}

const SEND: Suggestion = { label: "send", insert: "send(", icon: "api", type: "publish a message" };

/** A value's fields, from its schema where the root is an import, else from the value. A
 *  handler's topic imported to write offers send first, and one of JavaScript's own, such as
 *  Math, what it holds. */
function members(path: string[], place: Place): Suggestion[] {
  if (path.length === 0) return [];
  const [root, ...rest] = path;
  const kind = state.enums.find((e) => e.name === root);
  if (kind) return rest.length === 0 ? [options(kind.options)] : rest.join() === "options" ? methods([...kind.options], true) : [];
  const imp = state.imports.find((i) => i.alias === root);
  const holds = apiIn(place).find((a) => a.name === root && a.fields);
  if (holds && !imp) return rest.length === 0 ? holds.fields!.map((f): Suggestion => ({ label: f.name, insert: f.name, icon: "member", type: f.words })) : [];
  const standard = apiIn(place).find((a) => a.name === root && a.standard);
  if (standard && !imp && rest.length === 0) return held((globalThis as Record<string, unknown>)[root]);
  if (place === "handler" && imp?.kind === "topic" && imp.intent === "write" && rest.length === 0) return [SEND, ...members(path, "expression")];
  let value: Value | null = live(root).value;
  const known = live(root).known;
  for (const step of rest) value = at(value, step);
  if (imp) {
    let fields: FieldInfo[] | undefined = entity(imp.entity)?.schema?.fields;
    let field: FieldInfo | undefined = fields && bareType(fields) ? fields[0] : undefined;
    if (field) fields = undefined;
    for (const step of rest) {
      if (/^\d+$/.test(step)) {
        if (field?.kind !== "array") return [];
        fields = field.members.length ? field.members : undefined;
        field = field.members.length ? undefined : { ...field, kind: field.elem ?? "unknown", count: 0 };
      } else {
        field = fields?.find((f) => f.name === step);
        if (!field) return [];
        fields = field.kind === "struct" ? field.members : undefined;
      }
    }
    if (fields) return [...fields.map((f): Suggestion => ({ label: f.name, insert: f.name, icon: "member", type: typeLabel(f), value: at(value, f.name), known })), ...mathMethods(value, known)];
    if (field?.kind === "array") return [{ label: "length", insert: "length", icon: "member", type: "number", value: Array.isArray(value) ? value.length : null, known }];
    return methods(value, known);
  }
  const named = fields(value);
  if (named) return [...Object.keys(named).map((k): Suggestion => ({ label: k, insert: k, icon: "member", value: at(value, k), known })), ...mathMethods(value, known)];
  return methods(value, known);
}

/** What a plain value offers: a list or text its length, and every method JavaScript gives its
 *  kind, read from the kind itself so none is left out. A number's format comes first. */
function methods(value: Value | null, known: boolean): Suggestion[] {
  const out: Suggestion[] = [];
  if (typeof value === "number") out.push({ label: "toFixed", insert: "toFixed(1)", icon: "member", type: "digits after the point", value: Number(value.toFixed(1)), known });
  if (typeof value === "string" || Array.isArray(value) || value instanceof Uint8Array) out.push({ label: "length", insert: "length", icon: "member", type: "number", value: value.length, known });
  const proto = typeof value === "number" ? Number.prototype : typeof value === "string" ? String.prototype : typeof value === "boolean" ? Boolean.prototype : Array.isArray(value) ? Array.prototype : value instanceof Uint8Array ? Uint8Array.prototype : null;
  return proto ? [...out, ...held(proto).filter((m) => !out.some((o) => o.label === m.label))] : out;
}

/** What an object holds, read from it: each function, typed with its bracket, then each value. */
function held(o: unknown): Suggestion[] {
  if (o === null || (typeof o !== "object" && typeof o !== "function")) return [];
  const names = Object.getOwnPropertyNames(o).filter((n) => n !== "constructor" && !n.startsWith("_") && /^[A-Za-z]/.test(n));
  const value = (n: string) => Object.getOwnPropertyDescriptor(o, n)?.value;
  const calls = names.filter((n) => typeof value(n) === "function").sort();
  const values = names.filter((n) => typeof value(n) === "number" || typeof value(n) === "string").sort();
  return [
    ...calls.map((n): Suggestion => ({ label: n, insert: `${n}(`, icon: "member", type: "" })),
    ...values.map((n): Suggestion => ({ label: n, insert: n, icon: "member", type: typeof value(n), value: value(n) as Value, known: true })),
  ];
}

function at(v: Value | null, step: string): Value | null {
  if (Array.isArray(v) || v instanceof Uint8Array) return v[Number(step)] ?? null;
  return fields(v)?.[step] ?? null;
}
