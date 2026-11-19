// What a name in code is, for the card a field shows while the caret or the pointer is on it: its
// kind, its type and value now, and where it is defined, to go there.

import type { Node } from "../lang/arith.js";
import { tokens } from "../lang/lex";
import { infer, reach, type Typed, words } from "../lang/types.js";
import type { Value } from "../protocol/Value";
import { colours, tokenNow } from "./bind";
import type { Suggestion } from "./complete";
import { key, named } from "./names";
import { live, page as pageOf, split, state } from "./store";
import { envOf } from "./typed";
import { openInObjects, openPage } from "./view";

export interface About {
  /** The name as the code writes it, as far as the point. */
  name: string;
  kind: string;
  type?: string;
  value?: Value | null;
  known?: boolean;
  /** Where it is defined, in words, and how to go there. */
  where?: string;
  go?: () => void;
}

/** The name at `at` in `text` with those its dots join before it, none on anything else. */
function pathAt(text: string, at: number): string[] | null {
  const all = tokens(text);
  const n = all.findIndex((t) => t.kind === "word" && t.start <= at && at <= t.end);
  if (n < 0) return null;
  const word = (i: number) => text.slice(all[i].start, all[i].end);
  const path = [word(n)];
  for (let i = n; i >= 2 && word(i - 1) === "." && all[i - 2].kind === "word"; i -= 2) path.unshift(word(i - 2));
  return path;
}

/** What the code up to the end of the word at `at` reads there, as types.js works it out, and
 *  whether its first name is one the code declares. */
function readAt(text: string, at: number, names: Suggestion[], own?: string): { x: Typed; declared: boolean } | null {
  const word = tokens(text).find((t) => t.kind === "word" && t.start <= at && at <= t.end);
  if (!word) return null;
  const src = colours(text.slice(0, word.end));
  const base = envOf({ also: names, own });
  const { path, env } = reach(src, base);
  const n = path.find((x) => (x.type === "MemberExpression" || x.type === "Identifier") && x.end === src.length);
  if (!n) return null;
  let head: Node = n;
  while (head.type === "MemberExpression") head = head.object as Node;
  const name = head.type === "Identifier" ? (head.name as string) : "";
  return { x: infer(n, env), declared: !!name && env.name(name) !== undefined && base.name(name) === undefined };
}

/** A type and a value as the card shows them. */
const shown = (x: Typed | undefined) => ({ type: (x && words(x.t)) || undefined, value: x?.known ? (x.v as Value | null) : undefined, known: x?.known });

/** What the name at `at` in `text` is, reading `names` as the code there does besides the
 *  objects, and an object `own`'s members bare in its own code. None for what names nothing. */
export function about(text: string, at: number, names: Suggestion[] = [], own?: string): About | null {
  const path = pathAt(text, at);
  if (!path || !/^[A-Za-z_$]/.test(path[0])) return null;
  const [head, ...rest] = path;
  if (head === "Pages" && !names.some((s) => s.label === head)) {
    if (rest.length === 0) return { name: head, kind: "pages", type: "each page by name" };
    const id = Object.fromEntries(state.pageKeys)[rest[0]];
    const pg = id ? pageOf(id) : undefined;
    return pg ? { name: `Pages.${rest[0]}`, kind: "page", value: pg.id, known: true, where: `the ${pg.name} page`, go: () => openPage(pg.id, "design") } : null;
  }
  const read = () => readAt(text, at, names, own)?.x;
  const local = names.find((s) => s.label === head);
  if (local) {
    const d = local.defined;
    return {
      name: path.join("."),
      kind: rest.length > 0 ? "field" : d ? "state" : local.icon === "local" ? "name" : local.icon,
      ...(rest.length > 0 ? shown(read()) : { type: local.type, value: local.value, known: local.known }),
      where: d ? `${d.holder === null ? "the page" : "an element of the page"} ${pageOf(d.page)?.name ?? d.page}` : undefined,
      go: d ? () => openInObjects({ page: d.page, holder: d.holder, state: head }) : undefined,
    };
  }
  // a member, of its object's own code bare, else as Object.member
  const member = own !== undefined && named(key(own, head)) ? key(own, head) : rest.length > 0 && named(head)?.of === "object" && named(key(head, rest[0])) ? key(head, rest[0]) : undefined;
  if (member) {
    const n = named(member)!;
    const fields = path.slice(own !== undefined && member === key(own, head) ? 1 : 2);
    const now = n.of === "function" || n.of === "enum" ? undefined : live(member);
    const [object, name] = split(member);
    return {
      name: path.join("."),
      kind: fields.length > 0 ? "field" : n.of === "import" ? `mesh ${n.kind}` : n.of,
      ...(fields.length > 0 ? shown(read()) : { type: n.words, value: now?.value, known: now?.known }),
      where: `the ${object} object`,
      go: () => openInObjects({ object, member: name }),
    };
  }
  const n = named(head);
  if (!n) {
    // a name the code itself declares, as a handler's const
    const r = readAt(text, at, names, own);
    return r?.declared ? { name: path.join("."), kind: rest.length > 0 ? "field" : "name", ...shown(r.x) } : null;
  }
  if (n.of === "object") return { name: head, kind: "object", type: n.words, where: "the Objects tab", go: () => openInObjects({ object: head }) };
  if (n.of === "token") {
    const t = state.tokens.find((x) => `$${x.name}` === head);
    const value = t ? tokenNow(t) : null;
    return { name: head, kind: "token", value, known: value !== null, where: "the theme", go: () => openInObjects({ token: head.slice(1) }) };
  }
  return { name: head, kind: n.of, type: n.words };
}
