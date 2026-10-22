// Where an element's events go: on a page to the backend's handler, inside an instance to the
// component's handler here, whose emits climb out to the instance.

import { send } from "../net/connection";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { type At, pageScope, repeatScope, resolve, runHandler, type Scope } from "../state/bind";
import { endOf, handlerKey, settingsOf, takes } from "../state/events";

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

/** A handler's time setting in ms, an expression read in `scope`, its default where that is
 *  no number. */
export function timeOf(h: Handler, setting: string, scope: Scope): number {
  const fallback = Number(settingsOf(h.event).find((s) => s.name === setting)?.default);
  const r = resolve(h.attrs[setting] || String(fallback), scope);
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** The element's handlers that take `event` bringing `p` and are heard now in `scope`, or
 *  `only` among them. */
function hearing(e: Element, event: string, p: unknown, scope: Scope, only?: Handler) {
  const one = only && handlerKey(only.event, only.filter);
  return e.handlers.filter((h) => takes(h, event, p) && (!one || handlerKey(h.event, h.filter) === one) && heard(h, scope));
}

/** A page's events, sent to the backend for the handlers there it hears. What begins or ends
 *  something the element has a handler to end goes too, as a press with a release, so the
 *  backend knows what a screen holds should the screen be lost. */
export function pageAct(page: string): Act {
  return {
    fire: (e, event, payload, at, only) => {
      const heard = hearing(e, event, payload, within(pageScope, at), only);
      const end = endOf(event);
      if (heard.length > 0 || (end && e.handlers.some((h) => takes(h, end, payload)))) {
        send({ type: "fire", page, id: e.id, event, payload: (payload ?? null) as Value, index: at?.index, item: at?.item as Value, heard: heard.map((h) => h.filter) });
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
      for (const h of hearing(e, event, payload, here, only)) runHandler(h.code, here, emit, payload ?? null, `${c.name} ${e.props.name ?? e.id} ${event}`);
    },
    hears: (_, h, at) => heard(h, within(scope, at)),
  };
}
