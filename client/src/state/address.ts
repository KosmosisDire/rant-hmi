// The operator's address: the page open, then what each view that navigates shows, by the rule
// in docs/design/views.md, so a screen in that state can be shared, and each change is a step
// the browser's Back undoes. A view navigates when its page is a bare name of state kept each
// screen, outside any repeat.

import { batch, createEffect } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { Variable } from "../protocol/Variable";
import { bareRef, isUrl, keptOf, setKept, stateKey, viaView } from "./bind";
import { record, recorded, stack } from "./stack";
import { notify, page } from "./store";

/** A view that navigates, and the state it shows the page of: its page's, or an element's. */
interface Nav {
  view: Element;
  holder: string | null;
  v: Variable;
}

/** The views of `p` that navigate, in its order. */
export function navViews(p: Page): Nav[] {
  const out: Nav[] = [];
  const walk = (elements: Element[], seen: { holder: string | null; v: Variable }[]) => {
    for (const e of elements) {
      if (e.props.repeat?.trim()) continue;
      const here = [...e.state.map((v) => ({ holder: e.id, v })), ...seen];
      const ref = e.tag === "view" ? bareRef(e.props.page) : null;
      const kept = ref && !ref.fields ? here.find((h) => h.v.name === ref.name) : undefined;
      if (kept?.v.per === "screen") out.push({ view: e, ...kept });
      walk(e.children, here);
    }
  };
  walk(p.children, p.state.map((v) => ({ holder: null, v })));
  return out;
}

/** Where the full page `p`, shown through `via`, keeps what its view `n` shows. */
const keyOf = (n: Nav, via: string, p: string) => stateKey({ via, page: p, copies: [] }, n.holder, n.v.name);

/** The page a view shows now, null for none it can show. */
function showing(n: Nav, key: string): string | null {
  const id = keptOf(key, n.v);
  return typeof id === "string" && page(id) && !page(id)!.interface ? id : null;
}

/** The web page a view shows now, which the history keeps but the address leaves out. */
function web(n: Nav, key: string): string | null {
  const url = keptOf(key, n.v);
  return typeof url === "string" && isUrl(url) ? url : null;
}

/** A view's name as the address writes it: small letters, `-` for a space. */
const word = (n: Nav) => (n.view.props.name ?? n.view.id).trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");

/** Where the pages under page `p` show its views from. */
const inside = (n: Nav, via: string, p: string) => viaView({ via, page: p, copies: [] }, n.view.id);

/** The page at the bottom of what shows: the top page that covers the screen. */
export function fullAt(pages: (Page | undefined)[]): number {
  let n = pages.length - 1;
  while (n > 0 && pages[n]?.shows !== "full") n--;
  return Math.max(0, n);
}

interface Written {
  path: string[];
  query: [string, string][];
}

/** What the views of page `p` and those under them show: a path while each page has one, a
 *  query by name where a page has several, names further down after their branch's and a dot.
 *  A view showing its start, with nothing changed under it, is left out. Each view's page goes
 *  in `views` by its key. */
function written(p: string, via: string, prefix: string, views: Record<string, string>): Written {
  const shown = page(p);
  const navs = shown ? navViews(shown) : [];
  const parts = navs.map((n) => {
    const key = keyOf(n, via, p);
    const id = showing(n, key);
    const url = id ? null : web(n, key);
    if (url) views[key] = url;
    if (!id) return null;
    views[key] = id;
    const below = written(id, inside(n, via, p), navs.length === 1 ? prefix : `${prefix}${word(n)}.`, views);
    const plain = id === n.v.start && below.path.length === 0 && below.query.length === 0;
    return plain ? null : { name: `${prefix}${word(n)}`, path: [id, ...below.path], query: below.query };
  });
  if (navs.length === 1) return parts[0] ?? { path: [], query: [] };
  return { path: [], query: parts.flatMap((x) => (x ? [[x.name, x.path.join("/")] as [string, string], ...x.query] : [])) };
}

