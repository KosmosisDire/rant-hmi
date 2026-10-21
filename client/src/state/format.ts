// Values as short text for tables and value boxes.

import type { FieldInfo } from "../protocol/FieldInfo";
import type { Intent } from "../protocol/Intent";
import type { Kind } from "../protocol/Kind";
import type { Value } from "../protocol/Value";

export function number(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  return String(Number(n.toPrecision(4)));
}

/** Text with its first letter a capital, as a row or a button starts. */
export const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** What an import's intent allows, in words: reading is always allowed, and write adds a set
 *  or a send. A function or a task is only ever called. */
export function intentWords(kind: Kind, intent: Intent): string {
  if (kind === "function" || kind === "task") return "call";
  return intent === "read" ? "read only" : `read and ${kind === "topic" ? "send" : "set"}`;
}

/** Whether an import has a read or write intent to choose, as a function or a task has not. */
export const choosesIntent = (kind: Kind) => kind === "variable" || kind === "topic";

/** A struct's fields by name, or null for any other value. */
export function fields(v: Value | null | undefined): { [key in string]?: Value } | null {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : null;
}

/** One line, cut short: the first few elements of a list, the first few fields of a struct. */
export function short(v: Value | null | undefined): string {
  if (v === null || v === undefined) return "no value";
  if (typeof v === "number") return number(v);
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Uint8Array) return `${v.length} bytes`;
  if (Array.isArray(v)) {
    const head = v.slice(0, 4).map(short).join(", ");
    return `[${v.length}] ${head}${v.length > 4 ? ", ..." : ""}`;
  }
  const keys = Object.keys(v);
  const head = keys.slice(0, 3).map((k) => `${k} ${short(v[k])}`);
  return `{ ${head.join(", ")}${keys.length > 3 ? ", ..." : ""} }`;
}

/** The type as a tag says it: f64, string, Pose, f64[], f32[3]. */
export function typeLabel(f: FieldInfo): string {
  if (f.kind === "array") {
    const elem = f.type_name ?? f.elem ?? "?";
    return f.count > 0 ? `${elem}[${f.count}]` : `${elem}[]`;
  }
  if (f.kind === "struct" || f.kind === "enum") return f.type_name ?? f.kind;
  return f.type_name ?? f.kind;
}

export const SCALARS = new Set(["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64", "bool", "string", "enum"]);
export const INTEGERS = new Set(["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"]);
