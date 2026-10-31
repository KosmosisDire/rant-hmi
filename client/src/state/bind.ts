// A property's value is a JS expression over its scope's names, compiled once per text, a bare
// #hex reading as text. Reading an unknown value stops it, so the unknown look shows instead.

import { createSignal, getListener, onCleanup } from "solid-js";
import { unwrap } from "solid-js/store";
import { arith } from "../lang/arith.js";
import { isHex, tokens } from "../lang/lex";
import * as rantMath from "rant-math";
import { LIBRARY, setClock } from "../lang/math.js";
import { send } from "../net/connection";
import { Far, packed } from "../net/packed";
import type { Page } from "../protocol/Page";
import { MISSING, OWN_ONLY, TOKEN_FIXED, WHOLE } from "../protocol/rules";
import type { Token } from "../protocol/Token";
import type { Value } from "../protocol/Value";
import type { Variable } from "../protocol/Variable";
import { held, pads } from "./input";
import { mode, setMode } from "./mode";
import { imported, key, members, named, say } from "./names";
import { type From, ranInto } from "./problems";
import { entity, keptValue, live, promise, split, state } from "./store";
import { bare } from "./types";

/** One unit of every length, in CSS pixels: placement, sizes, diagrams, spacing, radii, borders
 *  and type all count in units, a tenth being one pixel. */
export const UNIT = 10;

/** A plain number, which a drag may write over. */
export function isNumber(value: string | undefined): boolean {
  return value !== undefined && /^\s*-?\d+(\.\d+)?\s*$/.test(value);
}

/** True for a plain number of percent, which placement takes as a share of what holds it. */
export function isPercent(value: string | undefined): boolean {
  return value !== undefined && /^\s*-?\d+(\.\d+)?\s*%\s*$/.test(value);
}

/** Placement's x, y, w and h read a trailing % as a share of what holds the element, which no
 *  expression can end in. Gives the expression without it, and whether it had one. */
export function percentOf(value: string | undefined): { expr: string | undefined; percent: boolean } {
  const v = value?.trim();
  return v?.endsWith("%") ? { expr: v.slice(0, -1), percent: true } : { expr: value, percent: false };
}

/** A placement value in pixels. `whole` is the width of what holds the element for x and w,
 *  its height for y and h. */
export function placement(value: string | undefined, whole: number, scope: Scope = pageScope): number {
  const { expr, percent } = percentOf(value);
  const n = number(expr, scope);
  return percent ? (n * whole) / 100 : n;
}

/** An origin's two parts, a pair such as "50% 100%", each a number and whether it is a percent
 *  of the box rather than units. Unset, or not such a pair, is the corner. */
function originParts(value: unknown): { n: number; percent: boolean }[] {
  const [a, b] = typeof value === "string" ? value.trim().split(/\s+/) : [];
  const one = (t: string | undefined) => {
    const n = parseFloat(t ?? "");
    return Number.isFinite(n) ? { n, percent: t!.endsWith("%") } : { n: 0, percent: false };
  };
  return [one(a), one(b)];
}

/** Where an origin puts its point in a box `w` by `h`, from its top left. */
export function originAt(value: unknown, w: number, h: number): { x: number; y: number } {
  const [a, b] = originParts(value).map((p, i) => (p.percent ? (p.n * (i === 0 ? w : h)) / 100 : p.n));
  return { x: a, y: b };
}

/** An origin as CSS lengths, for a box whose size only the page knows. `by` -1 flips them, to
 *  move a box so its origin sits where its corner was. Null at the corner. */
export function originCss(value: unknown, by = 1): [string, string] | null {
  const parts = originParts(value);
  return parts.every((p) => p.n === 0) ? null : (parts.map((p) => (p.percent ? `${p.n * by}%` : `${p.n * by * UNIT}px`)) as [string, string]);
}

/** What w or h may say in place of a size: hug, the size of what the element holds, or fill,
 *  the room its frame leaves it. Words, never expressions, as a trailing % is. */
export type SizeWord = "hug" | "fill";

export function sizeWord(value: string | undefined): SizeWord | undefined {
  const v = value?.trim();
  return v === "hug" || v === "fill" ? v : undefined;
}