/** The address of what shows now, and the page each view that navigates shows, by its key. */
export function address(): { url: string; views: Record<string, string> } {
  const s = stack();
  const base = s[fullAt(s.map((o) => page(o.id)))];
  const views: Record<string, string> = {};
  if (!base) return { url: location.pathname + location.search, views };
  const { path, query } = written(base.id, "", "", views);
  const search = query.map(([k, v]) => `${k}=${v}`).join("&");
  return { url: `/run/${[base.id, ...path].join("/")}${search ? `?${search}` : ""}`, views };
}

/** Sets the view `n` to show the page `id`, unless it shows it already. */
function show(n: Nav, key: string, id: string) {
  if (showing(n, key) !== id) setKept(key, n.v, "", id);
}

/** Sets each view under page `p` that `wants` names a page for, then those under the page it
 *  then shows. `wants` gets the view, its key, its name in a query and the rest of the path. A
 *  web page is taken only from the history, as no address names one. */
function setViews(p: string, via: string, prefix: string, wants: (n: Nav, key: string, name: string, solo: boolean) => { id?: string; rest: string[] }, path: string[] = [], urls = false) {
  const shown = page(p);
  const navs = shown ? navViews(shown) : [];
  for (const n of navs) {
    const key = keyOf(n, via, p);
    const solo = navs.length === 1;
    const name = `${prefix}${word(n)}`;
    const { id, rest } = solo && path.length > 0 ? { id: path[0], rest: path.slice(1) } : wants(n, key, name, solo);
    if (id && page(id) && !page(id)!.interface) show(n, key, id);
    else if (id && urls && isUrl(id)) web(n, key) !== id && setKept(key, n.v, "", id);
    else if (id) notify(`The address names ${id} for the view ${n.view.props.name ?? n.view.id}, which is no page`, "warn");
    const now = showing(n, key);
    if (now) setViews(now, inside(n, via, p), solo ? prefix : `${name}.`, wants, rest, urls);
  }
}

/** Shows again what each view showed at a step of the history, by its key. */
export function showViews(views: Record<string, string>) {
  const base = stack()[fullAt(stack().map((o) => page(o.id)))];
  if (base) setViews(base.id, "", "", (_, key) => ({ id: views[key], rest: [] }), [], true);
}

/** Opens what the address names: its page, else `fallback`, and what each view shows. */
export function openAddress(start: (id: string) => void, fallback: string) {
  const [first, ...path] = location.pathname.replace(/^\/run\/?/, "").split("/").filter(Boolean);
  const named = first && page(first) && !page(first)!.interface ? first : undefined;
  const query = new URLSearchParams(location.search);
  batch(() => {
    start(named ?? fallback);
    if (named) {
      setViews(named, "", "", (_, __, name) => {
        const [id, ...rest] = query.get(name)?.split("/") ?? [];
        return { id, rest };
      }, path);
    }
    record("replace");
  });
}

/** Opens `id` in the view a handler's page is shown through, the last of `via`, when that view
 *  navigates. False when it does not, so the page opens over the screen instead. */
export function openInView(via: string, id: string, replace: boolean): boolean {
  const chunks = via.split(">").filter(Boolean);
  const [outer, rest] = (chunks.at(-1) ?? "").split("/");
  const [viewId, ...copies] = (rest ?? "").split("#");
  const p = page(outer);
  const n = p && copies.length === 0 ? navViews(p).find((x) => x.view.id === viewId) : undefined;
  if (!n) return false;
  batch(() => {
    show(n, keyOf(n, chunks.slice(0, -1).map((c) => `${c}>`).join(""), outer), id);
    if (replace) record("replace");
  });
  return true;
}

/** Makes each change of what the views show a step of the browser's history, as opening a page
 *  is. The operator's screen calls it once. */
export function followViews() {
  createEffect(() => {
    const { views } = address();
    const was = recorded();
    if (was && JSON.stringify(was) !== JSON.stringify(views)) record("push");
  });
}
