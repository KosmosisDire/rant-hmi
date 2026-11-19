// What each name code reads is, as types.js reads code: the objects and their members, typed by
// the mesh and with their values now, the theme's tokens, the language's names in each place, and
// names given nearer, as a repeat's item. Completion, call hints and the name card read code here.

import { apiIn, type Name, type Place } from "../lang/api.js";
import { wholeType } from "../lang/math.js";
import { callable, callMethod, type Env, field, fromApi, fromField, fromValue, inferText, list, type Member, membersOf, method, read, record, refined, scope, STRING, type Type, type Typed, typed, UNKNOWN, words } from "../lang/types.js";
import type { EntityInfo } from "../protocol/EntityInfo";
import type { Import } from "../protocol/Import";
import type { TypeInfo } from "../protocol/TypeInfo";
import type { Value } from "../protocol/Value";
import { tokenNow } from "./bind";
import type { Suggestion } from "./complete";
import { bareType, typeLabel } from "./format";
import { imported, key, members, type Named, named, object } from "./names";
import { entity, live, split, state } from "./store";

/** The places that read the theme's tokens: all code a screen works out. */
export const THEMED: Place[] = ["expression", "theme", "component"];

/** Where code is: its place, none for anywhere, the names given there nearest first, `names`
 *  standing for the objects where it is given, and the object whose members it reads bare. */
export interface Where {
  place?: Place;
  names?: Suggestion[];
  also?: Suggestion[];
  own?: string;
}

/** The scope code at `w` reads: names given nearer, the theme's tokens where it reads them, the
 *  language's names, its own object's members bare, then each object and enum. */
export function envOf(w: Where): Env {
  const near = [...(w.also ?? []), ...(w.names ?? [])];
  const api = w.place ? apiIn(w.place) : [];
  return scope((n) => {
    const s = near.find((x) => x.label === n);
    if (s) return fromSuggestion(s);
    if (n.startsWith("$")) return !w.place || THEMED.includes(w.place) ? token(n) : undefined;
    const a = api.find((x) => x.name === n);
    if (a) return language(a, w.place!);
    const mine = w.own === undefined ? undefined : named(key(w.own, n));
    if (mine) return memberTyped(mine, w.place, true);
    if (w.names) return undefined;
    const o = named(n);
    if (o?.of === "object") return whole(n, w.place, n === w.own);
    return o?.of === "enum" ? enumTyped(n) : undefined;
  });
}

const languages = new Map<string, Typed>();

/** One of the language's names as `place` reads it, made once. */
function language(a: Name, place: Place): Typed {
  const k = `${place} ${a.name}`;
  if (!languages.has(k)) languages.set(k, fromApi(a));
  return languages.get(k)!;
}

/** A name given as a suggestion: its value, or what its members offer. */
function fromSuggestion(s: Suggestion): Typed {
  if (!s.members) return typed(UNKNOWN, s.known ? (s.value ?? null) : undefined);
  const now = Object.fromEntries(s.members.filter((m) => m.known).map((m) => [m.label, m.value ?? null]));
  return typed(record([], undefined, s.members.map(asMember)), now);
}

/** A suggestion as a member: a call where it inserts a bracket, else a field of its value's type. */
function asMember(s: Suggestion): Member {
  const calls = s.insert.endsWith("(") || s.insert.endsWith("()");
  const m = calls ? method(s.label, s.insert.endsWith("()") ? [] : ["..."], UNKNOWN, s.type ?? "") : field(s.label, s.known ? fromValue(s.value) : UNKNOWN, s.type ?? "");
  return { ...m, icon: s.icon, insert: s.insert };
}

function token(n: string): Typed | undefined {
  const t = state.tokens.find((x) => `$${x.name}` === n);
  if (!t) return undefined;
  const value = tokenNow(t);
  return typed(UNKNOWN, value === null ? undefined : value);
}

/** An enum: its option names, as a list. */
function enumTyped(n: string): Typed {
  const options = [...(state.enums.find((e) => e.name === n)?.options ?? [])];
  return typed(record([], undefined, [field("options", list(STRING), "its names, a list")]), { options });
}

/** One member as code reads it: its type and a call's inserted bracket, and its value now. */
interface Entry {
  member: Member;
  now?: () => Value | undefined;
}

/** True where code at `place` may call, which only a handler does. */
const calling = (place?: Place) => !place || place === "handler";

/** The member `n` as code at `place` reads it, bare in its own object's code where a call is
 *  awaited, else after its object's name and a dot. Nothing where it could only be called. */
function entry(n: Named, place: Place | undefined, bare: boolean): Entry | undefined {
  const label = split(n.name)[1];
  const calls = n.of === "function" || n.kind === "function" || n.kind === "task";
  if (calls && !calling(place)) return undefined;
  const insert = calls ? (bare ? `await ${label}(` : `${label}(`) : label;
  const now = () => {
    const v = live(n.name);
    return v.known ? v.value : undefined;
  };
  if (n.of === "function") {
    const [o] = split(n.name);
    const f = object(o)?.functions.find((x) => x.name === label);
    return { member: { ...field(label, callable(f?.takes ?? [], UNKNOWN), n.words), icon: "function", insert } };
  }
  if (n.of !== "import") return { member: { ...field(label, UNKNOWN, n.words), icon: "local" }, now };
  const imp = imported(n.name)!;
  const e = entity(imp.entity);
  const schema = e?.schema ?? undefined;
  const shown = schema?.name || bareType(schema?.fields) || n.kind!;
  if (calls) return { member: { ...field(label, meshCall(imp, e), shown), icon: n.kind, insert } };
  let t = schema ? fromField(wholeType(schema)) : UNKNOWN;
  // a handler sends on a topic imported to write, before what its value offers
  if (imp.kind === "topic" && imp.intent === "write" && calling(place)) t = { ...t, own: [send(imp, e), ...(t.own ?? [])] } as Type;
  return { member: { ...field(label, t, shown), icon: n.kind, insert }, now };
}

