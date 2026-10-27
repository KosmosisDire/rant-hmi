// What pages read, path by path: each expression's paths as reads.js finds them, followed into
// the components a page holds through their inputs, and into a repeat's copies through `item`.

import { ITEM, type Path, type Reads, reads } from "../lang/reads.js";
import { isPart } from "../page/parts";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import { colours } from "./bind";
import { component } from "./store";

/** What a part's property reads of the value it is given, where not all of it, as the scene's
 *  `positions` and `poseOf` read them. */
const TAKES: Record<string, Path[]> = {
  points: [[ITEM, "x"], [ITEM, "y"], [ITEM, "z"]],
  pose: [["position"], ["orientation"]],
};

/** What each name stands for where code reads it: the path it is another name for, or null for
 *  one whose reads lead nowhere. Other names pass on as they are only on a page, as a component
 *  reads nothing but its own. */
interface Env {
  names: Map<string, Path | null>;
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

/** `path` where `env` holds, or null where it leads nowhere. */
function under(env: Env, path: Path): Path | null {
  const [name, ...rest] = path;
  if (!env.names.has(name)) return env.open ? path : null;
  const at = env.names.get(name);
  return at ? [...at, ...rest] : null;
}

function within(env: Env, more: Record<string, Path | null>): Env {
  return { names: new Map([...env.names, ...Object.entries(more)]), open: env.open };
}

class Collect {
  readonly paths = new Map<string, Path>();
  all = false;

  add(path: Path | null) {
    if (path) this.paths.set(path.join("\u0000"), path);
  }

  /** Reads `src` where `env` holds, and gives the path its value is there, or null. */
  code(src: string | undefined, env: Env, body = false): Path | null {
    if (!src?.trim()) return null;
    const r = readsOf(src, body);
    if (!r) return null;
    if (r.all) this.all = true;
    for (const p of r.paths) this.add(under(env, p));
    return r.value && under(env, r.value);
  }

  elements(list: Element[], env: Env, inside: string[]) {
    for (const e of list) {
      let at = env;
      if (e.props.repeat !== undefined) {
        const items = this.code(e.props.repeat, env);
        // the copies are as many as its items, and each reads its own as `item`
        this.add(items && [...items, "length"]);
        at = within(env, { item: items && [...items, ITEM], index: null });
      }
      const c = e.component ? component(e.component) : undefined;
      const given = new Map<string, Path | null>();
      for (const [key, src] of Object.entries(e.props)) {
        // a media element plays its source's video, which reads none of its values
        if (key === "name" || key === "repeat" || (e.tag === "media" && key === "src")) continue;
        const v = this.code(src, at, key === "draw");
        if (c?.interface?.inputs.some((i) => i.name === key)) given.set(key, v);
        else if (isPart(e.tag) && Object.hasOwn(TAKES, key)) for (const t of TAKES[key]) this.add(v && [...v, ...t]);
        else this.add(v);
      }
      for (const h of e.handlers) {
        for (const src of Object.values(h.attrs)) this.add(this.code(src, at));
        // a page's handler runs on the system, but on the item this screen sends it
        this.code(h.code, at.open ? { names: new Map([["item", at.names.get("item") ?? null]]), open: false } : at, true);
      }
      this.elements(e.children, at, inside);
      if (c) this.component(c, given, inside);
    }
  }

  component(c: Page, given: Map<string, Path | null>, inside: string[]) {
    // one inside itself reads all it is given
    if (inside.includes(c.name)) return given.forEach((v) => this.add(v));
    const env: Env = { names: new Map((c.interface?.inputs ?? []).map((i) => [i.name, given.get(i.name) ?? null])), open: false };
    this.add(this.code(c.fill, env));
    this.elements(c.children, env, [...inside, c.name]);
  }
}

/** The paths `pages` read, each a name and the fields after it, and `all` when one may read any
 *  name. A component on its own reads only its defaults, so nothing. */
export function pathsOf(pages: Page[]): { paths: Path[]; all: boolean } {
  const c = new Collect();
  for (const p of pages) {
    if (p.interface) continue;
    c.add(c.code(p.fill, PAGE));
    c.elements(p.children, PAGE, []);
  }
  return { paths: [...c.paths.values()], all: c.all };
}
