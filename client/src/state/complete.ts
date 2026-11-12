// What may be typed next at the caret: names, then after a dot the fields with their type and
// live value. It reads only the text before the caret, so the code need not parse.

import { API, apiIn, type Place } from "../lang/api.js";
import { tokens as lex } from "../lang/lex";
import { LIBRARY, methodsOf } from "../lang/math.js";
import type { FieldInfo } from "../protocol/FieldInfo";
import type { Kind } from "../protocol/Kind";
import type { Page } from "../protocol/Page";
import type { TypeInfo } from "../protocol/TypeInfo";
import type { Value } from "../protocol/Value";
import { partNames, tokenValue } from "./bind";
import { chain as path } from "./elements";
import { bareType, fields, typeLabel } from "./format";
import { imported, key, keyOf, members, type Named, named, names, object } from "./names";
import { entity, live, split, state } from "./store";
import { KIND_WORDS, typesIn } from "./types";

export interface Suggestion {
  label: string;
  /** What replaces the word being typed. */
  insert: string;
  icon: Kind | "local" | "api" | "member" | "token" | "enum" | "object";
  type?: string;
  value?: Value | null;
  known?: boolean;
  /** What a method gives now, worked out only once its row is the chosen one. */
  preview?: () => { value: Value | null; known: boolean };
  /** What a dot after it offers, for a name completion knows no schema for. */
  members?: Suggestion[];
  /** The page and element, none for the page, that keep it, for state. */
  defined?: { page: string; holder: string | null };
}

export interface Completion {
  /** Where the word being typed starts. */
  from: number;
  items: Suggestion[];
}

const MOST = 12;
const WORD = /[A-Za-z0-9_$]/;

/** The places that read the theme's tokens: all code a screen works out. */
const THEMED: Place[] = ["expression", "theme", "component"];

/** The theme's tokens, in the editor's mode, each with what its value offers after a dot, as a
 *  colour's methods. */
function tokens(): Suggestion[] {
  return state.tokens.map((t) => {
    const value = tokenNow(t);
    return { label: `$${t.name}`, insert: `$${t.name}`, icon: "token", type: "token", value, known: value !== null, members: mathMethods(value, value !== null) };
  });
}

/** A token's value in the editor's mode, null where it cannot be worked out. */
function tokenNow(t: (typeof state.tokens)[number]): Value | null {
  try {
    return tokenValue(t) as Value;
  } catch {
    return null;
  }
}

/** The language's own names in `place`, from the one list of them, a function's typed with
 *  its bracket. */
const api = (place: Place): Suggestion[] => apiIn(place).map((a) => ({ label: a.name, insert: a.insert ?? (a.takes ? `${a.name}(` : a.name), icon: "api", type: a.words }));

/** Rant Math's calls in the order of its table, so a method finds its call by index. */
const MATH_CALLS = API.find((a) => a.name === "math")?.fields ?? [];

/** What a colour's methods take, and what they give. */
const COLOUR_WORDS: Record<string, [string[], string]> = {
  lighten: [["t"], "toward white by t, 0 to 1"],
  darken: [["t"], "toward black by t, 0 to 1"],
  alpha: [["a"], "with this alpha, 0 to 1"],
  fade: [["k"], "its alpha times k"],
  mix: [["other", "t?"], "toward another colour by t"],
};

/** The methods `value` takes after a dot, each with what it takes besides the value and what it
 *  gives: a standard type's from Rant Math's call, a colour's from here. */
function methodsWith(value: unknown): { name: string; takes: string[]; words: string }[] {
  return methodsOf(value).map(({ name, function: f, self }) => {
    if (f === undefined) return { name, takes: COLOUR_WORDS[name][0], words: COLOUR_WORDS[name][1] };
    const c = MATH_CALLS[f];
    return { name, takes: (c.takes ?? []).filter((_, i) => i !== self), words: c.words };
  });
}

/** True for a value of fixed size, with no list in it, which a method taking only it works out
 *  at once. A point cloud or an image could take long. */
const fixed = (v: unknown): boolean => !Array.isArray(v) && !ArrayBuffer.isView(v) && (typeof v !== "object" || v === null || Object.values(v).every(fixed));

/** What a standard type's value or a colour offers of the math library after a dot. One taking
 *  nothing can preview what it gives, where the value is small. */
