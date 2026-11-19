// The types code works with, and what an expression gives, worked out from what it reads without
// running any of its code. Completion, call hints and the name card read it. A value rides along
// where it is known now, worked out only by calls that change nothing.

import { NAMES } from "rant-math/names";
import { API } from "./api.js";
import { parse as loose } from "./acorn/acorn-loose.mjs";
import { children, tree } from "./arith.js";
import { givesOf, LIBRARY, methodsOfType, operatorGives, standardType, TYPE } from "./math.js";

export const NUMBER = Object.freeze({ kind: "number" });
export const STRING = Object.freeze({ kind: "string" });
export const BOOL = Object.freeze({ kind: "bool" });
export const COLOUR = Object.freeze({ kind: "colour" });
export const BYTES = Object.freeze({ kind: "bytes" });
export const DATE = Object.freeze({ kind: "date" });
export const UNKNOWN = Object.freeze({ kind: "unknown" });

export const list = (item) => ({ kind: "list", item });
export const map = (item) => ({ kind: "map", item });

/** A struct by its fields, each a name and a type, and the type's name where it has one. `own`
 *  are members it has besides, as an object's functions. */
export const record = (fields, name, own = []) => ({ kind: "record", fields, name, own });

/** Something code calls: what it takes, in words, and what it gives, a type or a function of the
 *  call's values that works it out. `run` works its value out where it changes nothing, `calls`
 *  says what a function given as value i is called with, and `own` are members it has. */
export const callable = (takes, gives, more = {}) => ({ kind: "function", takes, gives, own: [], ...more });

/** A type with a value it has now, or none. */
export const typed = (t, v) => ({ t, v, known: v !== undefined });

const NUMBERS = /^(u8|u16|u32|u64|i8|i16|i32|i64|f32|f64)$/;

/** A mesh field's type, as the schema gives it. */
export function fromField(f) {
  if (NUMBERS.test(f.kind)) return NUMBER;
  switch (f.kind) {
    case "bool":
      return BOOL;
    case "string":
    case "enum":
      return STRING;
    case "struct":
      return record(
        f.members.map((m) => [m.name, fromField(m)]),
        f.type_name || undefined,
      );
    case "array":
      return f.elem?.kind === "u8" ? BYTES : list(f.elem ? fromField(f.elem) : UNKNOWN);
    case "map":
      return map(f.elem ? fromField(f.elem) : UNKNOWN);
  }
  return UNKNOWN;
}

const standards = new Map();

/** One of Rant's standard types by its name, else undefined. */
export function standard(name) {
  if (!standards.has(name)) {
    const f = standardType(name);
    standards.set(name, f && fromField(f));
  }
  return standards.get(name);
}

/** What Rant Math's table names as a call's output: a standard type or a C number type. */
export function fromC(type) {
  if (!type) return UNKNOWN;
  if (type === "bool") return BOOL;
  if (/^(float|double|u?int(8|16|32|64)_t|size_t)$/.test(type)) return NUMBER;
  return standard(type) ?? UNKNOWN;
}

/** A value's type, read from the value, where nothing says it otherwise. */
export function fromValue(v) {
  if (typeof v === "number" || typeof v === "bigint") return NUMBER;
  if (typeof v === "boolean") return BOOL;
  if (typeof v === "string") return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? COLOUR : STRING;
  if (v instanceof Uint8Array) return BYTES;
  if (v instanceof Date) return DATE;
  if (Array.isArray(v)) return list(v.length > 0 ? fromValue(v[0]) : UNKNOWN);
  if (v === null || typeof v !== "object") return UNKNOWN;
  const name = v[TYPE];
  if (name !== undefined && standard(name)) return standard(name);
  return record(Object.entries(v).map(([k, x]) => [k, fromValue(x)]));
}

/** A type as the declarations write it: number, string, bool, colour, bytes, date, unknown, a
 *  standard type's name, `{ a: T, b: T }` for a struct, then `[]` for a list of it or `{}` for a
 *  map of it, as many times as it nests. */