/** How a frame lays out what it holds, one after another: toward the right, down, left or up. */
export type Flow = "right" | "down" | "left" | "up";

export const FLOWS: Flow[] = ["right", "down", "left", "up"];

export function flowOf(value: unknown): Flow | undefined {
  return FLOWS.includes(value as Flow) ? (value as Flow) : undefined;
}

/** True when the value reads nothing live: a number, a quoted text, a colour or a word
 *  such as true. */
export function isConstant(value: string | undefined): boolean {
  if (!value || isNumber(value)) return true;
  const v = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) || /^(true|false|null)$/.test(v) || /^"(?:[^"\\]|\\.)*"$/.test(v) || /^'(?:[^'\\]|\\.)*'$/.test(v);
}

class Unknown extends Error {
  constructor(readonly alias: string) {
    super(`${alias} is unknown`);
  }
}

export type Resolved =
  | { ok: true; value: unknown }
  | { ok: false; unknown: string; error?: undefined }
  | { ok: false; error: string; unknown?: undefined };

/** The names an expression may read. Others (Math, Number) fall through to the browser's. */
export interface Scope {
  has(name: string): boolean;
  /** The value now. It throws for one that is unknown. */
  get(name: string): unknown;
  /** Writes a name, or a field of it along `path`, or throws why it cannot. An object's path
   *  starts with the member. */
  set(name: string, path: string, value: unknown): void;
  /** True when `set` may write the name, or its field along `path`. */
  writes(name: string, path?: string): boolean;
  /** What to say of a name it does not have. */
  missing(name: string): string;
  /** Where it reads state, on a page. */
  place?: Place;
  /** The nearest state called `name`, unless a nearer name hides it. */
  state?(name: string): Variable | undefined;
}

/** Where a scope reads state: its page, and the index of each copy of a repeat it sits in,
 *  outermost first, as each copy keeps its own. */
export interface Place {
  page: string;
  copies: number[];
}

/** A theme token by the name code gives it, `$accent`. */
function token(name: string) {
  return name.startsWith("$") ? state.tokens.find((t) => `$${t.name}` === name) : undefined;
}

/** The tokens being worked out, outermost first, so one that reads itself stops, and the mode
 *  they are worked out in. */
const working: string[] = [];
let workingMode: "dark" | "light" | null = null;

/** What a token reads: other tokens and the math, never a value from the mesh. */
export const tokenScope: Scope = {
  has: (name) => token(name) !== undefined,
  get: (name) => tokenValue(token(name)!),
  set: () => {
    throw new TypeError("a token only reads");
  },
  writes: () => false,
  missing: (name) => (name.startsWith("$") ? `${name} is no token` : `a token reads only other tokens and the math, not ${name}`),
};

/** A token's value in `m`, the screen's mode unless given: its expression worked out. An empty
 *  light value is the dark one. */
export function tokenValue(t: Token, m: "dark" | "light" = workingMode ?? (mode() === "light" ? "light" : "dark")): unknown {
  if (working.includes(t.name)) throw new TypeError(`$${t.name} reads itself, through ${[...working.slice(working.indexOf(t.name)), t.name].map((n) => `$${n}`).join(" to ")}`);
  const [outer, outerMode] = [working.length, workingMode];
  working.push(t.name);
  workingMode = m;
  try {
    const r = resolve(m === "light" && t.light.trim() ? t.light : t.dark, tokenScope);
    if (!r.ok) throw new TypeError(r.unknown ? `$${t.name} reads ${r.unknown}, which is unknown` : r.error);
    return r.value;
  } finally {
    working.length = outer;
    workingMode = outerMode;
  }
}

/** The screen's link to the system. Each field reads the store, so what shows one follows it,
 *  and the ping is whole ms, as the status bar shows it. */
const link = Object.freeze({
  get open() {
    return state.link === "open";
  },
  get webrtc() {
    return state.webrtc;
  },
  get path() {
    return state.path;
  },
  get pingMs() {
    return state.rttMs === null ? null : Math.round(state.rttMs);
  },
});

