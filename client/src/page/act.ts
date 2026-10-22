// Where an element's events go: on a page to the backend's handler, inside an instance to the
// component's handler here, whose emits climb out to the instance.

import { send } from "../net/connection";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { Page } from "../protocol/Page";
import type { Value } from "../protocol/Value";
import { type At, pageScope, repeatScope, resolve, runHandler, type Scope } from "../state/bind";

export interface Act {
  /** `at` is the copy of a repeated element it happened to. */
  fire(e: Element, event: string, payload?: unknown, at?: At): void;
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

/** A page's events, sent to the backend for the handler there. Press and release go for any
 *  element with a handler, so the backend knows what a screen holds should the screen be lost. */
export function pageAct(page: string): Act {
  return {
    fire: (e, event, payload, at) => {
      const h = e.handlers.find((x) => x.event === event);
      const held = (event === "press" || event === "release") && e.handlers.length > 0;
      if (h ? heard(h, within(pageScope, at)) : held) {
        send({ type: "fire", page, id: e.id, event, payload: (payload ?? null) as Value, index: at?.index, item: at?.item as Value });
      }
    },
  };
}

/** A component's events, run here. `emit` sends one out as the instance's own. */
export function componentAct(c: Page, scope: Scope, instance: Element, outer: Act): Act {
  return {
    fire: (e, event, payload, at) => {
      const h = e.handlers.find((x) => x.event === event);
      const here = within(scope, at);
      if (!h || !heard(h, here)) return;
      const emit = (name: string, sent?: unknown) => outer.fire(instance, String(name), sent);
      runHandler(h.code, here, emit, payload ?? null, `${c.name} ${e.props.name ?? e.id} ${event}`);
    },
  };
}