export function parseType(text) {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? "")) at++;
  };
  const word = () => {
    space();
    const m = /^[A-Za-z_][\w]*/.exec(text.slice(at));
    if (!m) throw new SyntaxError(`a type is expected at ${at} in "${text}"`);
    at += m[0].length;
    return m[0];
  };
  const one = () => {
    space();
    let t;
    if (text[at] === "{") {
      at++;
      const fields = [];
      space();
      while (text[at] !== "}") {
        const name = word();
        space();
        if (text[at++] !== ":") throw new SyntaxError(`":" is expected after ${name} in "${text}"`);
        fields.push([name, one()]);
        space();
        if (text[at] === ",") at++;
        space();
      }
      at++;
      t = record(fields);
    } else {
      const w = word();
      t = { number: NUMBER, string: STRING, bool: BOOL, colour: COLOUR, bytes: BYTES, date: DATE, unknown: UNKNOWN }[w] ?? standard(w) ?? UNKNOWN;
    }
    for (;;) {
      space();
      if (text.startsWith("[]", at)) t = list(t);
      else if (text.startsWith("{}", at)) t = map(t);
      else return t;
      at += 2;
    }
  };
  const t = one();
  space();
  if (at < text.length) throw new SyntaxError(`"${text.slice(at)}" is left over in "${text}"`);
  return t;
}

/** A type in a few words, as completion shows it. */
export function words(t) {
  switch (t.kind) {
    case "list":
      return `${words(t.item) || "value"}[]`;
    case "map":
      return `${words(t.item) || "value"}{}`;
    case "record":
      return t.name ?? "struct";
    case "unknown":
      return "";
  }
  return t.kind;
}

// ------------------------------------------------------------------ what a type offers

/** A member as a type offers it after a dot: a value with its `type`, or a method with what it
 *  `takes`, in words, and what it `gives`: a type, or a function of the value and the call's
 *  values. `run` works the answer out where that changes nothing. */
const method = (name, takes, gives, words, run) => ({ name, takes, gives, words, run });
const field = (name, type, words) => ({ name, type, words });

/** JavaScript's own methods of `proto` that change nothing, each run on the value itself. */
function own(proto, table) {
  return Object.entries(table).map(([name, [takes, gives, w]]) => method(name, takes, gives, w, (self, args) => proto[name].apply(self, args)));
}

const item = (self) => self.t.item ?? UNKNOWN;
const same = (self) => self.t;
const eachOf = (self) => [item(self), NUMBER, self.t];
const pairOf = (self) => [item(self), item(self)];

/** A list method that calls a function on its items: `params` are what the function is called
 *  with, and `gives` what the method gives, from the list, what the function returns and the
 *  call's values. */
function each(name, takes, params, gives, words) {
  const calls = (self, args, i) => (i === 0 ? params(self, args) : undefined);
  return { name, takes, words, calls, gives: (self, args) => gives(self, args[0]?.returns(params(self, args)) ?? UNKNOWN, args) };
}

const NUMBER_MEMBERS = own(Number.prototype, {
  toFixed: [["digits?"], STRING, "with this many digits after the point"],
  toPrecision: [["digits?"], STRING, "with this many digits in all"],
  toExponential: [["digits?"], STRING, "in exponent form"],
  toString: [["radix?"], STRING, "as text"],
  toLocaleString: [[], STRING, "as text the screen's language writes"],
});

