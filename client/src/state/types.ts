// Which values a component's input takes, by the types its `type` names: Rant's type names and
// kinds, number for any number, and [] after any of them for a list.

import type { FieldInfo } from "../protocol/FieldInfo";
import type { Input } from "../protocol/Input";
import type { Page } from "../protocol/Page";
import { TYPE_WORD } from "../protocol/rules";
import type { TypeInfo } from "../protocol/TypeInfo";
import { INTEGERS } from "./format";

const NUMBERS = new Set([...INTEGERS, "f32", "f64"]);

/** What each kind word means, for completion. */
export const KIND_WORDS: [string, string][] = [
  ["number", "any number"],
  ["bool", "true or false"],
  ["string", "text"],
  ["enum", "any enum's option"],
  ["struct", "any struct"],
];

/** Whether text lists types as an input's `type` does: names apart by spaces, or none. */
export const typeList = (text: string) => text.split(/\s+/).every((w) => w === "" || TYPE_WORD.test(w));

/** Every type name a type holds at any depth, its own first. */
export function typesIn(t: TypeInfo): string[] {
  const inside = (fields: FieldInfo[]): string[] => fields.flatMap((f) => [...(f.type_name ? [f.type_name] : []), ...inside(f.members)]);
  return [...(t.name ? [t.name] : []), ...inside(t.fields)];
}

/** Whether a type is one bare value, such as a plain f64, with no fields. */
export function bare(fields: FieldInfo[]): boolean {
  return fields.length === 1 && fields[0].name === "";
}

/** A whole value's type as one field: a bare type's own, else a struct of its fields. */
export function wholeType(t: TypeInfo): FieldInfo {
  return bare(t.fields) ? t.fields[0] : { name: "", kind: "struct", type_name: t.name || null, elem: null, count: 0, options: [], members: t.fields };
}

/** The names a value of this type answers to: its type's name, its kind, number for any
 *  number, and for a list each of its items' names with []. */
export function typeNames(f: FieldInfo): string[] {
  if (f.kind === "array") return typeNames({ ...f, kind: f.elem ?? "unknown", count: 0 }).map((n) => `${n}[]`);
  const own = f.type_name ? [f.type_name] : [];
  if (f.kind === "map" || f.kind === "unknown") return own;
  return [...own, f.kind, ...(NUMBERS.has(f.kind) ? ["number"] : [])];
}

/** Whether an input names a type that a value of type `f` answers to. */
export function takes(input: Input, f: FieldInfo): boolean {
  const names = typeNames(f);
  return input.type.split(" ").some((w) => names.includes(w));
}

/** A component that shows a value, through the first of its inputs that takes it. */
export interface View {
  component: Page;
  input: string;
}

/** The components that show a value of type `f`, one that writes it back only where the
 *  value may be written. */
export function viewsOf(f: FieldInfo, writable: boolean, components: Page[]): View[] {
  return components.flatMap((component) => {
    const i = component.interface?.inputs.find((i) => takes(i, f));
    return i && (writable || !i.bindable) ? [{ component, input: i.name }] : [];
  });
}