/** The keys held now, each true by what it types, as keys.a, or where it sits, as keys.KeyA. */
const keys = new Proxy({}, { get: (_, name) => typeof name === "string" && held.read().has(name) });

/** The screen's mode, which its handlers may change. */
const theme = Object.freeze({
  get mode() {
    return mode();
  },
  set: (m: unknown) => {
    if (m !== "dark" && m !== "light" && m !== "device") throw new TypeError(`theme.set takes "dark", "light" or "device", not ${JSON.stringify(m)}`);
    setMode(m);
  },
  toggle: () => setMode(mode() === "dark" ? "light" : "dark"),
});

/** What code on a screen reads of the screen itself, which only reads but for its mode. */
const SCREEN: Record<string, unknown> = {
  link,
  keys,
  theme,
  get gamepads() {
    return pads.read();
  },
};

/** A scope as a screen works it out: it also reads the theme's tokens, in the screen's mode,
 *  and the screen's own names, under any of the scope's own. */
function onScreen(s: Scope): Scope {
  const screen = (name: string) => Object.hasOwn(SCREEN, name) && !s.has(name);
  return {
    has: (name) => token(name) !== undefined || s.has(name) || screen(name),
    get: (name) => {
      const t = token(name);
      return t ? tokenValue(t) : screen(name) ? SCREEN[name] : s.get(name);
    },
    set: (name, path, value) => {
      if (token(name)) throw new TypeError(say(TOKEN_FIXED, name));
      if (screen(name)) throw new TypeError(`${name} is the screen's, so it cannot be set`);
      s.set(name, path, value);
    },
    writes: (name, path) => !token(name) && !screen(name) && s.writes(name, path),
    missing: (name) => s.missing(name),
  };
}

/** Whether what is worked out now is a media source, in which an import stands for itself. */
let sourcing = false;

const ALIAS = Symbol("alias");
const itselves = new Map<string, object>();

/** Whether an import's values are structs, as a camera's frames are, once its type is known. */
function structs(alias: string): boolean {
  const imp = imported(alias);
  const fields = imp && entity(imp.entity)?.schema?.fields;
  return !!fields && !bare(fields);
}

/** An import as itself: reading a field of it reads its value now, so `Camera.width` reads as
 *  anywhere else, but passing it on reads nothing. */
function itself(alias: string): object {
  let it = itselves.get(alias);
  if (!it) {
    const now = (): object => {
      const v = live(alias);
      if (!v.known) throw new Unknown(alias);
      return Object(v.value);
    };
    it = new Proxy(
      {},
      {
        get: (_, key) => (key === ALIAS ? alias : Reflect.get(now(), key)),
        has: (_, key) => key === ALIAS || Reflect.has(now(), key),
        ownKeys: () => Reflect.ownKeys(now()),
        getOwnPropertyDescriptor: (_, key) => {
          const d = Reflect.getOwnPropertyDescriptor(now(), key);
          return d && { ...d, configurable: true };
        },
      },
    );
    itselves.set(alias, it);
  }
  return it;
}

/** The import a media source gave as itself, else null. */
export function sourceOf(v: unknown): string | null {
  return typeof v === "object" && v !== null ? ((v as { [ALIAS]?: string })[ALIAS] ?? null) : null;
}

/** A member's value now, as code outside its object reads it by its key. */
function member(k: string): unknown {
  const n = named(k);
  if (!n || n.of === "object") throw new ReferenceError(say(MISSING, k));
  if (n.local) throw new TypeError(say(OWN_ONLY, k));
  if (sourcing && structs(k)) return itself(k);
  const v = live(k);
  if (!v.known) throw new Unknown(k);
  return v.value;
}

const SPACE = Symbol("object");
const spaces = new Map<string, object>();