const STRING_MEMBERS = [
  field("length", NUMBER, "how many characters"),
  ...own(String.prototype, {
    at: [["index"], STRING, "the character at index, from the end where negative"],
    charAt: [["index"], STRING, "the character at index"],
    charCodeAt: [["index"], NUMBER, "the code of the character at index"],
    codePointAt: [["index"], NUMBER, "the code point at index"],
    concat: [["...texts"], STRING, "with texts after it"],
    endsWith: [["text"], BOOL, "true when it ends with text"],
    includes: [["text"], BOOL, "true when it holds text"],
    indexOf: [["text"], NUMBER, "where text first is, -1 for nowhere"],
    lastIndexOf: [["text"], NUMBER, "where text last is, -1 for nowhere"],
    localeCompare: [["other"], NUMBER, "before, same or after other"],
    normalize: [["form?"], STRING, "in a Unicode form"],
    padEnd: [["length", "fill?"], STRING, "filled at its end to length"],
    padStart: [["length", "fill?"], STRING, "filled at its start to length"],
    repeat: [["count"], STRING, "count times over"],
    replace: [["find", "with"], STRING, "with its first find replaced"],
    replaceAll: [["find", "with"], STRING, "with every find replaced"],
    search: [["pattern"], NUMBER, "where pattern first matches"],
    slice: [["start", "end?"], STRING, "the part from start to end"],
    split: [["separator"], list(STRING), "the parts between each separator"],
    startsWith: [["text"], BOOL, "true when it starts with text"],
    substring: [["start", "end?"], STRING, "the part from start to end"],
    toLowerCase: [[], STRING, "in small letters"],
    toUpperCase: [[], STRING, "in capitals"],
    toString: [[], STRING, "as itself"],
    trim: [[], STRING, "without space at either end"],
    trimEnd: [[], STRING, "without space at its end"],
    trimStart: [[], STRING, "without space at its start"],
  }),
];

const BOOL_MEMBERS = own(Boolean.prototype, { toString: [[], STRING, "true or false as text"] });

/** A list's methods. */
const LIST_MEMBERS = [
  field("length", NUMBER, "how many items"),
  ...own(Array.prototype, {
    at: [["index"], item, "the item at index, from the end where negative"],
    concat: [["...lists"], same, "with lists after it"],
    includes: [["item"], BOOL, "true when it holds item"],
    indexOf: [["item"], NUMBER, "where item first is, -1 for nowhere"],
    join: [["separator?"], STRING, "its items as text, separator between them"],
    lastIndexOf: [["item"], NUMBER, "where item last is, -1 for nowhere"],
    slice: [["start?", "end?"], same, "the items from start to end"],
    toReversed: [[], same, "in the other order"],
    with: [["index", "item"], same, "with the item at index changed"],
  }),
  each("every", ["(item, index) => ..."], eachOf, () => BOOL, "true when the function is true for every item"),
  each("filter", ["(item, index) => ..."], eachOf, same, "the items the function is true for"),
  each("find", ["(item, index) => ..."], eachOf, item, "the first item the function is true for"),
  each("findIndex", ["(item, index) => ..."], eachOf, () => NUMBER, "where the first item the function is true for is"),
  each("findLast", ["(item, index) => ..."], eachOf, item, "the last item the function is true for"),
  each("findLastIndex", ["(item, index) => ..."], eachOf, () => NUMBER, "where the last item the function is true for is"),
  each("flatMap", ["(item, index) => ..."], eachOf, (_, r) => (r.kind === "list" ? r : list(r)), "each item's list from the function, one after another"),
  each("forEach", ["(item, index) => ..."], eachOf, () => UNKNOWN, "runs the function on each item"),
  each("map", ["(item, index) => ..."], eachOf, (_, r) => list(r), "what the function gives for each item"),
  each("reduce", ["(sum, item, index) => ...", "start?"], (self, args) => [args[1]?.typed.t ?? item(self), item(self), NUMBER, self.t], (self, r, args) => (r.kind === "unknown" ? (args[1]?.typed.t ?? item(self)) : r), "the items folded into one by the function"),
  each("some", ["(item, index) => ..."], eachOf, () => BOOL, "true when the function is true for an item"),
  each("toSorted", ["(a, b) => ...?"], pairOf, same, "in the order the function gives, a negative putting a first"),
  // those that change the list itself are never run here
  method("push", ["...items"], NUMBER, "adds items at its end, giving its new length"),
  method("pop", [], item, "takes its last item off"),
  method("shift", [], item, "takes its first item off"),
  method("unshift", ["...items"], NUMBER, "adds items at its start, giving its new length"),
  method("splice", ["start", "count?", "...items"], same, "takes count items off at start, putting items there"),
  each("sort", ["(a, b) => ...?"], pairOf, same, "puts it in the order the function gives"),
  method("reverse", [], same, "puts it in the other order"),
  method("fill", ["value", "start?", "end?"], same, "sets its items to value"),
];

