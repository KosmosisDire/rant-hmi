// A property's value: a literal, or a {expression} in JS over the imported datapoints. An
// expression runs in the browser, compiled once per text. Reading a datapoint that is
// unknown stops it, and the caller shows the unknown look instead of a wrong value.

import { live, state } from "./store";

export function isExpression(value: string | undefined): value is string {
  if (!value) return false;
  const v = value.trim();
  return v.startsWith("{") && v.endsWith("}");
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

const compiled = new Map<string, ((scope: object) => unknown) | string>();

function compile(src: string): ((scope: object) => unknown) | string {
  let fn = compiled.get(src);
  if (fn === undefined) {
    try {
      // `with` routes bare names through the scope, which needs sloppy mode, as new Function gives
      fn = new Function("scope", `with (scope) { return (${src}); }`) as (scope: object) => unknown;
    } catch (e) {
      fn = (e as Error).message;
    }
    compiled.set(src, fn);
  }
  return fn;
}

/** A property's value now. Run inside a memo, it updates when what it reads changes. */
export function resolve(value: string | undefined): Resolved {
  if (!isExpression(value)) return { ok: true, value };
  const fn = compile(value.trim().slice(1, -1));
  if (typeof fn === "string") return { ok: false, error: fn };
  try {
    return { ok: true, value: fn(scope) };
  } catch (e) {
    if (e instanceof Unknown) return { ok: false, unknown: e.alias };
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

/** A placement or size as a number, 0 when it cannot be read. */
export function number(value: string | undefined): number {
  const r = resolve(value);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
