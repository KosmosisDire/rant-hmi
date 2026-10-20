// A property's value is a JS expression over the imported datapoints: 44, "Running",
// Speed.toFixed(1). A bare #hex colour reads as its text. It runs in the browser, compiled once
// per text. Reading a datapoint that is unknown stops it, and the caller shows the unknown
// look instead of a wrong value.

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

// Every name an expression uses that is an import reads that import's live value. Other
// names (Math, Number) fall through to the browser's own.
const scope = new Proxy(
  {},
  {
    has: (_, key) => typeof key === "string" && state.imports.some((i) => i.alias === key),
    get: (_, key) => {
      if (typeof key !== "string") return undefined;
      const v = live(key);
      if (!v.known) throw new Unknown(key);
      return v.value;
    },
  },
);

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
export function resolve(value: string | undefined): Resolved {
  if (value === undefined || value.trim() === "") return { ok: true, value: undefined };
  const fn = compile(value.trim());
  if (typeof fn === "string") return { ok: false, error: fn };
  try {
    return { ok: true, value: fn(scope) };
  } catch (e) {
    if (e instanceof Unknown) return { ok: false, unknown: e.alias };
    if (e instanceof ReferenceError) return { ok: false, error: e.message.replace(/ is not defined$/, " names no datapoint") };
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

/** A placement or size as a number, 0 when it cannot be read. */
export function number(value: string | undefined): number {
  const r = resolve(value);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