/** An object as code outside it reads it: each Global member live by its key, as `Line.Speed`. */
function space(object: string): object {
  let s = spaces.get(object);
  if (!s) {
    const shown = (m: string | symbol) => typeof m === "string" && named(key(object, m))?.local === false;
    s = new Proxy(
      {},
      {
        get: (_, m) => (m === SPACE ? object : typeof m === "string" ? member(key(object, m)) : undefined),
        // what reads an object here only reads, as a handler sets through its own view of it
        set: (_, m) => {
          throw new TypeError(`${key(object, String(m))} cannot be set here, which only reads`);
        },
        has: (_, m) => m === SPACE || shown(m),
        ownKeys: () => members(object).map((n) => split(n.name)[1]),
        getOwnPropertyDescriptor: (_, m) => (shown(m) ? { value: member(key(object, m as string)), enumerable: true, configurable: true } : undefined),
      },
    );
    spaces.set(object, s);
  }
  return s;
}

/** The object a value read as one is, else null. */
function spaceOf(v: unknown): string | null {
  return typeof v === "object" && v !== null ? ((v as { [SPACE]?: string })[SPACE] ?? null) : null;
}

/** Writes the member `k`, or its field along `path`, as code outside its object may. */
function setMember(k: string, path: string, value: unknown) {
  const n = named(k);
  if (!n || n.of === "object") throw new ReferenceError(say(MISSING, k));
  if (n.local) throw new TypeError(say(OWN_ONLY, k));
  if (n.fixed) throw new TypeError(n.fixed);
  if (n.of === "computed" && path !== "") throw new TypeError(say(WHOLE, k));
  // the screen's own shows what it is set to at once, as the system will have it
  if (n.screen) promise(k, withField(live(k).value, path, value) as Value);
  send({ type: "set", alias: k, path, value: value as Value });
}

/** What the system's own expressions read: each object, its Global members live, and the
 *  mesh's enums. It writes those members it may on the backend. */
export const systemScope: Scope = {
  has: (name) => named(name)?.of === "object" || named(name)?.of === "enum",
  get: (name) => {
    // its options a fresh list at each read, as a value's are
    if (named(name)?.of === "enum") return { options: [...(state.enums.find((e) => e.name === name)?.options ?? [])] };
    if (named(name)?.of !== "object") throw new ReferenceError(say(MISSING, name));
    return space(name);
  },
  set: (name, path, value) => {
    const n = named(name);
    if (n?.of === "enum") throw new TypeError(n.fixed);
    if (n?.of !== "object") throw new ReferenceError(systemScope.missing(name));
    const [m, ...fields] = path.split(".");
    if (!m) throw new TypeError(`${name} is an object, so code sets its members, not it`);
    setMember(key(name, m), fields.join("."), value);
  },
  writes: (name, path = "") => {
    if (named(name)?.of !== "object") return false;
    const [m, ...fields] = path.split(".");
    const n = named(key(name, m));
    return !!n && n.of !== "object" && !n.local && !n.fixed && !(n.of === "computed" && fields.length > 0);
  },
  missing: (name) => say(MISSING, name),
};

/** What an object's own expressions read: its members bare, Local ones too, nearer than what
 *  the system reads. The editor works them out to check them, and writes none. */
export function objectScope(object: string): Scope {
  const mine = (name: string) => {
    const n = named(key(object, name));
    return n && n.of !== "object" ? n : undefined;
  };
  return {
    has: (name) => !!mine(name) || systemScope.has(name),
    get: (name) => {
      if (!mine(name)) return systemScope.get(name);
      const v = live(key(object, name));
      if (!v.known) throw new Unknown(key(object, name));
      return v.value;
    },
    set: (name) => {
      throw new TypeError(`only the system writes ${name}`);
    },
    writes: () => false,
    missing: systemScope.missing,
  };
}

/** `whole` with its field at `path`, as `a.b`, made `value`, or `value` for no path. */
function withField(whole: unknown, path: string, value: unknown): unknown {
  if (path === "") return value;
  const [head, ...rest] = path.split(".");
  const at = (whole && typeof whole === "object" ? whole : {}) as Record<string, unknown>;
  const inner = withField(at[head], rest.join("."), value);
  return Array.isArray(at) ? at.map((v, i) => (i === Number(head) ? inner : v)) : { ...at, [head]: inner };
}

/** A page reads what the system does, and what a screen reads of its own. */
export const pageScope: Scope = onScreen(systemScope);

