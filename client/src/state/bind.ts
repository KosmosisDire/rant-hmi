// A property's value is a JS expression over the names its scope gives: 44, "Running",
// Speed.toFixed(1). A bare #hex colour reads as its text. It runs in the browser, compiled once
// per text. Reading a value that is unknown stops it, and the caller shows the unknown look
// instead of a wrong value.

import type { Page } from "../protocol/Page";
import { live, state } from "./store";

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
}

/** A page reads its imports and variables, live. */
export const pageScope: Scope = {
  has: (name) => state.imports.some((i) => i.alias === name) || state.variables.some((v) => v.name === name),
  get: (name) => {
    const v = live(name);
    if (!v.known) throw new Unknown(name);
    return v.value;
  },
};

const nothing: Scope = { has: () => false, get: () => undefined };

/** A component reads its inputs and nothing of the mesh. Each is what the instance gives,
 *  read where the instance sits, else the input's default. */
export function componentScope(c: Page, instance?: { props: Record<string, string | undefined>; outer: Scope }): Scope {
  const input = (name: string) => c.interface?.inputs.find((i) => i.name === name);
  return {
    has: (name) => input(name) !== undefined,
    get: (name) => {
      const given = instance?.props[name];
      const r = given !== undefined ? resolve(given, instance!.outer) : resolve(input(name)!.default, nothing);
      if (r.ok) return r.value;
      if (r.unknown) throw new Unknown(r.unknown);
      throw new Error(`${name}: ${r.error}`);
    },
  };
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
