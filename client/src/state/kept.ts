// An import that reads may bring only some fields of its value, named by paths such as
// points.x, as the backend reads them. A field named brings all it holds.

import type { FieldInfo } from "../protocol/FieldInfo";
import type { Import } from "../protocol/Import";
import { entity } from "./store";

/** The paths an import keeps, or nothing for every field. */
type Keep = string[] | null | undefined;

const join = (prefix: string, name: string) => (prefix ? `${prefix}.${name}` : name);

/** Whether a type is one bare value, such as a plain f64, with no fields to choose. */
export function bare(fields: FieldInfo[]): boolean {
  return fields.length === 1 && fields[0].name === "";
}

/** The fields of a type that come to an import keeping `keep`. */
export function keptFields(fields: FieldInfo[], keep: Keep): FieldInfo[] {
  if (!keep || bare(fields)) return fields;
  return fields.flatMap((f) => {
    if (keep.includes(f.name)) return [f];
    const inner = keep.flatMap((k) => (k.startsWith(`${f.name}.`) ? [k.slice(f.name.length + 1)] : []));
    return inner.length > 0 ? [{ ...f, members: keptFields(f.members, inner) }] : [];
  });
}

/** The fields of an import's type that come to it, while its type is known. */
export function importFields(imp: Import): FieldInfo[] | undefined {
  const fields = entity(imp.entity)?.schema?.fields;
  return fields && keptFields(fields, imp.fields);
}

/** The path of each field that holds no others. */
function leaves(fields: FieldInfo[], prefix = ""): string[] {
  return fields.flatMap((f) => (f.members.length > 0 ? leaves(f.members, join(prefix, f.name)) : [join(prefix, f.name)]));
}

const under = (path: string) => (leaf: string) => leaf === path || leaf.startsWith(`${path}.`);

/** How much of the field at `path` comes: all it holds, some or none. */
export function comes(fields: FieldInfo[], keep: Keep, path: string): "all" | "some" | "none" {
  const kept = new Set(leaves(keptFields(fields, keep)));
  const mine = leaves(fields).filter(under(path));
  const n = mine.filter((l) => kept.has(l)).length;
  return n === mine.length ? "all" : n > 0 ? "some" : "none";
}

/** What an import keeps once the field at `path` comes or not, each field by the shortest path
 *  that names all of it, or nothing for every field. */
export function keeping(fields: FieldInfo[], keep: Keep, path: string, on: boolean): string[] | undefined {
  const kept = new Set(leaves(keptFields(fields, keep)));
  for (const l of leaves(fields).filter(under(path))) {
    if (on) kept.add(l);
    else kept.delete(l);
  }
  if (leaves(fields).every((l) => kept.has(l))) return undefined;
  const named = (fs: FieldInfo[], prefix: string): string[] =>
    fs.flatMap((f) => (leaves([f], prefix).every((l) => kept.has(l)) ? [join(prefix, f.name)] : named(f.members, join(prefix, f.name))));
  return named(fields, "");
}