/** A bare name and the fields after it, as a two way binding is written: `Settings.target`. */
const BARE = /^\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*$/;

/** The name and fields of a value written as a bare name, else null. */
export function bareRef(value: string | undefined): { name: string; fields: string } | null {
  const ref = BARE.exec(value ?? "");
  return ref ? { name: ref[1], fields: ref[2].slice(1) } : null;
}

/** What an input's default and a variable's start read: the theme's tokens and the math, the
 *  same on every screen and instance. */
const constants: Scope = { ...tokenScope, missing: (name) => `${name} cannot be read here, only the theme's tokens` };

/** What an instance shows of its own while held, over what its bindings say. */
export interface Own {
  has(input: string): boolean;
  get(input: string): unknown;
  set(input: string, value: unknown): void;
}

/** A part's pointer state, as a component's code reads `root.pressed` or `knob.heldFor`. */
export interface PartState {
  pressed: boolean;
  hovered: boolean;
  /** How long it has been pressed, in ms, 0 while it is not. */
  heldFor: number;
}

const STILL: PartState = { pressed: false, hovered: false, heldFor: 0 };

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The names a component's code reads its parts by: `root` for the whole, and each element
 *  named as a name in code can be. */
export function partNames(c: Page): string[] {
  const out = new Set(["root"]);
  const walk = (elements: Page["children"]) => {
    for (const e of elements) {
      if (IDENT.test(e.props.name ?? "")) out.add(e.props.name!);
      walk(e.children);
    }
  };
  walk(c.children);
  return [...out];
}

/** What an instance keeps of its own on this screen: its variables, and its parts' pointer
 *  state. A component drawn on its own keeps none, so it shows its variables' starts. */
export interface Kept {
  /** A variable set by its code, undefined while it is at its start. */
  get(name: string): unknown;
  set(name: string, path: string, value: unknown): void;
  part(name: string): PartState;
}

/** A component reads its inputs, its variables and its parts' pointer state, and nothing of
 *  the mesh. An input is what the instance gives, read where the instance sits, else its
 *  default, unless the instance shows its own. */
export function componentScope(c: Page, instance?: { props: Record<string, string | undefined>; outer: Scope; own?: Own; kept?: Kept }): Scope {
  const input = (name: string) => c.interface?.inputs.find((i) => i.name === name);
  const variable = (name: string) => c.interface?.variables.find((v) => v.name === name);
  const part = (name: string) => !input(name) && !variable(name) && partNames(c).includes(name);
  const read = (r: Resolved, name: string) => {
    if (r.ok) return r.value;
    if (r.unknown) throw new Unknown(r.unknown);
    throw new Error(`${name}: ${r.error}`);
  };
  return onScreen({
    has: (name) => input(name) !== undefined || variable(name) !== undefined || part(name),
    get: (name) => {
      const v = variable(name);
      if (v) return instance?.kept?.get(name) ?? read(resolve(v.start, constants), name);
      if (!input(name)) return instance?.kept?.part(name) ?? STILL;
      if (instance?.own?.has(name)) return instance.own.get(name);
      const given = instance?.props[name];
      return read(given !== undefined ? resolve(given, instance!.outer) : resolve(input(name)!.default, constants), name);
    },
    // a write goes through the instance's binding when that is a bare name, and is dropped
    // otherwise, so a control bound one way reads as a display
    set: (name, path, value) => {
      if (variable(name)) return instance?.kept?.set(name, path, value);
      if (part(name)) throw new TypeError(`${name} is the pointer's, so it cannot be set`);
      if (!input(name)?.bindable) throw new TypeError(`${name} is not two way`);
      if (!path) instance?.own?.set(name, value);
      const ref = bareRef(instance?.props[name]);
      if (!ref || !instance) return;
      instance.outer.set(ref.name, [ref.fields, path].filter(Boolean).join("."), value);
    },
    writes: (name) => {
      if (variable(name)) return true;
      const ref = bareRef(instance?.props[name]);
      return !!input(name)?.bindable && !!ref && !!instance?.outer.writes(ref.name, ref.fields);
    },
    missing: (name) => `${name} is no input, variable or part of ${c.name}`,
  });
}

