// Where an element's events go: on a page to the backend's handler, or here when it touches only
// the screen's own, inside an instance to the component's handler here, whose emits climb out
// to the instance. Where a handler runs is never the designer's choice, and it does the same.

import { API, apiIn } from "../lang/api.js";
import { heads } from "../lang/lex";
import { send } from "../net/connection";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { resolve, runHandler, type Scope } from "../state/bind";
import { endOf, eventInfo, handlerKey, letsGo, rests, settingsOf, takes } from "../state/events";
import { key, named } from "../state/names";

export interface Act {
  /** `scope` is what the element reads, its copy's in a repeat, and `only` the one handler a
   *  timed event is for, as a repeat's on its own beat. `ending` while a component handles
   *  what lets go, as a release, so what it sends then runs on the system however late. */
  fire(e: Element, event: string, payload: unknown, scope: Scope, only?: Handler, ending?: boolean): void;
  /** Whether `e`'s handler `h` is heard now, read in `scope`, so a watch follows it. */
  hears(e: Element, h: Handler, scope: Scope): boolean;
}

/** Whether `h` is heard now: its `while` is true where it sits, or it has none. One not worked
 *  out yet, or failing, is not. */
function heard(h: Handler, scope: Scope): boolean {
  if (!h.attrs.while) return true;
  const r = resolve(h.attrs.while, scope);
  return r.ok && !!r.value;
}

/** How often a repeat may run at the most, in ms, as the HMI's own timers. */
export const QUICKEST = 50;

/** A handler's number setting, as a time in ms, an expression read in `scope`, its default
 *  where that is no number. */
export function numberOf(h: Handler, setting: string, scope: Scope): number {
  const fallback = Number(settingsOf(h.event).find((s) => s.name === setting)?.default);
  const r = resolve(h.attrs[setting] || String(fallback), scope);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** The element's handlers that take `event` bringing `p` and are heard now in `scope`, or
 *  `only` among them. A stream coming to rest is heard whatever its while, as an end is. */
function hearing(e: Element, event: string, p: unknown, scope: Scope, only?: Handler) {
  const one = only && handlerKey(only.event, only.filter);
  const ends = rests(event, p);
  return e.handlers.filter((h) => takes(h, event, p) && (!one || handlerKey(h.event, h.filter) === one) && (ends || heard(h, scope)));
}

/** What the API has that a page's handler and a component's alike may name. Any other name of
 *  it is the system's alone, or no page handler's, so one naming it runs on the system. */
const BOTH = new Set(apiIn("handler").filter((a) => apiIn("component").includes(a)).map((a) => a.name));

/** Whether a page's handler runs here on the screen: every member it names is a variable each
 *  screen holds its own of, all state it names is kept each screen, and it names no part of
 *  the API only the system has. One reading a shared value runs there too, so it never reads
 *  a stale copy, and one calling an object's function runs it there. */
export function runsHere(h: Handler, scope: Scope): boolean {
  for (const [name, after] of heads(h.code)) {
    const kept = scope.state?.(name);
    if (kept) {
      if (kept.per !== "screen") return false;
      continue;
    }
    if (API.some((a) => a.name === name) && !BOTH.has(name)) return false;
    const n = named(name);
    if (n?.of === "object" && !(after !== undefined && named(key(name, after))?.screen)) return false;
  }
  return true;
}

/** A page's events, the handlers it hears run here when they touch only the screen's own, the
 *  rest sent to the backend. A beginning whose end runs there goes too, as a press with a
 *  release, so the backend knows what a screen holds should the screen be lost, and an end
 *  whenever handled, so it lets go of what its beginning held. A stream that ends itself is
 *  held per handler there, so it goes only to those. */
export function pageAct(page: string): Act {
  return {
    fire: (e, event, payload, scope, only, ending) => {
      const heard = hearing(e, event, payload, scope, only);
      const here = (h: Handler) => runsHere(h, scope);
      for (const h of heard.filter(here)) runHandler(h.code, scope, undefined, payload ?? null, { label: `${e.props.name ?? e.id} ${event}`, page, element: e.id });
      const there = heard.filter((h) => !here(h));
      const end = eventInfo(event)?.ends_with === event ? undefined : endOf(event);
      if (there.length > 0 || (end && e.handlers.some((h) => takes(h, end, payload) && (end === event || !here(h))))) {
        // the copy it happened on, by the index of each copy it sits in, and the nearest's item
        const item = scope.place?.copies.length ? (scope.get("item") as Value) : undefined;
        // when it happened, by the clock the pings give, so the system runs no start that comes late
        send({ type: "fire", page, id: e.id, event, payload: (payload ?? null) as Value, copies: scope.place?.copies ?? [], item, heard: there.map((h) => h.filter), t: performance.now(), ending: !!ending });
      }
    },
    hears: (_, h, scope) => heard(h, scope),
  };
}

/** A component's events, run here. `emit` sends one out as the instance's own, read in `at`,
 *  the scope the instance sits in. */
export function componentAct(c: Page, instance: Element, outer: Act, at: Scope): Act {
  return {
    fire: (e, event, payload, scope, only, ending) => {
      const lets = !!ending || letsGo(event, payload);
      const emit = (name: string, sent?: unknown) => outer.fire(instance, String(name), sent, at, undefined, lets);
      for (const h of hearing(e, event, payload, scope, only)) runHandler(h.code, scope, emit, payload ?? null, { label: `${c.name} ${e.props.name ?? e.id} ${event}`, page: c.id, element: e.id });
    },
    hears: (_, h, scope) => heard(h, scope),
  };
}