function mathMethods(value: Value | null, known: boolean): Suggestion[] {
  const call = LIBRARY.__method as (target: unknown, name: string) => Value;
  const small = fixed(value);
  return methodsWith(value).map((m): Suggestion => {
    const preview = () => {
      try {
        const now = call(value, m.name);
        return { value: now, known: known && now !== null };
      } catch {
        // one that cannot answer for this value, as a singular matrix's inverse, shows none
        return { value: null, known: false };
      }
    };
    return { label: m.name, insert: m.takes.length === 0 ? `${m.name}()` : `${m.name}(`, icon: "member", type: m.words, preview: m.takes.length === 0 && small ? preview : undefined };
  });
}

/** The state code on the element `id` reads, or on the page for none, nearest first: what it
 *  keeps, what holds it keeps, then the page's, each name once. */
export function stateNames(page: Page, id: string | null): Suggestion[] {
  const holders = [...(id === null ? [] : (path(page.children, id) ?? [])).reverse().map((e) => ({ by: e.props.name ?? e.id, holder: e.id as string | null, kept: e.state })), { by: page.name, holder: null, kept: page.state }];
  const out: Suggestion[] = [];
  for (const { by, holder, kept } of holders) {
    for (const v of kept) if (!out.some((o) => o.label === v.name)) out.push({ label: v.name, insert: v.name, icon: "local", type: `${by} keeps it`, value: v.start, known: true, defined: { page: page.id, holder } });
  }
  return out;
}

/** What a repeated element and all inside it read of their copy. */
export const REPEAT: Suggestion[] = [
  { label: "index", insert: "index", icon: "local", type: "the copy, from 0" },
  { label: "item", insert: "item", icon: "local", type: "the copy's item" },
];

/** What a canvas's draw code reads of the canvas: its context, by the name tutorials use for
 *  it, with the context's own after a dot, its size and what the code keeps. */
export function drawing(context: "2d" | "webgl2"): Suggestion[] {
  const [name, of] = context === "2d" ? ["ctx", globalThis.CanvasRenderingContext2D] : ["gl", globalThis.WebGL2RenderingContext];
  // its methods and constants, then the properties it reads or sets through accessors
  const properties = Object.entries(Object.getOwnPropertyDescriptors(of?.prototype ?? {}))
    .filter(([n, d]) => d.get && /^[a-z]/.test(n))
    .map(([n]): Suggestion => ({ label: n, insert: n, icon: "member", type: "" }));
  return [
    { label: name, insert: name, icon: "local", type: `the ${context} context`, members: [...held(of?.prototype), ...properties] },
    { label: "width", insert: "width", icon: "local", type: "its width in units" },
    { label: "height", insert: "height", icon: "local", type: "its height in units" },
    { label: "keep", insert: "keep", icon: "local", type: "what it makes once, kept between draws" },
  ];
}

/** The completion at `caret`, or null where none fits, such as inside a string. `names` stand
 *  for the objects where code reads something else, as a component reads its own, and `also`
 *  comes before them, the nearest names, as a repeat's `index` and `item`. Code of the object
 *  `own` reads its members bare too. */
export function complete(text: string, caret: number, place: Place, names?: Suggestion[], also?: Suggestion[], own?: string): Completion | null {
  const before = text.slice(0, caret);
  if (inWords(before)) return null;
  let from = caret;
  while (from > 0 && WORD.test(before[from - 1])) from--;
  const word = before.slice(from);
  if (/^\d/.test(word)) return null;
  // a nearer name hides one further out, which is not offered
  const near = also ?? [];
  const far = (names ?? top(place, own)).filter((n) => !near.some((a) => a.label === n.label));
  const items = before[from - 1] === "." ? given(chain(before.slice(0, from - 1)), place, names, also, own) : [...near, ...far, ...(THEMED.includes(place) ? tokens() : []), ...api(place)];
  return matching(items, word, from);
}

/** The items that start with the word, then those that hold it, or null where none fits or
 *  the word is typed out in full. */
function matching(items: Suggestion[], word: string, from: number): Completion | null {
  const q = word.toLowerCase();
  const starts = items.filter((s) => s.label.toLowerCase().startsWith(q));
  const inside = items.filter((s) => !s.label.toLowerCase().startsWith(q) && s.label.toLowerCase().includes(q));
  const found = [...starts, ...inside].slice(0, MOST);
  if (found.length === 0 || (found.length === 1 && found[0].label === word)) return null;
  return { from, items: found };
}