/** The copy of a repeated element: its index from 0 and the item it shows. */
export interface At {
  index: number;
  item: unknown;
}

/** A copy's scope: what holds it reads, and `index` and `item` too. */
export function repeatScope(s: Scope, index: number, item: () => unknown): Scope {
  const own = (name: string) => name === "index" || name === "item";
  return {
    has: (name) => own(name) || s.has(name),
    get: (name) => (name === "index" ? index : name === "item" ? item() : s.get(name)),
    set: (name, path, value) => {
      if (own(name)) throw new TypeError(`${name} is the repeat's, so it cannot be set`);
      s.set(name, path, value);
    },
    writes: (name, path) => !own(name) && s.writes(name, path),
    missing: (name) => s.missing(name),
    place: s.place && { page: s.place.page, copies: [...s.place.copies, index] },
    state: s.state,
  };
}

/** The key the system keeps state under, as the backend makes it: `@page/name` for a page's,
 *  `@page/element/name` for an element's, then `#index` for each copy it sits in. */
export function stateKey(place: Place, holder: string | null, name: string): string {
  return `@${place.page}/${holder === null ? "" : `${holder}/`}${name}${place.copies.map((i) => `#${i}`).join("")}`;
}

/** State `v` as kept under `key`: what was written, else its start. */
export const keptOf = (key: string, v: Variable) => keptValue(key) ?? v.start;

/** Writes state `v` kept under `key`, or its field along `path`. One kept each screen shows
 *  this screen's write at once, as the system will have it. */
export function setKept(key: string, v: Variable, path: string, value: unknown) {
  if (v.per === "screen") promise(key, withField(keptOf(key, v), path, value) as Value);
  send({ type: "set", alias: key, path, value: value as Value });
}

/** What a page, or its element `holder`, keeps, read over what `outer` has. A value reads its
 *  start until it is written. */
export function stateScope(outer: Scope, holder: string | null, kept: Variable[]): Scope {
  const place = outer.place;
  if (!place || kept.length === 0) return outer;
  const own = (name: string) => kept.find((v) => v.name === name);
  return {
    has: (name) => !!own(name) || outer.has(name),
    get: (name) => {
      const v = own(name);
      return v ? keptOf(stateKey(place, holder, name), v) : outer.get(name);
    },
    set: (name, path, value) => {
      const v = own(name);
      if (!v) return outer.set(name, path, value);
      setKept(stateKey(place, holder, name), v, path, value);
    },
    writes: (name, path) => !!own(name) || outer.writes(name, path),
    missing: (name) => outer.missing(name),
    place,
    state: (name) => own(name) ?? outer.state?.(name),
  };
}

/** The scope a page or component is drawn and edited in: a page's reads what it keeps. */
export function docScope(doc: Page): Scope {
  return doc.interface ? componentScope(doc) : stateScope({ ...pageScope, place: { page: doc.id, copies: [] } }, null, doc.state);
}

const proxies = new WeakMap<Scope, object>();

/** The scope as `with` reads it. A math helper's `__` name is never the scope's, which spares
 *  every operator a look through it. */
function proxy(s: Scope): object {
  let p = proxies.get(s);
  if (!p) {
    p = new Proxy({}, { has: (_, key) => typeof key === "string" && !key.startsWith("__") && s.has(key), get: (_, key) => (typeof key === "string" ? s.get(key) : undefined) });
    proxies.set(s, p);
  }
  return p;
}

// `time.now` as drawn: one stamp a frame for every value that shows it, moving only while one
// does. Code that runs once, as a handler, reads the clock itself.
const [frameTime, setFrameTime] = createSignal(Date.now());
let readers = 0;
let frame = 0;
function tick() {
  setFrameTime(Date.now());
  frame = readers > 0 ? requestAnimationFrame(tick) : 0;
}
setClock(() => {
  if (!getListener()) return Date.now();
  readers++;
  onCleanup(() => readers--);
  if (!frame) frame = requestAnimationFrame(tick);
  return frameTime();
});

LIBRARY.math = rantMath;