const BYTES_MEMBERS = [
  field("length", NUMBER, "how many bytes"),
  ...own(Uint8Array.prototype, {
    at: [["index"], NUMBER, "the byte at index"],
    includes: [["byte"], BOOL, "true when it holds byte"],
    indexOf: [["byte"], NUMBER, "where byte first is"],
    join: [["separator?"], STRING, "its bytes as text"],
    slice: [["start?", "end?"], BYTES, "the bytes from start to end"],
  }),
];

/** A date's methods: each `get` gives a number, each `to` text. */
const DATE_MEMBERS = Object.getOwnPropertyNames(Date.prototype)
  .filter((n) => /^(get|to)[A-Z]/.test(n) && !n.startsWith("getUTC") && n !== "toJSON" && n !== "getYear")
  .sort()
  .map((n) => method(n, [], n.startsWith("get") ? NUMBER : STRING, n.startsWith("get") ? `its ${n.slice(3).toLowerCase()}` : "as text", (self) => Date.prototype[n].call(self)));

/** What a colour's methods take, and what they give. */
const COLOUR_MEMBERS = [
  ["lighten", ["t"], "toward white by t, 0 to 1"],
  ["darken", ["t"], "toward black by t, 0 to 1"],
  ["alpha", ["a"], "with this alpha, 0 to 1"],
  ["fade", ["k"], "its alpha times k"],
  ["mix", ["other", "t?"], "toward another colour by t"],
].map(([name, takes, w]) => method(name, takes, COLOUR, w, (self, args) => LIBRARY.__method(self, name, ...args)));

/** A standard type's methods from Rant Math's table, each giving what the table says. */
function mathMembers(name) {
  return [...(methodsOfType(name) ?? [])].map(([m, { function: f, self }]) => {
    const takes = (NAMES[f]?.takes ?? []).filter((_, i) => i !== self);
    return method(m, takes, fromC(givesOf(f)), NAMES[f]?.words ?? "", (value, args) => LIBRARY.__method(value, m, ...args));
  });
}

const mathMembersOf = new Map();

/** What a type offers after a dot: a struct its fields, its own and its type's methods; any other
 *  what JavaScript gives its kind. */
export function membersOf(t) {
  switch (t.kind) {
    case "number":
      return NUMBER_MEMBERS;
    case "string":
      return STRING_MEMBERS;
    case "bool":
      return BOOL_MEMBERS;
    case "colour":
      return COLOUR_MEMBERS;
    case "bytes":
      return BYTES_MEMBERS;
    case "date":
      return DATE_MEMBERS;
    case "list":
      return LIST_MEMBERS;
    case "record": {
      const fields = t.fields.map(([name, type]) => field(name, type, words(type)));
      if (!t.name) return [...fields, ...t.own];
      if (!mathMembersOf.has(t.name)) mathMembersOf.set(t.name, mathMembers(t.name));
      return [...fields, ...t.own, ...mathMembersOf.get(t.name)];
    }
    case "function":
      return t.own;
  }
  return [];
}

// ------------------------------------------------------------------ the globals

/** `Math`, `JSON`, `Object`, `Array`, `Date` and `Number` as code reads them, each a struct of
 *  its functions and values. */
function functionsOf(o, gives, pick = () => true) {
  return Object.getOwnPropertyNames(o)
    .filter((n) => typeof o[n] === "function" && pick(n))
    .sort()
    .map((n) => method(n, ["..."], typeof gives === "function" ? gives(n) : gives, "", (_, args) => o[n](...args)));
}
/** Functions of a global that change nothing, each run on what it is given. */
const statics = (o, table) => Object.entries(table).map(([n, [takes, gives, w]]) => method(n, takes, gives, w, (_, args) => o[n](...args)));
const valuesOf = (o) => Object.getOwnPropertyNames(o).filter((n) => typeof o[n] === "number").map((n) => [n, NUMBER]);