let cssNames: Suggestion[] | undefined;

/** Every CSS property this browser knows, read from it, without the vendors' own. */
function cssProperties(): Suggestion[] {
  cssNames ??= [...getComputedStyle(document.documentElement)]
    .filter((n) => !n.startsWith("-"))
    .sort()
    .map((n) => ({ label: n, insert: `${n}: `, icon: "member", type: "CSS" }));
  return cssNames;
}

/** Where the caret stands in a box of CSS lines, `key: value`: in a key, or in a value's
 *  expression, which starts at `at`. */
function cssSpot(text: string, caret: number): { key: true; start: number } | { key: false; at: number } {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const colon = text.indexOf(":", start);
  const end = text.indexOf("\n", start);
  return colon < 0 || colon >= caret || (end >= 0 && colon > end) ? { key: true, start } : { key: false, at: colon + 1 };
}

/** The completion in a box of CSS lines: a property before a line's colon, after it what an
 *  expression reads, the theme's tokens among them. */
export function completeCss(text: string, caret: number, names?: Suggestion[], also?: Suggestion[]): Completion | null {
  const spot = cssSpot(text, caret);
  if (!spot.key) {
    const c = complete(text.slice(spot.at, caret), caret - spot.at, "expression", names, also);
    return c && { from: c.from + spot.at, items: c.items };
  }
  let from = caret;
  while (from > spot.start && /[A-Za-z-]/.test(text[from - 1])) from--;
  return matching(cssProperties(), text.slice(from, caret), from);
}

/** The completion in an input's list of types: the kind words, then each type the mesh names. */
export function completeType(text: string, caret: number): Completion | null {
  let from = caret;
  while (from > 0 && /\w/.test(text[from - 1])) from--;
  const kinds = KIND_WORDS.map(([w, words]): Suggestion => ({ label: w, insert: w, icon: "member", type: words }));
  const named = [...new Set(state.entities.flatMap((e) => (e.schema ? typesIn(e.schema) : [])))].sort();
  return matching([...kinds, ...named.map((n): Suggestion => ({ label: n, insert: n, icon: "member", type: "a type on the mesh" }))], text.slice(from, caret), from);
}

/** The call the caret is inside, in a CSS line's value. */
export function signatureCss(text: string, caret: number): Signature | null {
  const spot = cssSpot(text, caret);
  if (spot.key) return null;
  const s = signature(text.slice(spot.at, caret), caret - spot.at, "expression");
  return s && { ...s, from: s.from + spot.at };
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
  /** What a function or task answers. */
  gives?: string;
  /** Why the values are not known. */
  unknown?: string;
}

/** The call the caret is inside: one of the language's own functions, or in a handler a call
 *  of an object's function, or a send or a function or task import. */
export function signature(text: string, caret: number, place: Place, own?: string): Signature | null {
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
  // a call one of the language's names holds, as math.poseInverse, or a method of a value
  const held = path.length === 2 ? apiIn(place).find((a) => a.name === path[0])?.fields?.find((f) => f.name === path[1]) : undefined;
  const method = path.length > 1 && !held ? methodsWith(valueAt(path.slice(0, -1), place, own)).find((m) => m.name === path.at(-1)) : undefined;
  const values = held?.takes ?? method?.takes;
  if (values) return { from, call, params: values.map((name) => ({ name, type: "" })), at: open.commas };
  if (place !== "handler") return null;
  const to = keyOf(path, own);
  if (to && to.rest.length === 0 && named(to.key)?.of === "function") {
    const [o, name] = split(to.key);
    const f = object(o)?.functions.find((x) => x.name === name);
    return { from, call, params: (f?.takes ?? []).map((name) => ({ name, type: "" })), at: open.commas };
  }
  const imp = to && imported(to.key);
  if (!to || !imp) return null;
  const sends = imp.kind === "topic" && to.rest.length === 1 && to.rest[0] === "send";
  const calls = (imp.kind === "function" || imp.kind === "task") && to.rest.length === 0;
  if (!(sends || calls)) return null;
  const e = entity(imp.entity);
  if (!e || (sends && !e.schema)) return { from, call, params: [], at: open.commas, unknown: `its type is not known while ${imp.entity} is off the mesh` };
  // an untyped call takes nothing, and a task's last value takes each progress update
  const { params, whole } = e.schema ? takes(e.schema) : { params: [], whole: undefined };
  const progress = imp.kind === "task" ? [{ name: "progress", type: `(${e.progress ? `p: ${typeName(e.progress)}` : ""}) => ...` }] : [];
  return { from, call, params: [...params, ...progress], whole, at: open.commas, gives: sends || !e.response ? undefined : typeName(e.response) };
}