// The math library's names come in as the compiled function's parameters, under the scope's own
const MATH_NAMES = Object.keys(LIBRARY);
const MATH = Object.values(LIBRARY);

/** The ms spent making code into functions so far, which never counts as time the code took. */
let making = 0;
export const makingMs = () => making;

/** `code` in the `body` it wraps it in, as a function of the scope with math's arithmetic and
 *  names, or why it does not compile, made once and kept in `kept`. Code says on which line,
 *  past the `lines` the body adds before it. */
function make<T>(kept: Map<string, T | string>, code: string, body: (code: string) => string, lines?: number): T | string {
  let fn = kept.get(code);
  if (fn !== undefined) return fn;
  const start = performance.now();
  try {
    fn = new Function("scope", ...MATH_NAMES, arith(body(code), lines)) as T;
  } catch (e) {
    fn = (e as Error).message ?? String(e);
  }
  making += performance.now() - start;
  kept.set(code, fn);
  return fn;
}

const handlers = new Map<string, ((scope: object, ...math: unknown[]) => Promise<void>) | string>();

/** Runs a handler here on the screen: a component's in its instance's scope, with `emit` and
 *  the inputs, a two way one written back, or a page's that touches only the screen's own.
 *  Any other name is refused, so nothing leaks onto the page. */
export function runHandler(code: string, scope: Scope, emit: ((name: string, payload?: unknown) => void) | undefined, p: unknown, from: From) {
  const fn = make(handlers, code, (c) => `return (async () => { with (scope) {\n${c}\n} })();`, 1);
  if (typeof fn === "string") return ranInto(from, fn, "fault");
  const own: Record<string, unknown> = emit ? { p, emit } : { p };
  // the run reads back what it wrote, as the backend's runs do, before the binding catches up.
  // Each is by its key, a member's `Line.Speed` and its object's name before the dot.
  const written = new Map<string, unknown>();
  const read = (k: string) => {
    const [object, m] = split(k);
    return m ? (scope.get(object) as Record<string, unknown>)[m] : scope.get(k);
  };
  const write = (k: string, value: unknown) => {
    const [object, m] = split(k);
    if (m) scope.set(object, m, value);
    else scope.set(k, "", value);
    written.set(k, value);
  };
  // as on the system, each read is a fresh copy whose fields take assignment by writing the
  // whole back with the field changed, so `jogVel[index] = 1` writes jogVel. What cannot be
  // copied, as the screen's `keys` or a packed list, is read as it is.
  const wrap = (key: string, value: unknown, path: string[] = []): unknown => {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || packed(value)) return value;
    let copy = value;
    try {
      if (path.length === 0) copy = structuredClone(unwrap(value));
    } catch {
      return value;
    }
    return new Proxy(copy, {
      get: (target, k) => (typeof k === "symbol" ? Reflect.get(target, k) : wrap(key, Reflect.get(target, k), [...path, k])),
      set: (target, k, v) => {
        if (typeof k === "symbol") return false;
        write(key, withField(written.has(key) ? written.get(key) : unwrap(read(key)), [...path, k].join("."), v));
        return Reflect.set(target, k, v);
      },
    });
  };
  // an object's members read and written each by its key, as names on their own are
  const objectHere = (object: string) =>
    new Proxy(read(object) as object, {
      get: (target, m) => (typeof m !== "string" ? Reflect.get(target, m) : written.has(key(object, m)) ? wrap(key(object, m), written.get(key(object, m))) : wrap(key(object, m), read(key(object, m)))),
      set: (_, m, v) => {
        if (typeof m !== "string") return false;
        write(key(object, m), v);
        return true;
      },
    });
  const names = new Proxy(
    {},
    {
      // every name but the browser's own and math's stays here, so a stray one never becomes a global
      has: (_, key) => typeof key === "string" && (key in own || scope.has(key) || !(key in globalThis || key in LIBRARY)),
      get: (_, key) => {
        if (typeof key !== "string") return undefined;
        if (key in own) return own[key];
        if (written.has(key)) return wrap(key, written.get(key));
        if (!scope.has(key)) throw new ReferenceError(scope.missing(key));
        const v = scope.get(key);
        return spaceOf(v) === key ? objectHere(key) : wrap(key, v);
      },
      set: (_, key, value) => {
        if (typeof key !== "string" || !scope.has(key)) throw new ReferenceError(scope.missing(String(key)));
        write(key, value);
        return true;
      },
    },
  );
  fn(names, ...MATH).catch((e: unknown) => {
    if (e instanceof Unknown) ranInto(from, `stopped, since ${e.alias} is unknown`, "warn");
    else ranInto(from, (e as Error)?.message ?? String(e), "fault");
  });
}