const GLOBALS = {
  Math: typed(record(valuesOf(Math), undefined, functionsOf(Math, NUMBER)), Math),
  JSON: typed(record([], undefined, statics(JSON, { stringify: [["value"], STRING, "as JSON text"], parse: [["text"], UNKNOWN, "the value JSON text holds"] })), JSON),
  Object: typed(record([], undefined, statics(Object, { keys: [["value"], list(STRING), "its fields' names"], values: [["value"], list(UNKNOWN), "its fields' values"], entries: [["value"], list(list(UNKNOWN)), "its fields as [name, value]"] })), Object),
  Array: typed(record([], undefined, statics(Array, { isArray: [["value"], BOOL, "true for a list"], from: [["value"], list(UNKNOWN), "a list of what it holds"] })), Array),
  Date: typed(record([], undefined, [method("now", [], NUMBER, "ms since 1970")]), Date),
};

/** The language's own functions whose answer is the kind of what they are given. */
const BY_VALUES = {
  vec: (args) => standard(args.length === 2 ? "Double2" : "Double3") ?? UNKNOWN,
  lerp: (args) => args[0]?.typed.t ?? UNKNOWN,
};

/** One of api.js's names as code reads it: a function giving what it says, `math` each of Rant
 *  Math's calls by its table, a struct of its fields, JavaScript's own as it is. */
export function fromApi(a) {
  if (a.standard && GLOBALS[a.name]) return GLOBALS[a.name];
  if (a.name === "math") {
    const calls = NAMES.map((c, i) => method(c.name, c.takes, fromC(givesOf(i)), c.words, (_, args) => LIBRARY.math[c.name](...args)));
    return typed(record([], undefined, calls));
  }
  const found = a.standard ? globalThis[a.name] : LIBRARY[a.name];
  const run = typeof found === "function" ? found : undefined;
  if (a.takes) return typed(callable(a.takes, BY_VALUES[a.name] ?? (a.gives ? parseType(a.gives) : UNKNOWN), { run }));
  if (a.fields) {
    const fields = a.fields.filter((f) => !f.takes).map((f) => [f.name, f.gives ? parseType(f.gives) : UNKNOWN]);
    const calls = a.fields.filter((f) => f.takes).map((f) => method(f.name, f.takes, f.gives ? parseType(f.gives) : UNKNOWN, f.words));
    return typed(record(fields, undefined, calls));
  }
  const value = typeof LIBRARY[a.name] === "number" ? LIBRARY[a.name] : undefined;
  return typed(a.gives ? parseType(a.gives) : value !== undefined ? NUMBER : UNKNOWN, value);
}

const languageNames = new Map();

/** One of the language's own names as code reads it, by api.js, made once. */
function language(name) {
  if (!languageNames.has(name)) {
    const a = API.find((x) => x.name === name);
    languageNames.set(name, a && fromApi(a));
  }
  return languageNames.get(name);
}

// ------------------------------------------------------------------ what an expression gives

/** A value's type made plain from its value where its own says nothing. */
function refined(x) {
  return x.t.kind === "unknown" && x.known ? typed(fromValue(x.v), x.v) : x;
}

/** The member `name` of what `x` is, as a value or a method. */
export function memberOf(x, name) {
  return membersOf(refined(x).t).find((m) => m.name === name);
}

/** What `x.name` reads: a field and its value now, a method as a function, nothing it lacks. */
export function read(x, name) {
  x = refined(x);
  const m = memberOf(x, name);
  if (!m) return typed(x.t.kind === "map" ? x.t.item : UNKNOWN, x.known && x.v !== null && typeof x.v === "object" ? x.v[name] : undefined);
  if (!m.type) {
    const gives = typeof m.gives === "function" ? (args) => m.gives(x, args) : m.gives;
    return typed(callable(m.takes, gives, { calls: m.calls && ((args, i) => m.calls(x, args, i)) }));
  }
  const v = x.known && x.v !== null && x.v !== undefined ? x.v[name] : undefined;
  return refined(typed(m.type, v));
}

/** What `x[i]` reads: a list's or a map's item, and its value where both are known now. */
export function index(x, i) {
  x = refined(x);
  const t = x.t.kind === "list" || x.t.kind === "map" ? x.t.item : x.t.kind === "bytes" ? NUMBER : UNKNOWN;
  return refined(typed(t, x.known && i.known && x.v !== null ? x.v[i.v] : undefined));
}

/** What calling `f` with `args` gives: by what it says it gives, and its value where it changes
 *  nothing and all it is given is known now. `self` is what a method is called on. */