/** The member `n` as its own object's code reads it bare. */
function memberTyped(n: Named, place: Place | undefined, bare: boolean): Typed | undefined {
  const e = entry(n, place, bare);
  return e && typed(e.member.type!, e.now?.());
}

/** An object as code at `place` reads it: a struct of its members, each with its value now. Its
 *  own code reads its local members too, and `bare` inserts a call awaited. */
export function whole(o: string, place: Place | undefined, own: boolean, bare = false): Typed {
  const entries = members(o, own).flatMap((n) => entry(n, place, bare) ?? []);
  const now = {};
  for (const e of entries) if (e.now) Object.defineProperty(now, e.member.name, { get: e.now, enumerable: true });
  return typed(record([], undefined, entries.map((e) => e.member)), now);
}

const offMesh = (imp: Import) => `its type is not known while ${imp.entity} is off the mesh`;

/** A function or task import as code calls it: its schema's values, a task's progress last, and
 *  its answer. A task offers cancel after a dot. */
function meshCall(imp: Import, e: EntityInfo | undefined): Type {
  if (!e) return callable([], UNKNOWN, { unknown: offMesh(imp) });
  const { params, whole } = e.schema ? takes(e.schema) : { params: [], whole: undefined };
  const task = imp.kind === "task";
  const progress = task ? [{ name: "progress", type: `(${e.progress ? `p: ${typeName(e.progress)}` : ""}) => ...` }] : [];
  const all = [...params, ...progress];
  const p = e.progress ? fromField(wholeType(e.progress)) : UNKNOWN;
  return callable(
    all.map((x) => x.name),
    e.response ? fromField(wholeType(e.response)) : UNKNOWN,
    { params: all, whole, own: task ? [CANCEL] : [], calls: (_, i) => (task && i === all.length - 1 ? [p] : undefined) },
  );
}

const CANCEL: Member = { ...method("cancel", [], UNKNOWN, "stop every call of it"), icon: "api", insert: "cancel()" };

/** A topic's send, which takes its schema's values. */
function send(imp: Import, e: EntityInfo | undefined): Member {
  const sign = e?.schema ? takes(e.schema) : undefined;
  const t = sign ? callable(sign.params.map((x) => x.name), UNKNOWN, sign) : callable([], UNKNOWN, { unknown: offMesh(imp) });
  return { ...field("send", t, "publish a message"), icon: "api", insert: "send(" };
}

/** A type by its name, or a bare type by its one field's. */
function typeName(t: TypeInfo): string {
  return t.name || typeLabel(t.fields[0]);
}

/** A type as values passed one by one: a bare type is one value, a struct its fields. */
function takes(t: TypeInfo): { params: { name: string; type: string }[]; whole?: string } {
  const one = bareType(t.fields);
  if (one) return { params: [{ name: "value", type: one }] };
  return { params: t.fields.map((f) => ({ name: f.name, type: typeLabel(f) })), whole: (t.fields.length > 0 && t.name) || undefined };
}

/** True for a value of fixed size, with no list in it, which a method taking only it works out
 *  at once. A point cloud or an image could take long. */
const fixed = (v: unknown): boolean => !Array.isArray(v) && !ArrayBuffer.isView(v) && (typeof v !== "object" || v === null || Object.values(v).every(fixed));

/** What `x` offers after a dot, as completion lists it: each field with its value now, each
 *  method with its bracket. A method its insert gives all values to previews what it gives. */
export function rows(x: Typed): Suggestion[] {
  x = refined(x);
  return membersOf(x.t).map((m): Suggestion => {
    const icon = (m.icon ?? "member") as Suggestion["icon"];
    if (m.type && m.type.kind !== "function") {
      const r = read(x, m.name);
      return { label: m.name, insert: m.insert ?? m.name, icon, type: m.words || words(r.t), value: r.known ? (r.v as Value) : null, known: r.known };
    }
    const takes = m.type?.kind === "function" ? m.type.takes : (m.takes ?? []);
    const insert = m.insert ?? (takes.length === 0 ? `${m.name}()` : `${m.name}(`);
    const given = /\(([^()]*)\)$/.exec(insert)?.[1];
    const preview =
      !m.type && given !== undefined && x.known && fixed(x.v)
        ? () => {
            const values = given ? ((inferText(`[${given}]`, scope(() => undefined)).v as unknown[] | undefined) ?? []) : [];
            const r = callMethod(x, m.name, values.map((v) => ({ typed: typed(fromValue(v), v), returns: () => undefined })));
            return { value: r.known ? (r.v as Value) : null, known: r.known && r.v !== null };
          }
        : undefined;
    return { label: m.name, insert, icon, type: m.words, preview };
  });
}
