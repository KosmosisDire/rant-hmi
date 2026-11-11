// Math for pages and code, the same in the browser and on the system: standard functions, vec(),
// colours, and the operators and methods arith.js routes through Rant Math's table by type.

/** A colour is text such as "#2a6fd6" or "#2a6fd680", as a bare #hex in code reads. */
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const isColour = (v) => typeof v === "string" && HEX.test(v);

/** A value as an error names it, as "a Double3" or "an Inertia". */
function named(v) {
  if (isColour(v)) return "a colour";
  const t = typeOf(v);
  if (t) return /^[AEIOU]/.test(t) ? `an ${t}` : `a ${t}`;
  return typeof v === "string" ? "text" : v === null || v === undefined ? String(v) : `a ${typeof v}`;
}

/** A value as text joins it: one of a standard type as its numbers, a pose as "(1, 2, 3) (0, 0, 0, 1)". */
function words(v) {
  if (typeOf(v) === null) return String(v);
  const parts = Object.values(v);
  return parts.every((p) => typeof p === "number") ? `(${parts.join(", ")})` : parts.map(words).join(" ");
}

// --------------------------------------------------------------------------- colours

/** A colour's red, green, blue and alpha, each 0 to 1. */
function rgba(c) {
  let h = HEX.exec(c)[1];
  if (h.length <= 4) h = [...h].map((x) => x + x).join("");
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

/** Red, green, blue and alpha as a colour, its alpha written only when it shows through. */
function hex({ r, g, b, a }) {
  const two = (v) => Math.round(Math.min(1, Math.max(0, v || 0)) * 255).toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}${two(a) === "ff" ? "" : two(a)}`;
}

// OKLab, where an even step looks even and a hue holds as it lightens
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gamma = (v) => (v <= 0.0031308 ? 12.92 * Math.max(0, v) : 1.055 * v ** (1 / 2.4) - 0.055);

function lab({ r, g, b, a }) {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, a };
}

function srgb({ L, A, B, a }) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  };
}

/** From colour `a` toward colour `b` by `t`, 0 to 1, through OKLab. */
function mix(a, b, t) {
  for (const c of [a, b]) if (!isColour(c)) throw new TypeError(`mix takes a colour, not ${named(c)}`);
  const [p, q] = [lab(rgba(a)), lab(rgba(b))];
  const at = (x, y) => x + (y - x) * t;
  return hex(srgb({ L: at(p.L, q.L), A: at(p.A, q.A), B: at(p.B, q.B), a: at(p.a, q.a) }));
}

/** A colour's channels times `k`, brighter above 1 and darker below, its alpha kept. */
const scale = (c, k) => {
  const v = rgba(c);
  return hex({ r: v.r * k, g: v.g * k, b: v.b * k, a: v.a });
};

const COLOUR = {
  lighten: (c, t) => mix(c, hex({ r: 1, g: 1, b: 1, a: rgba(c).a }), t),
  darken: (c, t) => mix(c, hex({ r: 0, g: 0, b: 0, a: rgba(c).a }), t),
  alpha: (c, a) => hex({ ...rgba(c), a }),
  fade: (c, k) => {
    const v = rgba(c);
    return hex({ ...v, a: v.a * k });
  },
  mix: (c, other, t = 0.5) => mix(c, other, t),
};

// ------------------------------------------------------------------ Rant Math's table

let makeMath = () => LIBRARY.math;
let made = null;
let calls = null;

/** Sets what makes Rant Math, asked once when first needed. A page's is LIBRARY.math. */
export function setMath(make) {
  makeMath = make;
  made = calls = null;
}

/** Rant Math, made when first asked for. */
export function rantMath() {
  return (made ??= makeMath());
}

/** quaternion_to_euler as JavaScript spells it, quaternionToEuler. */
const camel = (name) => name.split("_").filter(Boolean).map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join("");

/** Each type's methods by name and each operator by "left op right", read when first needed. */
function table() {
  if (calls) return calls;
  const m = rantMath();
  const fns = m.functions().map((f) => m[camel(f.name)]);
  const methods = new Map();
  for (const r of m.methods()) {
    if (r.selfIndex === null) continue;
    if (!methods.has(r.type)) methods.set(r.type, new Map());
    methods.get(r.type).set(camel(r.name), { call: fns[r.function], function: r.function, self: r.selfIndex, field: r.field });
  }
  const operators = new Map();
  for (const o of m.operators()) {
    const f = fns[o.function];
    const how = { call: f, scale: f, scale_left: (a, b) => f(b, a) }[o.how];
    if (how) operators.set(`${o.left} ${o.op} ${o.right}`, how);
  }
  return (calls = { methods, operators, byValue: new Map() });
}

/** The type whose operators `v` takes: its standard type, a Float or Int vector taking its
 *  Double one's, "double" for a number, else null. */
export function mathType(v) {
  if (typeof v === "number") return "double";
  const t = typeOf(v);
  return t !== null && /^(Float|Int)[234]$/.test(t) ? `Double${t.slice(-1)}` : t;
}

/** The methods of `v` by name: its type's own, over its Double type's for a Float or Int vector. */
function methodsFor(v) {
  const t = typeOf(v);
  if (t === null) return undefined;
  const { methods, byValue } = table();
  if (!byValue.has(t)) {
    const own = methods.get(t);
    const base = /^(Float|Int)[234]$/.test(t) ? methods.get(`Double${t.slice(-1)}`) : undefined;
    byValue.set(t, own && base ? new Map([...base, ...own]) : (own ?? base));
  }
  return byValue.get(t);
}

/** The methods after a dot on `v`: a colour's, or a standard type's with its call's index in the
 *  table and the input the value fills. */
export function methodsOf(v) {
  if (isColour(v)) return Object.keys(COLOUR).map((name) => ({ name }));
  return [...(methodsFor(v) ?? [])].map(([name, m]) => ({ name, function: m.function, self: m.self }));
}

let fixedNames = null;

/** Sets every type's method names where only the rewrite reads them, so it makes no Rant Math. */
export function setMethodNames(list) {
  fixedNames = list;
}

/** Every method name, which arith.js routes through `__method`: each type's and a colour's. */
export function methodNames() {
  const names = new Set(Object.keys(COLOUR));
  if (fixedNames) for (const name of fixedNames) names.add(name);
  else for (const own of table().methods.values()) for (const name of own.keys()) names.add(name);
  return [...names];
}

// ------------------------------------------------------------------ the operators

const typed = (t) => t !== null && t !== "double";

/** `a op b` by Rant Math's operator for their types, `plain()` where neither has a standard
 *  type, else an error that says so. */
function operate(op, verb, a, b, plain) {
  const [ta, tb] = [mathType(a), mathType(b)];
  if (!typed(ta) && !typed(tb)) return plain();
  const f = table().operators.get(`${ta} ${op} ${tb}`);
  if (f) return f(a, b);
  throw new TypeError(`${named(a)} and ${named(b)} cannot be ${verb}`);
}

function __add(a, b) {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (typeof a === "string" || typeof b === "string") return words(a) + words(b);
  return operate("+", "added", a, b, () => a + b);
}

function __sub(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return operate("-", "subtracted", a, b, () => a - b);
}

/** Rant Math's products, and a colour by a number, which brightens or darkens it, or by a
 *  colour, each channel by the other's. */
function __mul(a, b) {
  if (typeof a === "number" && typeof b === "number") return a * b;
  if (isColour(a) && typeof b === "number") return scale(a, b);
  if (isColour(b) && typeof a === "number") return scale(b, a);
  if (isColour(a) && isColour(b)) {
    const [p, q] = [rgba(a), rgba(b)];
    return hex({ r: p.r * q.r, g: p.g * q.g, b: p.b * q.b, a: p.a * q.a });
  }
  return operate("*", "multiplied", a, b, () => a * b);
}

function __div(a, b) {
  if (typeof a === "number" && typeof b === "number") return a / b;
  if (isColour(a) && typeof b === "number") return scale(a, 1 / b);
  return operate("/", "divided", a, b, () => a / b);
}

function __neg(a) {
  const t = mathType(a);
  if (!typed(t)) return -a;
  const f = table().operators.get(`${t} neg `);
  if (f) return f(a);
  throw new TypeError(`${named(a)} cannot be negated`);
}

/** A method call on `target`: its standard type's from Rant Math, a colour's from here, any
 *  other its own. */
function __method(target, name, ...args) {
  if (isColour(target) && COLOUR[name]) return COLOUR[name](target, ...args);
  const m = methodsFor(target)?.get(name);
  if (m) {
    args.splice(m.self, 0, m.field ? target[m.field] : target);
    return m.call(...args);
  }
  if (target === null || target === undefined) throw new TypeError(`${name} cannot be called on ${target}`);
  const f = target[name];
  if (typeof f !== "function") throw new TypeError(typed(mathType(target)) ? `${named(target)} has no ${name}` : `${name} is not a function`);
  return Reflect.apply(f, target, args);
}

// ---------------------------------------------------------------------- the names

function vec(...parts) {
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((p) => typeof p !== "number")) throw new TypeError("vec takes two or three numbers");
  const [x, y, z] = parts;
  return parts.length === 2 ? { [TYPE]: "Double2", x, y } : { [TYPE]: "Double3", x, y, z };
}

/** From `a` toward `b` by `t`, numbers or vectors alike. */
function lerp(a, b, t) {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  if (!methodsFor(a)?.has("lerp")) throw new TypeError(`lerp takes numbers or vectors, not ${named(a)}`);
  return __method(a, "lerp", b, t);
}

// ---------------------------------------------------------------------- the types

/** Where a value names its type, as Rant Math's results and values from the mesh do. */
export const TYPE = Symbol.for("rant.type");

let standardTypes = () => [];
let byName = null;
let byFields = null;

/** Sets how the standard types are read, each a TypeInfo, asked once when first needed. */
export function setTypes(read) {
  standardTypes = read;
  byName = byFields = null;
}

/** A whole value's type as one field: a bare type's own, else a struct of its fields. The
 *  server's `whole_type` is the same. */
export function wholeType(t) {
  const bare = t.fields.length === 1 && t.fields[0].name === "";
  return bare ? t.fields[0] : { name: "", kind: "struct", type_name: t.name || null, elem: null, count: 0, options: [], members: t.fields };
}

/** The standard struct type `name` as one field, else undefined. */
export function standardType(name) {
  byName ??= new Map(standardTypes().map((t) => [t.name, wholeType(t)]).filter(([, f]) => f.kind === "struct"));
  return byName.get(name);
}

const tags = (f) => f.kind === "struct" || (f.kind === "array" && !!f.elem && tags(f.elem));

/** `v` as a value of type `f`, a FieldInfo: each struct of a named type down its fields names it
 *  under TYPE. A copy where one needs a tag, or with `place` the value itself, minus parts `skip` keeps. */
export function tag(v, f, { skip, place } = {}) {
  if (v === null || typeof v !== "object" || ArrayBuffer.isView(v) || !f || skip?.(v)) return v;
  if (Array.isArray(v)) {
    if (!f.elem || !tags(f.elem)) return v;
    let out = v;
    v.forEach((x, i) => {
      const t = tag(x, f.elem, { skip, place });
      if (t === x) return;
      if (out === v) out = v.slice();
      out[i] = t;
    });
    return out;
  }
  if (v[TYPE] !== undefined || (!f.type_name && f.members.length === 0)) return v;
  let out = v;
  const put = (k, x) => {
    if (!place && out === v) out = { ...v };
    out[k] = x;
  };
  if (f.type_name) put(TYPE, f.type_name);
  for (const m of f.members) {
    if (!(m.name in v)) continue;
    const t = tag(v[m.name], m, { skip, place });
    if (t !== v[m.name]) put(m.name, t);
  }
  return out;
}

/** `v` as the standard struct type `name` when it has exactly that type's fields, else as it is. */
export function tagAs(v, name) {
  const f = standardType(name);
  if (!f || v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const fits = Object.keys(v).sort().join() === f.members.map((m) => m.name).sort().join();
  return fits ? tag(v, f) : v;
}

/** A value's standard type: the name it carries, else the one its fields fit. Numbers by x and
 *  y are a Double2, then a Double3 and a Quaternion. Types with the same fields need the name. */
export function typeOf(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v) || ArrayBuffer.isView(v)) return null;
  if (v[TYPE] !== undefined) return v[TYPE];
  const keys = Object.keys(v).sort().join(",");
  if (Object.values(v).every((x) => typeof x === "number")) {
    const vector = { "x,y": "Double2", "x,y,z": "Double3", "w,x,y,z": "Quaternion" }[keys];
    if (vector) return vector;
  }
  if (!byFields) {
    byFields = new Map();
    for (const t of standardTypes()) {
      const f = wholeType(t);
      if (f.kind !== "struct") continue;
      const k = f.members.map((m) => m.name).sort().join(",");
      byFields.set(k, byFields.has(k) ? null : t.name);
    }
  }
  return byFields.get(keys) ?? null;
}

/** What makes a value of the standard struct type `name` from all its fields and no others,
 *  as `Cylinder({ axis, radius })`, else undefined for a name that is no such type. */
export function maker(name) {
  const f = standardType(name);
  if (!f) return undefined;
  const fields = f.members.map((m) => m.name);
  return (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v) || ArrayBuffer.isView(v)) throw new TypeError(`${name} takes an object with ${fields.join(", ")}`);
    const missing = fields.filter((n) => !(n in v));
    if (missing.length > 0) throw new TypeError(`${name} needs ${missing.join(", ")}`);
    const extra = Object.keys(v).filter((k) => !fields.includes(k));
    if (extra.length > 0) throw new TypeError(`${name} has no ${extra.join(", ")}`);
    const out = { [TYPE]: name };
    for (const m of f.members) out[m.name] = tag(v[m.name], m);
    return out;
  };
}

let clock = () => Date.now();

/** Sets how `time.now` reads the clock, as a screen does so what shows it moves. */
export function setClock(read) {
  clock = read;
}

/** The clock: `time.now` is ms since 1970, as `Date.now()` gives it. */
const time = Object.freeze({
  get now() {
    return clock();
  },
});

/** What reading a member throws while its value is unknown, as its node is off the mesh. */
export class Unknown extends Error {
  constructor(alias) {
    super(`${alias} is unknown`);
    this.name = "Unknown";
    this.alias = alias;
  }
}

/** Every name pages and code read besides their own. `log` stays a handler's logging, so the
 *  natural log is `ln`. */
export const LIBRARY = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  clamp: (x, low, high) => Math.min(Math.max(x, low), high),
  lerp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  pow: Math.pow,
  exp: Math.exp,
  ln: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  hypot: Math.hypot,
  degrees: (radians) => (radians * 180) / Math.PI,
  radians: (degrees) => (degrees * Math.PI) / 180,
  PI: Math.PI,
  vec,
  mix,
  time,
  // Rant Math, which each place fills: the wasm binding in a page, the Rust crate on the system.
  math: null,
  __add,
  __sub,
  __mul,
  __div,
  __neg,
  __method,
  __fn,
  __yield,
  __Unknown: Unknown,
  __maybe,
  __maybeAsync,
  __callee,
};

/** The library's functions, which a call by name reaches though a name of the page's own,
 *  as a component's `max` input, hides the plain name. */
export const FUNCTION_NAMES = Object.keys(LIBRARY).filter((k) => !k.startsWith("__") && typeof LIBRARY[k] === "function");

function __fn(name, ...args) {
  return LIBRARY[name](...args);
}

/** What an await waits on, as it is. The system's handlers take one of their own, which first
 *  sends what the run wrote, so another run going on meanwhile reads it. */
function __yield(v) {
  return v;
}

/** What `read` gives, or undefined where it reads a value that is unknown, so `a ?? b` gives b
 *  for an unknown a. */
function __maybe(read) {
  try {
    return read();
  } catch (e) {
    if (e instanceof Unknown) return undefined;
    throw e;
  }
}

/** `holder[key]`, a function bound to its holder, so `holder.key?.()` reads it in __maybe and
 *  still calls it on its holder. */
function __callee(holder, key) {
  const f = holder[key];
  return typeof f === "function" ? f.bind(holder) : f;
}

/** As __maybe, for a `??` whose left side awaits. */
async function __maybeAsync(read) {
  try {
    return await read();
  } catch (e) {
    if (e instanceof Unknown) return undefined;
    throw e;
  }
}
