// A property's value is a JS expression over the names its scope gives: 44, "Running",
// Speed.toFixed(1). A bare #hex colour reads as its text. It runs in the browser, compiled once
// per text. Reading a value that is unknown stops it, and the caller shows the unknown look
// instead of a wrong value.

import { send } from "../net/connection";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { mode } from "./mode";
import { live, notify, state } from "./store";

/** A plain number, which a drag may write over. */
export function isNumber(value: string | undefined): boolean {
  return value !== undefined && /^\s*-?\d+(\.\d+)?\s*$/.test(value);
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
}

/** A theme token by the name code gives it, `$accent`. */
function token(name: string) {
  return name.startsWith("$") ? state.tokens.find((t) => `$${t.name}` === name) : undefined;
}

/** A scope that also reads the theme's tokens, in the screen's mode. */
function themed(s: Scope): Scope {
  return {
    has: (name) => token(name) !== undefined || s.has(name),
    get: (name) => {
      const t = token(name);
      return t ? (mode() === "light" ? t.light : t.dark) : s.get(name);
    },
    set: (name, path, value) => {
      if (token(name)) throw new TypeError(`${name} is the theme's, so it cannot be set`);
      s.set(name, path, value);
    },
  };
}

/** A page reads its imports and variables, live, and writes those it may on the backend. */
export const pageScope: Scope = themed({
  has: (name) => state.imports.some((i) => i.alias === name) || state.variables.some((v) => v.name === name),
  get: (name) => {
    const v = live(name);
    if (!v.known) throw new Unknown(name);
    return v.value;
  },
  set: (name, path, value) => {
    const imp = state.imports.find((i) => i.alias === name);
    if (imp && (imp.kind !== "variable" || imp.intent !== "write")) throw new TypeError(`${name} cannot be set from here`);
    if (!imp && !state.variables.some((v) => v.name === name)) throw new ReferenceError(`${name} names no datapoint`);
    send({ type: "set", alias: name, path, value: value as JsonValue });
  },
});

/** A bare name and the fields after it, as a two way binding is written: `Settings.target`. */
const BARE = /^\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*$/;

const nothing: Scope = { has: () => false, get: () => undefined, set: () => {} };

/** What an instance shows of its own while held, over what its bindings say. */
export interface Own {
  has(input: string): boolean;
  get(input: string): unknown;
  set(input: string, value: unknown): void;
}

/** A component reads its inputs and nothing of the mesh. Each is what the instance gives,
 *  read where the instance sits, else the input's default, unless the instance shows its own. */
export function componentScope(c: Page, instance?: { props: Record<string, string | undefined>; outer: Scope; own?: Own }): Scope {
  const input = (name: string) => c.interface?.inputs.find((i) => i.name === name);
  return themed({
    has: (name) => input(name) !== undefined,
    get: (name) => {
      if (instance?.own?.has(name)) return instance.own.get(name);
      const given = instance?.props[name];
      const r = given !== undefined ? resolve(given, instance!.outer) : resolve(input(name)!.default, nothing);
      if (r.ok) return r.value;
      if (r.unknown) throw new Unknown(r.unknown);
      throw new Error(`${name}: ${r.error}`);
    },
    // a write goes through the instance's binding when that is a bare name, and is dropped
    // otherwise, so a control bound one way reads as a display
    set: (name, path, value) => {
      if (!input(name)?.bindable) throw new TypeError(`${name} is not two way`);
      if (!path) instance?.own?.set(name, value);
      const ref = BARE.exec(instance?.props[name] ?? "");
      if (!ref || !instance) return;
      const fields = [ref[2].slice(1), path].filter(Boolean).join(".");
      instance.outer.set(ref[1], fields, value);
    },
  });
}

/** The scope a page or component is drawn and edited in. */
export function docScope(doc: Page): Scope {
  return doc.interface ? componentScope(doc) : pageScope;
}

const proxies = new WeakMap<Scope, object>();

/** The scope as `with` reads it. */
function proxy(s: Scope): object {
  let p = proxies.get(s);
  if (!p) {
    p = new Proxy({}, { has: (_, key) => typeof key === "string" && s.has(key), get: (_, key) => (typeof key === "string" ? s.get(key) : undefined) });
    proxies.set(s, p);
  }
  return p;
}

const handlers = new Map<string, ((scope: object) => Promise<void>) | string>();

/** Runs a component's handler here, in its instance's scope. It reads the inputs, `p` is
 *  what its event brought, `emit` sends one out, and assigning a two way input writes it
 *  back. Any other name is refused, so nothing leaks onto the page. */
export function runHandler(code: string, scope: Scope, emit: (name: string, payload?: unknown) => void, p: unknown, label: string) {
  let fn = handlers.get(code);
  if (fn === undefined) {
    try {
      fn = new Function("scope", `return (async () => { with (scope) {\n${code}\n} })();`) as (scope: object) => Promise<void>;
    } catch (e) {
      fn = (e as Error).message;
    }
    handlers.set(code, fn);
  }
  if (typeof fn === "string") return notify(`${label}: ${fn}`, "fault");
  const own: Record<string, unknown> = { p, emit };
  // the run reads back what it wrote, as the backend's runs do, before the binding catches up
  const written = new Map<string, unknown>();
  const names = new Proxy(
    {},
    {
      // every name but the browser's own stays here, so a stray one never becomes a global
      has: (_, key) => typeof key === "string" && (key in own || scope.has(key) || !(key in globalThis)),
      get: (_, key) => {
        if (typeof key !== "string") return undefined;
        if (key in own) return own[key];
        if (written.has(key)) return written.get(key);
        if (scope.has(key)) return scope.get(key);
        throw new ReferenceError(`${key} names no input`);
      },
      set: (_, key, value) => {
        if (typeof key !== "string" || !scope.has(key)) throw new ReferenceError(`${String(key)} names no input`);
        scope.set(key, "", value);
        written.set(key, value);
        return true;
      },
    },
  );
  fn(names).catch((e: unknown) => {
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

const compiled = new Map<string, ((scope: object) => unknown) | string>();

function compile(src: string): ((scope: object) => unknown) | string {
  let fn = compiled.get(src);
  if (fn === undefined) {
    try {
      // `with` routes bare names through the scope, which needs sloppy mode, as new Function gives
      fn = new Function("scope", `with (scope) { return (${colours(src)[0]}\n); }`) as (scope: object) => unknown;
    } catch (e) {
      fn = (e as Error).message;
    }
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
    return { ok: true, value: fn(proxy(scope)) };
  } catch (e) {
    if (e instanceof Unknown) return { ok: false, unknown: e.alias };
    if (e instanceof ReferenceError) return { ok: false, error: e.message.replace(/ is not defined$/, " names no datapoint") };
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

/** A placement or size as a number, 0 when it cannot be read. */
export function number(value: string | undefined, scope: Scope = pageScope): number {
  const r = resolve(value, scope);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
