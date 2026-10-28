// What pages read, path by path: each expression's paths as reads.js finds them, followed into
// the components a page holds through their inputs, and into a repeat's copies through `item`.

import { createMemo, createRoot } from "solid-js";
import { ITEM, type Path, type Reads, reads } from "../lang/reads.js";
import { isPart } from "../page/parts";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { colours } from "./bind";
import { fields } from "./format";
import { imported, key, keyOf, members, named } from "./names";
import { brought, component, state, transcoded } from "./store";

/** What a part's property reads of the value it is given, where not all of it, as the scene's
 *  `positions` and `poseOf` read them. */
const TAKES: Record<string, Path[]> = {
  points: [[ITEM, "x"], [ITEM, "y"], [ITEM, "z"]],
  pose: [["position"], ["orientation"]],
};

/** What each name stands for where code reads it: the paths it may be another name for, none
 *  for one whose reads lead nowhere. Other names pass on as they are only on a page, as a
 *  component reads nothing but its own. */
interface Env {
  names: Map<string, Path[]>;
  open: boolean;
}

const PAGE: Env = { names: new Map(), open: true };

const found = new Map<string, Reads | null>();

/** What `src` reads, an expression, or with `body` a handler's or a canvas's code, each text
 *  read once. */
function readsOf(src: string, body: boolean): Reads | null {
  const key = `${body ? "b" : "e"}${src}`;
  let r = found.get(key);
  if (r === undefined) {
    r = reads(body ? src : colours(src.trim()), body);
    // each edit is a new text, so old ones are let go now and then
    if (found.size > 4096) found.clear();
    found.set(key, r);
  }
  return r;
}

/** `path` where `env` holds: each path it may be there, none where it leads nowhere. */
function under(env: Env, path: Path): Path[] {
  const [name, ...rest] = path;
  const at = env.names.get(name);
  if (!at) return env.open ? [path] : [];
  return at.map((p) => [...p, ...rest]);
}

function within(env: Env, more: Record<string, Path[]>): Env {
  return { names: new Map([...env.names, ...Object.entries(more)]), open: env.open };
}

/** The codec of an import's last value, told again only as it changes, as each value of a
 *  video would otherwise have every page's reads worked out again. */
const codecs = new Map<string, () => unknown>();
function codec(alias: string): unknown {
  let c = codecs.get(alias);
  if (!c) codecs.set(alias, (c = createRoot(() => createMemo(() => fields(brought(alias))?.codec))));
  return c();
}

/** Whether media showing `path` plays its video, so reads nothing of its value: an import, bare
 *  as a source gives it, with the Video child the transcoder makes or H264 frames of its own.
 *  Another shows its pictures, so reads all of them. */
function plays(path: Path): boolean {
  const to = keyOf(path);
  const imp = to?.rest.length === 0 ? imported(to.key) : undefined;
  return !!imp && (transcoded(imp) || codec(imp.alias) === "H264");
}

/** A path as the backend follows it, from a member's key: `Line.Speed.x` is the key `Line.Speed`
 *  and x. An object read whole reads each of its Global members whole. */
function keyed(path: Path): Path[] {
  const [root, member] = path;
  if (named(root)?.of !== "object") return [path];
  if (member === undefined || member === ITEM) return members(root).map((n) => [n.name]);
  return [[key(root, member), ...path.slice(2)]];
}

class Collect {
  readonly paths = new Map<string, Path>();
  all = false;

  add(...paths: Path[]) {
    for (const p of paths) this.paths.set(p.join("\u0000"), p);
  }

  /** Reads `src` where `env` holds, and gives each path its value may be there. */
  code(src: string | undefined, env: Env, body = false): Path[] {
    if (!src?.trim()) return [];
    const r = readsOf(src, body);
    if (!r) return [];
    if (r.all) this.all = true;
    for (const p of r.paths) this.add(...under(env, p));
    return r.values.flatMap((v) => under(env, v));
  }

  elements(list: Element[], env: Env, inside: string[]) {
    for (const e of list) {
      let at = env;
      if (e.props.repeat !== undefined) {
        const items = this.code(e.props.repeat, env);
        // the copies are as many as its items, and each reads its own as `item`
        this.add(...items.map((p) => [...p, "length"]));
        at = within(env, { item: items.map((p) => [...p, ITEM]), index: [] });
      }
      const c = e.component ? component(e.component) : undefined;
      const given = new Map<string, Path[]>();
      for (const [key, src] of Object.entries(e.props)) {
        if (key === "name" || key === "repeat") continue;
        const v = this.code(src, at, key === "draw");
        if (c?.interface?.inputs.some((i) => i.name === key)) given.set(key, v);
        else if (e.tag === "media" && key === "src") this.add(...v.filter((p) => !plays(p)));
        else if (isPart(e.tag) && Object.hasOwn(TAKES, key)) for (const t of TAKES[key]) this.add(...v.map((p) => [...p, ...t]));
        else this.add(...v);
      }
      for (const h of e.handlers) {
        for (const src of Object.values(h.attrs)) this.add(...this.code(src, at));
        // a page's handler runs on the system, but on the item this screen sends it
        this.code(h.code, at.open ? { names: new Map([["item", at.names.get("item") ?? []]]), open: false } : at, true);
      }
      this.elements(e.children, at, inside);
      if (c) this.component(c, given, inside);
    }
  }

  component(c: Page, given: Map<string, Path[]>, inside: string[]) {
    // one inside itself reads all it is given
    if (inside.includes(c.name)) return given.forEach((v) => this.add(...v));
    const env: Env = { names: new Map((c.interface?.inputs ?? []).map((i) => [i.name, given.get(i.name) ?? []])), open: false };
    this.add(...this.code(c.fill, env));
    this.elements(c.children, env, [...inside, c.name]);
  }
}

/** What each page reads of the member `name`, by its key, the steps after it of each path, for
 *  those that read it. */
export function pagesReading(name: string): { page: Page; paths: Path[] }[] {
  return state.pages.flatMap((page) => {
    const { paths, all } = pathsOf([page]);
    const of = all ? [[]] : paths.filter((p) => p[0] === name).map((p) => p.slice(1));
    return of.length > 0 ? [{ page, paths: of }] : [];
  });
}

/** Whether reading `path` reads some of the field at `field`, both the steps after a name: one
 *  holds the other. */
export function touches(path: Path, field: Path): boolean {
  for (let i = 0; i < Math.min(path.length, field.length); i++) if (path[i] !== field[i]) return false;
  return true;
}

/** The paths `pages` read, each a member's key or another name and the fields after it, and
 *  `all` when one may read any name. A component on its own reads only its defaults, so nothing. */
export function pathsOf(pages: Page[]): { paths: Path[]; all: boolean } {
  const c = new Collect();
  for (const p of pages) {
    if (p.interface) continue;
    c.add(...c.code(p.fill, PAGE));
    c.elements(p.children, PAGE, []);
  }
  const out = new Collect();
  for (const p of c.paths.values()) out.add(...keyed(p));
  return { paths: [...out.paths.values()], all: c.all };
}
