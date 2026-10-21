// A property's value is a JS expression over its scope's names, compiled once per text, a bare
// #hex reading as text. Reading an unknown value stops it, so the unknown look shows instead.

import { arith } from "../lang/arith.js";
import { LIBRARY } from "../lang/math.js";
import { send } from "../net/connection";
import type { Page } from "../protocol/Page";
import type { Token } from "../protocol/Token";
import type { Value } from "../protocol/Value";
import { mode } from "./mode";
import { live, notify, state } from "./store";

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
  /** Writes a name, or a field of it along `path`, or throws why it cannot. */
  set(name: string, path: string, value: unknown): void;
  /** True when `set` may write the name. */
  writes(name: string): boolean;
  /** What to say of a name it does not have. */
  missing(name: string): string;
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

/** A scope that also reads the theme's tokens, in the screen's mode. */
function themed(s: Scope): Scope {
  return {
    has: (name) => token(name) !== undefined || s.has(name),
    get: (name) => {
      const t = token(name);
      return t ? tokenValue(t) : s.get(name);
    },
    set: (name, path, value) => {
      if (token(name)) throw new TypeError(`${name} is the theme's, so it cannot be set`);
      s.set(name, path, value);
    },
    writes: (name) => !token(name) && s.writes(name),
    missing: (name) => s.missing(name),
  };
}

/** A page reads its mesh imports, variables, records and computed values, live, and writes
 *  those it may on the backend. */
export const pageScope: Scope = themed({
  has: (name) =>
    state.imports.some((i) => i.alias === name) || state.variables.some((v) => v.name === name) || state.records.some((r) => r.name === name) || state.computed.some((c) => c.name === name),
  get: (name) => {
    const v = live(name);
    if (!v.known) throw new Unknown(name);
    return v.value;
  },
  set: (name, path, value) => {
    const imp = state.imports.find((i) => i.alias === name);
    if (imp && (imp.kind !== "variable" || imp.intent !== "write")) throw new TypeError(`${name} cannot be set from here`);
    if (state.records.some((r) => r.name === name)) throw new TypeError(`${name} is a record, which only its source fills`);
    const worked = state.computed.find((c) => c.name === name);
    if (worked && !worked.set) throw new TypeError(`${name} is worked out from other values, and has no setter to write it`);
    if (worked && path !== "") throw new TypeError(`${name} is worked out whole, so it is set whole`);
    if (!imp && !worked && !state.variables.some((v) => v.name === name)) throw new ReferenceError(pageScope.missing(name));
    send({ type: "set", alias: name, path, value: value as Value });
  },
  writes: (name) => {
    const imp = state.imports.find((i) => i.alias === name);
    return imp ? imp.kind === "variable" && imp.intent === "write" : state.variables.some((v) => v.name === name) || state.computed.some((c) => c.name === name && !!c.set);
  },
  missing: (name) => `${name} names no mesh import, variable or record`,
});

/** A bare name and the fields after it, as a two way binding is written: `Settings.target`. */
const BARE = /^\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*$/;

/** The name and fields of a value written as a bare name, else null. */
export function bareRef(value: string | undefined): { name: string; fields: string } | null {
  const ref = BARE.exec(value ?? "");
  return ref ? { name: ref[1], fields: ref[2].slice(1) } : null;
}