/** A type by its name, or a bare type by its one field's. */
function typeName(t: TypeInfo): string {
  return t.name || typeLabel(t.fields[0]);
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
  for (const t of lex(before).filter((t) => t.kind === "mark")) {
    const c = before[t.start];
    if ("([{".includes(c)) stack.push({ ch: c, at: t.start, commas: 0 });
    else if (")]}".includes(c)) stack.pop();
    else if (c === "," && stack.length > 0) stack[stack.length - 1].commas++;
  }
  const top = stack.at(-1);
  return top?.ch === "(" ? { at: top.at, commas: top.commas } : null;
}

/** What a part's pointer state holds. */
const POINTER_STATE: Suggestion[] = [
  { label: "pressed", insert: "pressed", icon: "member", type: "true while pressed" },
  { label: "hovered", insert: "hovered", icon: "member", type: "true while the pointer is over it" },
  { label: "heldFor", insert: "heldFor", icon: "member", type: "ms pressed on it, 0 once the press leaves" },
];

/** What a component's code names besides its state: its inputs and its parts. */
export function componentNames(c: Page): Suggestion[] {
  const i = c.interface;
  return [
    ...(i?.inputs ?? []).map((x): Suggestion => ({ label: x.name, insert: x.name, icon: "local", type: x.bindable ? "two way input" : "input" })),
    ...partNames(c)
      .filter((n) => !i?.inputs.some((x) => x.name === n) && !c.state.some((x) => x.name === n))
      .map((n): Suggestion => ({ label: n, insert: n, icon: "member", type: n === "root" ? "the whole, for the pointer" : "a part, for the pointer", members: POINTER_STATE })),
  ];
}

/** After a dot, what the name before it offers: one given its members, else an object's
 *  members or a member's fields where code reads those. */
function given(path: string[], place: Place, names?: Suggestion[], also?: Suggestion[], own?: string): Suggestion[] {
  const token = path[0].startsWith("$") && THEMED.includes(place) ? tokens().find((t) => t.label === path[0]) : undefined;
  if (token) return path.length === 1 ? (token.members ?? []) : [];
  const near = [...(also ?? []), ...(names ?? [])].find((n) => n.label === path[0]);
  if (near) return path.length === 1 ? (near.members ?? []) : [];
  // the language's names read in every place, the mesh's only where code names nothing else
  return language(path, place) ?? (names ? [] : after(path, place, own));
}

/** What one of the language's own names offers after a dot: the fields of a value it lists,
 *  or what one of JavaScript's own holds. Undefined for any other name. */
function language(path: string[], place: Place): Suggestion[] | undefined {
  const a = apiIn(place).find((x) => x.name === path[0] && (x.fields || x.standard));
  if (!a) return undefined;
  if (path.length > 1) return [];
  return a.fields ? a.fields.map((f): Suggestion => ({ label: f.name, insert: f.takes ? `${f.name}(` : f.name, icon: f.takes ? "api" : "member", type: f.words })) : held((globalThis as Record<string, unknown>)[a.name]);
}

/** What code may name first: its own object's members bare, then each object, then the enums. */
function top(place: Place, own?: string): Suggestion[] {
  const mine = own === undefined ? [] : members(own, true).flatMap((n) => member(n, place, true));
  const objects = names("object")
    .filter((n) => !mine.some((m) => m.label === n.name))
    .map((n): Suggestion => ({ label: n.name, insert: n.name, icon: "object", type: n.words }));
  const enums = names("enum").map((n): Suggestion => ({ label: n.name, insert: n.name, icon: "enum", type: n.words, members: [options(state.enums.find((e) => e.name === n.name)?.options ?? [])] }));
  return [...mine, ...objects, ...enums];
}

/** A member as completion offers it: bare in its own object's code, where a call is awaited,
 *  else after its object's name and a dot. */
