// What may be typed next at the caret: names, then after a dot what the value before it offers,
// with its type and live value. types.js works that out from the code before the caret, which
// need not parse.

import { apiIn, type Place } from "../lang/api.js";
import type { Node } from "../lang/arith.js";
import { isHex, tokens as lex } from "../lang/lex";
import { infer, reach, words } from "../lang/types.js";
import type { Kind } from "../protocol/Kind";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { colours, partNames, tokenNow } from "./bind";
import { chain as path } from "./elements";
import { names } from "./names";
import { state } from "./store";
import { envOf, rows, THEMED, whole, type Where } from "./typed";
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

/** The theme's tokens, each with its value in the editor's mode. */
function tokens(): Suggestion[] {
  return state.tokens.map((t) => {
    const value = tokenNow(t);
    return { label: `$${t.name}`, insert: `$${t.name}`, icon: "token", type: "token", value, known: value !== null };
  });
}

/** The language's own names in `place`, from the one list of them, a function's typed with
 *  its bracket. */
const api = (place: Place): Suggestion[] => apiIn(place).map((a) => ({ label: a.name, insert: a.insert ?? (a.takes ? `${a.name}(` : a.name), icon: "api", type: a.words }));

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
  const items = before[from - 1] === "." ? offered(before.slice(0, from), { place, names, also, own }) : [...near, ...far, ...(THEMED.includes(place) ? tokens() : []), ...api(place)];
  return matching(items, word, from);
}

/** What the value before the dot that ends `before` offers. */
function offered(before: string, where: Where): Suggestion[] {
  const src = colours(before);
  const { path, env } = reach(src, envOf(where));
  const dot = [...path].reverse().find((n) => n.type === "MemberExpression" && !n.computed && n.end === src.length);
  return dot ? rows(infer(dot.object as Node, env)) : [];
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

/** The call the caret is inside, whatever code calls there: one of the language's own functions,
 *  a method of a value, or in a handler an object's function, a send or a function or task import. */
export function signature(text: string, caret: number, place: Place, own?: string): Signature | null {
  const before = text.slice(0, caret);
  const src = colours(before);
  const open = opened(src);
  if (!open) return null;
  const { path, env } = reach(src, envOf({ place, own }));
  const callee = ([...path].reverse().find((n) => n.type === "CallExpression" && /^\s*$/.test(src.slice((n.callee as Node).end, open.at))) as Node | undefined)?.callee as Node | undefined;
  const f = callee && infer(callee, env).t;
  if (f?.kind !== "function") return null;
  // the rest of the values all fall to a last `...` one
  const rest = f.takes.at(-1)?.startsWith("...") ? f.takes.length - 1 : Infinity;
  return {
    from: back(before, callee!.start),
    call: src.slice(callee!.start, callee!.end),
    params: f.params ?? f.takes.map((name) => ({ name, type: "" })),
    at: Math.min(open.commas, rest),
    whole: f.whole,
    gives: (typeof f.gives === "function" ? "" : words(f.gives)) || undefined,
    unknown: f.unknown,
  };
}

/** Where a place in `before`, with its colours made strings as `colours` makes them, is in
 *  `before` itself. */
function back(before: string, at: number): number {
  let shift = 0;
  for (const t of lex(before)) if (t.kind === "literal" && isHex(before.slice(t.start, t.end)) && t.end + shift + 2 <= at) shift += 2;
  return at - shift;
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

/** What code may name first: its own object's members bare, then each object, then the enums. */
function top(place: Place, own?: string): Suggestion[] {
  const mine = own === undefined ? [] : rows(whole(own, place, true, true));
  const objects = names("object")
    .filter((n) => !mine.some((m) => m.label === n.name))
    .map((n): Suggestion => ({ label: n.name, insert: n.name, icon: "object", type: n.words }));
  const enums = names("enum").map((n): Suggestion => ({ label: n.name, insert: n.name, icon: "enum", type: n.words }));
  return [...mine, ...objects, ...enums];
}

/** True when the text ends inside a string or a comment, where names are only words. */
function inWords(before: string): boolean {
  const last = lex(before).at(-1);
  return !!last && (last.kind === "text" || last.kind === "comment") && last.open;
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
