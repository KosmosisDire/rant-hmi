// What may be typed next at the caret: names, then after a dot the fields with their type and
// live value. It reads only the text before the caret, so the code need not parse.

import type { FieldInfo } from "../protocol/FieldInfo";
import type { Import } from "../protocol/Import";
import type { Kind } from "../protocol/Kind";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { typeLabel } from "./format";
import { mode } from "./mode";
import { entity, live, state } from "./store";

export interface Suggestion {
  label: string;
  /** What replaces the word being typed. */
  insert: string;
  icon: Kind | "local" | "api" | "member" | "token";
  type?: string;
  value?: JsonValue | null;
  known?: boolean;
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

/** The theme's tokens, which every place but a backend handler reads, in the editor's mode. */
function tokens(): Suggestion[] {
  return state.tokens.map((t) => ({ label: `$${t.name}`, insert: `$${t.name}`, icon: "token", type: "token", value: mode() === "light" ? t.light : t.dark, known: true }));
}

const API: Record<Place, Suggestion[]> = {
  expression: [],
  handler: [
    { label: "notify", insert: "notify(", icon: "api", type: "tell this screen" },
    { label: "log", insert: "log(", icon: "api", type: "write to the log" },
    { label: "sleep", insert: "await sleep(", icon: "api", type: "wait ms" },
    { label: "open", insert: "open(", icon: "api", type: "open a page" },
    { label: "close", insert: "close()", icon: "api", type: "close the top page" },
    { label: "p", insert: "p", icon: "api", type: "what the event brought" },
  ],
  component: [
    { label: "emit", insert: "emit(", icon: "api", type: "send an event out" },
    { label: "p", insert: "p", icon: "api", type: "what the event brought" },
  ],
};

/** The completion at `caret`, or null where none fits, such as inside a string. `names` stand
 *  for the page's datapoints where code reads something else, as a component reads its inputs. */
export function complete(text: string, caret: number, place: Place, names?: Suggestion[]): Completion | null {
  const before = text.slice(0, caret);
  if (inString(before)) return null;
  let from = caret;
  while (from > 0 && WORD.test(before[from - 1])) from--;
  const word = before.slice(from);
  if (/^\d/.test(word)) return null;
  const items = before[from - 1] === "." ? (names ? [] : members(chain(before.slice(0, from - 1)), place)) : [...(names ?? top(place)), ...(place === "handler" ? [] : tokens()), ...API[place]];
  const q = word.toLowerCase();
  const starts = items.filter((s) => s.label.toLowerCase().startsWith(q));
  const inside = items.filter((s) => !s.label.toLowerCase().startsWith(q) && s.label.toLowerCase().includes(q));
  const found = [...starts, ...inside].slice(0, MOST);
  // a word typed out in full needs no list
  if (found.length === 0 || (found.length === 1 && found[0].label === word)) return null;
  return { from, items: found };
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
  return [...imports, ...variables];
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
 *  handler's topic imported to write offers send first. */
function members(path: string[], place: Place): Suggestion[] {
  if (path.length === 0) return [];
  const [root, ...rest] = path;
  const imp = state.imports.find((i) => i.alias === root);
  if (place === "handler" && imp?.kind === "topic" && imp.intent === "write" && rest.length === 0) return [SEND, ...members(path, "expression")];
  let value: JsonValue | null = live(root).value;
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
    if (fields) return fields.map((f) => ({ label: f.name, insert: f.name, icon: "member", type: typeLabel(f), value: at(value, f.name), known }));
    if (field?.kind === "array") return [{ label: "length", insert: "length", icon: "member", type: "number", value: Array.isArray(value) ? value.length : null, known }];
    return methods(value, known);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).map((k) => ({ label: k, insert: k, icon: "member", value: at(value, k), known }));
  }
  return methods(value, known);
}

/** What a plain value offers: a number its format, a list or text its length. */
function methods(value: JsonValue | null, known: boolean): Suggestion[] {
  if (typeof value === "number") return [{ label: "toFixed", insert: "toFixed(1)", icon: "member", type: "digits after the point", value: Number(value.toFixed(1)), known }];
  if (typeof value === "string" || Array.isArray(value)) return [{ label: "length", insert: "length", icon: "member", type: "number", value: value.length, known }];
  return [];
}

function at(v: JsonValue | null, step: string): JsonValue | null {
  if (v === null || typeof v !== "object") return null;
  return Array.isArray(v) ? (v[Number(step)] ?? null) : (v[step] ?? null);
}