function member(n: Named, place: Place, bare: boolean): Suggestion[] {
  const label = split(n.name)[1];
  const calls = n.of === "function" || n.kind === "function" || n.kind === "task";
  // only a handler calls, so nothing it could call is offered elsewhere
  if (calls && place !== "handler") return [];
  const v = live(n.name);
  switch (n.of) {
    case "function":
      return [{ label, insert: bare ? `await ${label}(` : `${label}(`, icon: "function", type: n.words }];
    case "import": {
      const t = entity(imported(n.name)?.entity ?? "")?.schema;
      const insert = calls ? (bare ? `await ${label}(` : `${label}(`) : label;
      return [{ label, insert, icon: n.kind!, type: t?.name || bareType(t?.fields) || n.kind, value: v.value, known: v.known }];
    }
    case "record": {
      // a record shows its latest value, the list being too long to preview
      const last = Array.isArray(v.value) ? (v.value.at(-1) as { v?: Value } | undefined)?.v : undefined;
      return [{ label, insert: label, icon: "local", type: n.words, value: last ?? null, known: last !== undefined }];
    }
    default:
      return [{ label, insert: label, icon: "local", type: n.words, value: v.value, known: v.known }];
  }
}

/** What an enum offers after a dot: its option names, as a list. */
function options(names: string[]): Suggestion {
  return { label: "options", insert: "options", icon: "member", type: "its names, a list", value: [...names], known: true };
}

/** True when the text ends inside a string or a comment, where names are only words. */
function inWords(before: string): boolean {
  const last = lex(before).at(-1);
  return !!last && (last.kind === "text" || last.kind === "comment") && last.open;
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
const CANCEL: Suggestion = { label: "cancel", insert: "cancel()", icon: "api", type: "stop every call of it" };

/** What a path offers after a dot: an object its members, a member its fields, from its schema
 *  where it is an import, else from the value. A handler's topic imported to write offers send
 *  first, a task its cancel. */
function after(path: string[], place: Place, own?: string): Suggestion[] {
  if (path.length === 0) return [];
  const whole = path.length === 1 && named(path[0])?.of === "object" && !(own !== undefined && named(key(own, path[0])));
  if (whole) return members(path[0], path[0] === own).flatMap((n) => member(n, place, false));
  const to = keyOf(path, own);
  if (!to) {
    const kind = state.enums.find((e) => e.name === path[0]);
    if (!kind) return [];
    const rest = path.slice(1);
    return rest.length === 0 ? [options(kind.options)] : rest.join() === "options" ? methods([...kind.options], true) : [];
  }
  const { key: root, rest } = to;
  const imp = imported(root);
  if (place === "handler" && imp?.kind === "topic" && imp.intent === "write" && rest.length === 0) return [SEND, ...after(path, "expression", own)];
  if (imp?.kind === "task") return place === "handler" && rest.length === 0 ? [CANCEL] : [];
  const value = rest.reduce(at, live(root).value);
  const known = live(root).known;
  if (imp) {
    let fields: FieldInfo[] | undefined = entity(imp.entity)?.schema?.fields;
    let field: FieldInfo | undefined = fields && bareType(fields) ? fields[0] : undefined;
    if (field) fields = undefined;
    for (const step of rest) {
      if (/^\d+$/.test(step)) {
        const item = field?.kind === "array" ? field.elem : null;
        if (!item) return [];
        [field, fields] = item.kind === "struct" ? [undefined, item.members] : [item, undefined];
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
  const keyed = fields(value);
  if (keyed) return [...Object.keys(keyed).map((k): Suggestion => ({ label: k, insert: k, icon: "member", value: at(value, k), known })), ...mathMethods(value, known)];
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

/** The value now at a path: a theme token's where code reads those, else a member's or a field
 *  of one. Null where none is known. */
function valueAt(path: string[], place: Place, own?: string): Value | null {
  const token = path.length === 1 && THEMED.includes(place) ? state.tokens.find((t) => `$${t.name}` === path[0]) : undefined;
  if (token) return tokenNow(token);
  const to = keyOf(path, own);
  return to ? to.rest.reduce(at, live(to.key).value) : null;
}

function at(v: Value | null, step: string): Value | null {
  if (Array.isArray(v) || v instanceof Uint8Array) return v[Number(step)] ?? null;
  return fields(v)?.[step] ?? null;
}