function invoke(gives, run, args, self) {
  const t = typeof gives === "function" ? gives(self, args) : gives;
  let v;
  if (run && (!self || self.known) && args.every((a) => a.typed.known && a.typed.t.kind !== "function")) {
    try {
      v = run(self?.v, args.map((a) => a.typed.v));
    } catch {
      // one that cannot answer for these gives no value, its type stands
    }
  }
  return refined(typed(t ?? UNKNOWN, v ?? undefined));
}

/** What `x.name(args)` gives. */
export function callMethod(x, name, args) {
  x = refined(x);
  const m = memberOf(x, name);
  if (!m || m.type) return typed(UNKNOWN);
  return invoke(m.gives, m.run, args, x);
}

/** What calling `f` gives, a function value. */
export function callValue(f, args) {
  if (f.t.kind !== "function") return typed(UNKNOWN);
  const run = f.t.run && ((_, values) => f.t.run(...values));
  return invoke(typeof f.t.gives === "function" ? (_, a) => f.t.gives(a) : f.t.gives, run, args);
}

const COMPARE = new Set(["==", "===", "!=", "!==", "<", ">", "<=", ">=", "in", "instanceof"]);
const ARITH = { "+": "__add", "-": "__sub", "*": "__mul", "/": "__div" };

/** The name Rant Math's operators know a type by: double for a number, a Float or Int vector by
 *  its Double one. */
function mathName(t) {
  if (t.kind === "number") return "double";
  if (t.kind !== "record" || !t.name) return null;
  const m = /^(Float|Int)([234])$/.exec(t.name);
  return m ? `Double${m[2]}` : t.name;
}

/** What `a op b` gives, or `-a` for neg: a flag from a comparison, text from + with text, a
 *  colour scaled from a colour, numbers from numbers, else by Rant Math's operators. */
export function operate(op, a, b) {
  if (COMPARE.has(op)) return typed(BOOL);
  [a, b] = [refined(a), b && refined(b)];
  let v;
  const fn = op === "neg" ? "__neg" : ARITH[op];
  if (fn && a.known && (op === "neg" || b.known)) {
    try {
      v = LIBRARY[fn](a.v, b?.v);
    } catch {
      // no operator takes these
    }
  }
  const kinds = [a.t.kind, b?.t.kind];
  let t;
  if (op === "+" && kinds.includes("string")) t = STRING;
  else if (a.t.kind === "colour" || b?.t.kind === "colour") t = COLOUR;
  else if (op !== "neg" && op !== "+" && op !== "-" && op !== "*" && op !== "/") t = NUMBER;
  else if (kinds[0] === "number" && (op === "neg" || kinds[1] === "number")) t = NUMBER;
  else {
    const [l, r] = [mathName(a.t), op === "neg" ? "" : b && mathName(b.t)];
    t = l !== null && r !== null ? fromC(operatorGives(op, l, r)) : UNKNOWN;
  }
  return typed(t, v);
}

/** A scope of names: `name` gives what one is, undefined for one it lacks. */
export function scope(name, outer) {
  return { name: (n) => name(n) ?? outer?.name(n) };
}

/** What the expression text `src` gives in `env`, or unknown where it does not parse. */
export function inferText(src, env) {
  try {
    return infer(tree(`(${src}\n)`).body[0].expression, env);
  } catch {
    return typed(UNKNOWN);
  }
}

/** A value a call is given: what it is, and for a function written there, what it returns when
 *  called with values of these types. */
function argOf(n, env) {
  return { typed: infer(n, env), returns: (params) => (isFunction(n) ? returnsOf(n, params, env) : undefined) };
}

const isFunction = (n) => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration";

// the functions being worked out now, so one that calls itself gives nothing known
const working = new Set();

/** What the function node `fn` returns when called with values of the types `params`. */
function returnsOf(fn, params, env) {
  if (working.has(fn)) return UNKNOWN;
  working.add(fn);
  try {
    const bound = new Map();
    fn.params.forEach((p, i) => bind(bound, p, typed(params[i] ?? UNKNOWN), env));
    const inner = scope((name) => bound.get(name), env);
    if (fn.body.type !== "BlockStatement") return infer(fn.body, inner).t;
    const path = returned(fn.body);
    return path ? infer(path.at(-1), declared(path, inner)).t : UNKNOWN;
  } finally {
    working.delete(fn);
  }
}