const drawers = new Map<string, ((scope: object, ...math: unknown[]) => void) | string>();

/** Runs a canvas's draw code with `own`, its context and size, over a scope it only reads. Run
 *  in a tracking scope, it follows what the code read, as an expression does. */
export function runDraw(code: string, scope: Scope, own: Record<string, unknown>): Resolved {
  const fn = make(drawers, code, (c) => `with (scope) {\n${c}\n}`, 1);
  if (typeof fn === "string") return { ok: false, error: fn };
  const names = new Proxy(
    {},
    {
      // every name but the browser's own and math's stays here, so a stray one never becomes a global
      has: (_, key) => typeof key === "string" && (key in own || scope.has(key) || !(key in globalThis || key in LIBRARY)),
      get: (_, key) => {
        if (typeof key !== "string") return undefined;
        if (key in own) return own[key];
        if (scope.has(key)) return scope.get(key);
        throw new ReferenceError(scope.missing(key));
      },
      set: (_, key) => {
        const name = String(key);
        throw key in own || scope.has(name) ? new TypeError(`${name} cannot be set while drawing, which only reads`) : new ReferenceError(scope.missing(name));
      },
    },
  );
  try {
    fn(names, ...MATH);
    return { ok: true, value: undefined };
  } catch (e) {
    return failed(e, scope);
  }
}

/** Why code that threw `e` gave nothing: a value unknown yet, or its error in words. */
function failed(e: unknown, scope: Scope): Resolved {
  if (e instanceof Unknown || e instanceof Far) return { ok: false, unknown: e.alias };
  if (e instanceof ReferenceError) return { ok: false, error: e.message.replace(/^(\S+) is not defined$/, (_, name: string) => scope.missing(name)) };
  return { ok: false, error: (e as Error).message ?? String(e) };
}

/** The source with each #hex outside strings and comments made a string. */
export function colours(src: string): string {
  let [out, at] = ["", 0];
  for (const t of tokens(src).filter((t) => t.kind === "literal" && isHex(src.slice(t.start, t.end)))) {
    out += `${src.slice(at, t.start)}"${src.slice(t.start, t.end)}"`;
    at = t.end;
  }
  return out + src.slice(at);
}

const compiled = new Map<string, ((scope: object, ...math: unknown[]) => unknown) | string>();

function compile(src: string): ((scope: object, ...math: unknown[]) => unknown) | string {
  // `with` routes bare names through the scope, which needs sloppy mode, as new Function gives
  return make(compiled, src, (c) => `with (scope) { return (${colours(c)}\n); }`);
}

/** A property's value now. Run inside a memo, it updates when what it reads changes. */
export function resolve(value: string | undefined, scope: Scope = pageScope): Resolved {
  if (value === undefined || value.trim() === "") return { ok: true, value: undefined };
  const fn = compile(value.trim());
  if (typeof fn === "string") return { ok: false, error: fn };
  try {
    return { ok: true, value: fn(proxy(scope), ...MATH) };
  } catch (e) {
    return failed(e, scope);
  }
}

/** A media source's value now, as `resolve` gives it, but an import whose values are structs is
 *  the import itself, bare or passed on, so its video plays and its pictures come only if shown. */
export function resolveSource(value: string | undefined, scope: Scope = pageScope): Resolved {
  const was = sourcing;
  sourcing = true;
  try {
    return resolve(value, scope);
  } finally {
    sourcing = was;
  }
}

/** A placement or size as a number, 0 when it cannot be read. */
export function number(value: string | undefined, scope: Scope = pageScope): number {
  const r = resolve(value, scope);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