const nothing: Scope = { has: () => false, get: () => undefined, set: () => {}, writes: () => false, missing: (name) => `${name} cannot be read here` };

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
  return themed({
    has: (name) => input(name) !== undefined || variable(name) !== undefined || part(name),
    get: (name) => {
      const v = variable(name);
      if (v) return instance?.kept?.get(name) ?? read(resolve(v.start, nothing), name);
      if (!input(name)) return instance?.kept?.part(name) ?? STILL;
      if (instance?.own?.has(name)) return instance.own.get(name);
      const given = instance?.props[name];
      return read(given !== undefined ? resolve(given, instance!.outer) : resolve(input(name)!.default, nothing), name);
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
      return !!input(name)?.bindable && !!ref && !!instance?.outer.writes(ref.name);
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
    writes: (name) => !own(name) && s.writes(name),
    missing: (name) => s.missing(name),
  };
}

/** The scope a page or component is drawn and edited in. */
export function docScope(doc: Page): Scope {
  return doc.interface ? componentScope(doc) : pageScope;
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

// The math library's names come in as the compiled function's parameters, under the scope's own
const MATH_NAMES = Object.keys(LIBRARY);
const MATH = Object.values(LIBRARY);

/** `body` as a function of the scope with math's arithmetic and names, or why it does not
 *  compile. Code says on which line, past the `lines` the body adds before it. */
function make<T>(body: string, lines?: number): T | string {
  try {
    return new Function("scope", ...MATH_NAMES, arith(body, lines)) as T;
  } catch (e) {
    return (e as Error).message ?? String(e);
  }
}

const handlers = new Map<string, ((scope: object, ...math: unknown[]) => Promise<void>) | string>();

/** Runs a component's handler here, in its instance's scope: `p`, `emit` and the inputs, a two
 *  way one written back. Any other name is refused, so nothing leaks onto the page. */
export function runHandler(code: string, scope: Scope, emit: (name: string, payload?: unknown) => void, p: unknown, label: string) {
  let fn = handlers.get(code);
  if (fn === undefined) {
    fn = make<(scope: object, ...math: unknown[]) => Promise<void>>(`return (async () => { with (scope) {\n${code}\n} })();`, 1);
    handlers.set(code, fn);
  }
  if (typeof fn === "string") return notify(`${label}: ${fn}`, "fault");
  const own: Record<string, unknown> = { p, emit };
  // the run reads back what it wrote, as the backend's runs do, before the binding catches up
  const written = new Map<string, unknown>();
  const names = new Proxy(
    {},
    {
      // every name but the browser's own and math's stays here, so a stray one never becomes a global
      has: (_, key) => typeof key === "string" && (key in own || scope.has(key) || !(key in globalThis || key in LIBRARY)),
      get: (_, key) => {
        if (typeof key !== "string") return undefined;
        if (key in own) return own[key];
        if (written.has(key)) return written.get(key);
        if (scope.has(key)) return scope.get(key);
        throw new ReferenceError(scope.missing(key));
      },
      set: (_, key, value) => {
        if (typeof key !== "string" || !scope.has(key)) throw new ReferenceError(scope.missing(String(key)));
        scope.set(key, "", value);
        written.set(key, value);
        return true;
      },
    },
  );
  fn(names, ...MATH).catch((e: unknown) => {
    if (e instanceof Unknown) notify(`${label}: stopped, since ${e.alias} is unknown`, "warn");
    else notify(`${label}: ${(e as Error)?.message ?? String(e)}`, "fault");
  });
}

const HEX = /^#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w$])/i;

/** The source with each #hex outside strings made a string. `nested` stops at the brace
 *  closing a template literal's `${`. */
function colours(src: string, at = 0, nested = false): [string, number] {
  let out = "";
  let depth = 0;
  let i = at;
  while (i < src.length) {
    const c = src[i];
    if (nested && c === "}" && depth-- === 0) return [out, i];
    if (nested && c === "{") depth++;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
        } else if (src.startsWith("${", i)) {
          const [inner, end] = colours(src, i + 2, true);
          out += "${" + inner + "}";
          i = end + 1;
        } else {
          out += src[i++];
        }
      }
      out += "`";
      i++;
    } else if (c === "#" && HEX.test(src.slice(i))) {
      const hex = HEX.exec(src.slice(i))![0];
      out += `"${hex}"`;
      i += hex.length;
    } else {
      out += c;
      i++;
    }
  }
  return [out, i];
}

const compiled = new Map<string, ((scope: object, ...math: unknown[]) => unknown) | string>();

function compile(src: string): ((scope: object, ...math: unknown[]) => unknown) | string {
  let fn = compiled.get(src);
  if (fn === undefined) {
    // `with` routes bare names through the scope, which needs sloppy mode, as new Function gives
    fn = make<(scope: object, ...math: unknown[]) => unknown>(`with (scope) { return (${colours(src)[0]}\n); }`);
    compiled.set(src, fn);
  }
  return fn;
}

/** A property's value now. Run inside a memo, it updates when what it reads changes. */
export function resolve(value: string | undefined, scope: Scope = pageScope): Resolved {
  if (value === undefined || value.trim() === "") return { ok: true, value: undefined };
  const fn = compile(value.trim());
  if (typeof fn === "string") return { ok: false, error: fn };
  try {
    return { ok: true, value: fn(proxy(scope), ...MATH) };
  } catch (e) {
    if (e instanceof Unknown) return { ok: false, unknown: e.alias };
    if (e instanceof ReferenceError) return { ok: false, error: e.message.replace(/^(\S+) is not defined$/, (_, name: string) => scope.missing(name)) };
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

/** A placement or size as a number, 0 when it cannot be read. */
export function number(value: string | undefined, scope: Scope = pageScope): number {
  const r = resolve(value, scope);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
