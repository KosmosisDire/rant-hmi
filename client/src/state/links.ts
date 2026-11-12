// Where each page leads, from the `Pages.X` its values and handlers name: the pages it shows in a
// view and those it opens, which the board lays out as a graph. Where a page shows or opens one
// by a name worked out as it runs, the element doing it warns, so every link can be found.

import { createMemo, createRoot } from "solid-js";
import { children, type Node, tree } from "../lang/arith.js";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { bareRef, colours, isUrl } from "./bind";
import { page as pageOf, state } from "./store";

/** One page leading to another: shown in a view, or opened. `element` is where it starts on the
 *  page, the view or the element whose handler opens it, when that is known. `by` is every place
 *  on the page that makes it. */
export interface Link {
  from: string;
  to: string;
  kind: "view" | "open";
  element: string | null;
  by: Cause[];
}

/** A place on a page that makes a link: an element and what of it, as a property or a handler,
 *  or with no element a variable's start. */
export interface Cause {
  element: string | null;
  what: string;
}

/** What names a link apart from the others, as the board picks it. */
export const linkKey = (l: { from: string; to: string; kind: string }) => `${l.from}>${l.to}>${l.kind}`;

/** acorn's nodes as this reads them. */
type Ast = Node & { name?: string; value?: unknown; computed?: boolean; object?: Ast; property?: Ast; callee?: Ast; arguments?: Ast[]; left?: Ast; right?: Ast; operator?: string };

const UNLINKED = "by a name worked out as it runs, so the board cannot link it. Name it, as Pages.Camera";

/** The code names of the pages `node` names as `Pages.X` or `Pages["X"]`, each with whether it
 *  is what an `open()` is given. */
function mentions(node: Ast, opened = false, out: { name: string; opened: boolean }[] = []) {
  const p = node.property;
  if (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "Pages" && p) {
    const name = !node.computed && p.type === "Identifier" ? p.name : node.computed && typeof p.value === "string" ? p.value : undefined;
    if (name) out.push({ name, opened });
  }
  const open = isOpen(node);
  for (const c of children(node) as Ast[]) mentions(c, opened || (open && c !== node.callee), out);
  return out;
}

const isOpen = (n: Ast) => n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "open";

/** Whether a page given as `n` can be linked: it names one, or is text, a page's id or a URL. */
const named = (n: Ast) => mentions(n).length > 0 || (n.type === "Literal" && typeof n.value === "string");

/** The page ids text written out in `n` gives, where it is a page's id. */
const written = (n: Ast) => (n.type === "Literal" && typeof n.value === "string" && !isUrl(n.value) && pageOf(n.value) ? [n.value] : []);

/** Why `node` shows or opens a page the board cannot link: an `open()` given a name worked out
 *  as it runs, or a variable a view shows set to one. Page ids written into such a variable are
 *  links too. */
function unlinked(node: Ast, shown: Set<string>, ids: string[], out: string[]) {
  const first = node.arguments?.[0];
  if (isOpen(node) && first && !named(first)) out.push(`open() is given a page ${UNLINKED}`);
  const left = node.left;
  if (node.type === "AssignmentExpression" && left?.type === "Identifier" && left.name && shown.has(left.name) && node.right) {
    if (!named(node.right)) out.push(`${left.name} is set to a page ${UNLINKED}`);
    ids.push(...written(node.right));
  }
  for (const c of children(node) as Ast[]) unlinked(c, shown, ids, out);
}

/** acorn's tree of an expression, or with `body` of a handler's code, none where it does not parse. */
function parsed(src: string, body: boolean): Ast | null {
  try {
    return tree(body ? src : colours(src.trim())) as Ast;
  } catch {
    return null;
  }
}

/** Every element of a page, what each holds after it. */
const flat = (elements: Element[]): Element[] => elements.flatMap((e) => [e, ...flat(e.children)]);

interface Found {
  links: Link[];
  /** Each element's warnings, by its page and id. */
  warnings: Map<string, string[]>;
}

/** Where `p` leads, and what on it cannot be linked. */
function linksOf(p: Page, keys: Record<string, string>, out: Found) {
  const all = flat(p.children);
  const views = all.filter((e) => e.tag === "view");
  // the variables a view shows the page of, whose every setting must name one
  const shown = new Set(
    views.flatMap((v) => {
      const ref = bareRef(v.props.page);
      return ref && !ref.fields ? [ref.name] : [];
    }),
  );
  const add = (to: string | undefined, kind: Link["kind"], element: string | null, cause: Cause) => {
    if (!to || to === p.id || !pageOf(to) || pageOf(to)!.interface) return;
    const had = out.links.find((l) => l.from === p.id && l.to === to && l.kind === kind);
    const link = had ?? out.links[out.links.push({ from: p.id, to, kind, element, by: [] }) - 1];
    // the view a page shows in is a place that makes the link too
    if (kind === "view" && element && element !== cause.element && !link.by.some((c) => c.element === element)) link.by.unshift({ element, what: "shows it" });
    if (!link.by.some((c) => c.element === cause.element && c.what === cause.what)) link.by.push(cause);
  };
  const warn = (e: Element, text: string) => {
    const key = `${p.id}\n${e.id}`;
    out.warnings.set(key, [...new Set([...(out.warnings.get(key) ?? []), text])]);
  };
  for (const v of p.state) if (shown.has(v.name) && typeof v.start === "string") add(v.start, "view", views.find((w) => bareRef(w.props.page)?.name === v.name)?.id ?? null, { element: null, what: `${v.name}, its start` });
  for (const e of all) {
    // a link that is no open() starts at the view it shows in: this one, else the page's only one
    const at = e.tag === "view" ? e.id : views.length === 1 ? views[0].id : null;
    const texts: [string, boolean, string][] = [
      ...Object.entries(e.props)
        .filter(([k]) => k !== "name")
        .map(([k, v]) => [v, false, k] as [string, boolean, string]),
      ...e.handlers.map((h) => [h.code, true, `${h.event} handler`] as [string, boolean, string]),
    ];
    for (const [text, body, what] of texts) {
      const ast = parsed(text, body);
      if (!ast) continue;
      const cause = { element: e.id, what };
      for (const m of mentions(ast)) add(keys[m.name], m.opened ? "open" : "view", m.opened ? e.id : at, cause);
      const problems: string[] = [];
      const ids: string[] = [];
      unlinked(ast, shown, ids, problems);
      for (const id of ids) add(id, "view", at, cause);
      for (const text of problems) warn(e, text);
    }
    const page = e.tag === "view" ? e.props.page : undefined;
    const ref = page === undefined ? null : bareRef(page);
    const ast = page === undefined || ref ? null : parsed(page, false);
    if (ast && !named(ast)) warn(e, `page: it shows a page ${UNLINKED}`);
  }
}

const found = createRoot(() =>
  createMemo(() => {
    const keys = Object.fromEntries(state.pageKeys);
    const out: Found = { links: [], warnings: new Map() };
    for (const p of state.pages) if (p.interface === null) linksOf(p, keys, out);
    return out;
  }),
);

/** Every link between the pages. */
export const links = () => found().links;

/** What an element of a page warns of, as a page it shows or opens that cannot be linked. */
export const linkWarnings = (page: string, element: string) => found().warnings.get(`${page}\n${element}`) ?? [];