/** The nodes from `n` down to the first value it returns, outside the functions inside it. */
function returned(n) {
  if (n.type === "ReturnStatement") return n.argument ? [n, n.argument] : undefined;
  if (isFunction(n)) return undefined;
  for (const c of children(n)) {
    const r = returned(c);
    if (r) return [n, ...r];
  }
  return undefined;
}

/** Binds the names the pattern `p` declares, given the value `x`: a name, a struct's fields, a
 *  list's items, or a default where nothing is known. */
function bind(bound, p, x, env) {
  switch (p.type) {
    case "Identifier":
      bound.set(p.name, x);
      break;
    case "AssignmentPattern":
      bind(bound, p.left, x.t.kind === "unknown" ? infer(p.right, env) : x, env);
      break;
    case "ObjectPattern":
      for (const f of p.properties) {
        if (f.type === "RestElement") bind(bound, f.argument, x, env);
        else bind(bound, f.value, f.computed ? typed(UNKNOWN) : read(x, f.key.name ?? String(f.key.value)), env);
      }
      break;
    case "ArrayPattern":
      p.elements.forEach((e, i) => e && bind(bound, e.type === "RestElement" ? e.argument : e, e.type === "RestElement" ? typed(x.t) : index(x, typed(NUMBER, i)), env));
      break;
  }
}

/** What a call gives the function written as its value i, by what the callee says it calls it
 *  with: a list's item to map's, a task's progress to its last. */
function calledWith(call, i, env) {
  const args = call.arguments.map((a) => argOf(a, env));
  const callee = call.callee;
  if (callee.type === "MemberExpression" && !callee.computed) {
    const self = infer(callee.object, env);
    return memberOf(self, callee.property.name)?.calls?.(refined(self), args, i) ?? [];
  }
  const f = infer(callee, env);
  return (f.t.kind === "function" && f.t.calls?.(args, i)) || [];
}

/** The names the statement `s` declares: its variables, `let` ones without a value since code
 *  may change them, and its functions. */
function declare(bound, s, env) {
  if (s.type === "VariableDeclaration") {
    for (const d of s.declarations) {
      const x = d.init ? infer(d.init, env) : typed(UNKNOWN);
      bind(bound, d.id, s.kind === "const" ? x : typed(x.t), env);
    }
  } else if (s.type === "FunctionDeclaration" && s.id) bound.set(s.id.name, infer(s, env));
}

/** `env` with what code declares on the way down `path`, from the top to the caret: the
 *  statements before it in each block, the values of each function it is inside, and the item
 *  of a loop over a list. */
function declared(path, env) {
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, c] = [path[i], path[i + 1]];
    const bound = new Map();
    const inner = scope((name) => bound.get(name), env);
    if (a.type === "Program" || a.type === "BlockStatement" || a.type === "StaticBlock") {
      for (const s of a.body) {
        if (s === c) break;
        declare(bound, s, inner);
      }
    } else if (a.type === "VariableDeclaration") {
      declare(bound, { ...a, declarations: a.declarations.slice(0, a.declarations.indexOf(c)) }, inner);
    } else if (isFunction(a) && c === a.body) {
      const call = path[i - 1];
      const given = call?.type === "CallExpression" ? calledWith(call, call.arguments.indexOf(a), env) : [];
      a.params.forEach((p, k) => bind(bound, p, typed(given[k] ?? UNKNOWN), inner));
    } else if ((a.type === "ForOfStatement" || a.type === "ForInStatement") && c === a.body) {
      const of = a.type === "ForInStatement" ? typed(STRING) : index(infer(a.right, env), typed(NUMBER));
      const p = a.left.type === "VariableDeclaration" ? a.left.declarations[0].id : a.left;
      bind(bound, p, typed(of.t), env);
    } else if (a.type === "ForStatement" && c !== a.init && a.init?.type === "VariableDeclaration") {
      declare(bound, a.init, inner);
    } else if (a.type === "CatchClause" && c === a.body && a.param) {
      bind(bound, a.param, typed(UNKNOWN), env);
    }
    if (bound.size > 0) env = inner;
  }
  return env;
}

