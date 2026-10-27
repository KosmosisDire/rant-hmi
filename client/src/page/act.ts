// Where an element's events go: on a page to the backend's handler, or here when it touches only
// the screen's own, inside an instance to the component's handler here, whose emits climb out
// to the instance. Where a handler runs is never the designer's choice, and it does the same.

import { API, apiIn } from "../lang/api.js";
import { names } from "../lang/lex";
import { send } from "../net/connection";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { type At, pageScope, repeatScope, resolve, runHandler, type Scope } from "../state/bind";
import { endOf, eventInfo, handlerKey, rests, settingsOf, takes } from "../state/events";
import { named } from "../state/names";

export interface Act {
  /** `at` is the copy of a repeated element it happened to, and `only` the one handler a
   *  timed event is for, as a repeat's on its own beat. */
  fire(e: Element, event: string, payload?: unknown, at?: At, only?: Handler): void;
  /** Whether `e`'s handler `h` is heard now, read where it sits, so a watch follows it. */
  hears(e: Element, h: Handler, at?: At): boolean;
}

/** The scope a copy of a repeated element reads, or the one given for any other. */
const within = (scope: Scope, at?: At) => (at ? repeatScope(scope, at.index, () => at.item) : scope);

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

/** Whether a page's handler runs here on the screen: every name in it the system holds is one
 *  of the screen's own variables, a token or an enum, and it names no part of the API only the
 *  system has. One reading a shared value runs there too, so it never reads a stale copy. */
export function runsHere(h: Handler): boolean {
  for (const name of names(h.code)) {
    if (API.some((a) => a.name === name) && !BOTH.has(name)) return false;
    const n = named(name);
    if (n && !(n.screen || n.of === "token" || n.of === "enum")) return false;
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
    fire: (e, event, payload, at, only) => {
      const scope = within(pageScope, at);
      const heard = hearing(e, event, payload, scope, only);
      for (const h of heard.filter(runsHere)) runHandler(h.code, scope, undefined, payload ?? null, { label: `${e.props.name ?? e.id} ${event}`, page, element: e.id });
      const there = heard.filter((h) => !runsHere(h));
      const end = eventInfo(event)?.ends_with === event ? undefined : endOf(event);
      if (there.length > 0 || (end && e.handlers.some((h) => takes(h, end, payload) && (end === event || !runsHere(h))))) {
        send({ type: "fire", page, id: e.id, event, payload: (payload ?? null) as Value, index: at?.index, item: at?.item as Value, heard: there.map((h) => h.filter) });
      }
    },
    hears: (_, h, at) => heard(h, within(pageScope, at)),
  };
}

/** A component's events, run here. `emit` sends one out as the instance's own, from `copy`
 *  when the instance repeats. */
export function componentAct(c: Page, scope: Scope, instance: Element, outer: Act, copy?: At): Act {
  return {
    fire: (e, event, payload, at, only) => {
      const here = within(scope, at);
      const emit = (name: string, sent?: unknown) => outer.fire(instance, String(name), sent, copy);
      for (const h of hearing(e, event, payload, here, only)) runHandler(h.code, here, emit, payload ?? null, { label: `${c.name} ${e.props.name ?? e.id} ${event}`, page: c.id, element: e.id });
    },
    hears: (_, h, at) => heard(h, within(scope, at)),
  };
}
