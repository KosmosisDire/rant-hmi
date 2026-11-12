// What a name in code is, for the card a field shows while the caret or the pointer is on it: its
// kind, its type and value now, and where it is defined, to go there.

import { tokens } from "../lang/lex";
import type { Value } from "../protocol/Value";
import type { Suggestion } from "./complete";
import { key, named } from "./names";
import { live, page as pageOf, split, state } from "./store";
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

/** The value at `fields` inside `v`. */
const into = (v: unknown, fields: string[]) => fields.reduce<unknown>((at, f) => (at && typeof at === "object" ? (at as Record<string, unknown>)[f] : undefined), v) as Value | null;

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
  const local = names.find((s) => s.label === head);
  if (local) {
    const d = local.defined;
    return {
      name: path.join("."),
      kind: rest.length > 0 ? "field" : d ? "state" : local.icon === "local" ? "name" : local.icon,
      type: local.type,
      value: rest.length > 0 ? undefined : local.value,
      known: local.known,
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
      type: fields.length > 0 ? undefined : n.words,
      value: now ? into(now.value, fields) : undefined,
      known: now?.known,
      where: `the ${object} object`,
      go: () => openInObjects({ object, member: name }),
    };
  }
  const n = named(head);
  if (!n) return null;
  if (n.of === "object") return { name: head, kind: "object", type: n.words, where: "the Objects tab", go: () => openInObjects({ object: head }) };
  if (n.of === "token") return { name: head, kind: "token", where: "the theme", go: () => openInObjects({ token: head.slice(1) }) };
  return { name: head, kind: n.of, type: n.words };
}