/** Where the caret is in `before`, the code up to it: the nodes from the top down to it, and the
 *  scope there, `env` with what the code declares before it. Code cut short, as while it is
 *  typed, still parses. */
export function reach(before, env) {
  const path = [loose(before, { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })];
  for (;;) {
    const next = children(path.at(-1)).findLast((c) => c.start <= before.length && c.end >= before.length);
    if (!next) break;
    path.push(next);
  }
  return { path, env: declared(path, env) };
}

/** The name a non-computed member names, or the value a computed one reads. */
function key(n, env) {
  return n.computed ? infer(n.property, env) : typed(STRING, n.property.name);
}

/** What the expression node `n` gives in `env`. */
export function infer(n, env) {
  switch (n.type) {
    case "Literal":
      if (n.regex) return typed(UNKNOWN);
      return n.value === null ? typed(UNKNOWN, null) : typed(fromValue(n.value), n.value);
    case "TemplateLiteral":
      return typed(STRING);
    case "Identifier":
      return env.name(n.name) ?? language(n.name) ?? typed(UNKNOWN);
    case "ChainExpression":
    case "ParenthesizedExpression":
      return infer(n.expression, env);
    case "AwaitExpression":
      return infer(n.argument, env);
    case "SequenceExpression":
      return infer(n.expressions.at(-1), env);
    case "AssignmentExpression":
      return infer(n.right, env);
    case "ConditionalExpression": {
      const yes = infer(n.consequent, env);
      return yes.t.kind === "unknown" ? infer(n.alternate, env) : typed(yes.t);
    }
    case "LogicalExpression": {
      const [l, r] = [infer(n.left, env), infer(n.right, env)];
      if (n.operator === "&&") return typed(r.t);
      return l.known && l.v !== null && l.v !== undefined ? l : typed(l.t.kind === "unknown" ? r.t : l.t);
    }
    case "UnaryExpression":
      if (n.operator === "!" || n.operator === "delete") return typed(BOOL);
      if (n.operator === "typeof") return typed(STRING);
      if (n.operator === "-") return operate("neg", infer(n.argument, env));
      return n.operator === "+" || n.operator === "~" ? typed(NUMBER) : typed(UNKNOWN);
    case "BinaryExpression":
      return operate(n.operator, infer(n.left, env), infer(n.right, env));
    case "ArrayExpression": {
      const items = n.elements.filter(Boolean).map((e) => infer(e, env));
      const all = items.every((x) => x.known);
      return typed(list(items[0]?.t ?? UNKNOWN), all ? items.map((x) => x.v) : undefined);
    }
    case "ObjectExpression": {
      const fields = n.properties.filter((p) => p.type === "Property" && !p.computed).map((p) => [p.key.name ?? String(p.key.value), infer(p.value, env)]);
      const all = fields.every(([, x]) => x.known);
      return typed(record(fields.map(([k, x]) => [k, x.t])), all ? Object.fromEntries(fields.map(([k, x]) => [k, x.v])) : undefined);
    }
    case "MemberExpression": {
      const base = infer(n.object, env);
      const k = key(n, env);
      return n.computed && (base.t.kind === "list" || base.t.kind === "map" || base.t.kind === "bytes") ? index(base, k) : read(base, String(k.v));
    }
    case "CallExpression": {
      const args = n.arguments.map((a) => argOf(a, env));
      if (n.callee.type === "MemberExpression" && !n.callee.computed) return callMethod(infer(n.callee.object, env), n.callee.property.name, args);
      return callValue(infer(n.callee, env), args);
    }
    case "NewExpression":
      return n.callee.type === "Identifier" && n.callee.name === "Date" ? typed(DATE) : typed(UNKNOWN);
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration":
      return typed(callable(n.params.map((p) => p.name ?? "value"), (args) => returnsOf(n, args.map((a) => a.typed.t), env)));
  }
  return typed(UNKNOWN);
}
