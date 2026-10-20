// Where an element's events go: on a page to the backend's handler, inside an instance to the
// component's handler here, whose emits climb out to the instance.

import { send } from "../net/connection";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { type At, repeatScope, runHandler, type Scope } from "../state/bind";

export interface Act {
  /** `at` is the copy of a repeated element it happened to. */
  fire(e: Element, event: string, payload?: unknown, at?: At): void;
}

/** A page's events, sent to the backend for the handler there. Press and release go for any
 *  element with a handler, so the backend knows what a screen holds should the screen be lost. */
export function pageAct(page: string): Act {
  return {
    fire: (e, event, payload, at) => {
      const held = (event === "press" || event === "release") && e.handlers.length > 0;
      if (held || e.handlers.some((h) => h.event === event)) {
        send({ type: "fire", page, id: e.id, event, payload: (payload ?? null) as JsonValue, index: at?.index, item: at?.item as JsonValue });
      }
    },
  };
}

/** A component's events, run here. `emit` sends one out as the instance's own. */
export function componentAct(c: Page, scope: Scope, instance: Element, outer: Act): Act {
  return {
    fire: (e, event, payload, at) => {
      const h = e.handlers.find((x) => x.event === event);
      if (!h) return;
      const emit = (name: string, sent?: unknown) => outer.fire(instance, String(name), sent);
      const here = at ? repeatScope(scope, at.index, () => at.item) : scope;
      runHandler(h.code, here, emit, payload ?? null, `${c.name} ${e.props.name ?? e.id} ${event}`);
    },
  };
}
