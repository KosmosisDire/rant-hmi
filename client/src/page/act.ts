// Where an element's events go. On a page they go to the backend, which runs the handler
// there. Inside an instance the component's handler runs here, in the instance's scope, and
// what it emits goes on to the instance, so events climb out level by level.

import { send } from "../net/connection";
import type { Element } from "../protocol/Element";
import type { Page } from "../protocol/Page";
import type { JsonValue } from "../protocol/serde_json/JsonValue";
import { runHandler, type Scope } from "../state/bind";

export interface Act {
  fire(e: Element, event: string, payload?: unknown): void;
}

/** A page's events, sent to the backend for the handler there. Press and release go for any
 *  element with a handler, so the backend knows what a screen holds should the screen be lost. */
export function pageAct(page: string): Act {
  return {
    fire: (e, event, payload) => {
      const held = (event === "press" || event === "release") && e.handlers.length > 0;
      if (held || e.handlers.some((h) => h.event === event)) send({ type: "fire", page, id: e.id, event, payload: (payload ?? null) as JsonValue });
    },
  };
}

/** A component's events, run here. `emit` sends one out as the instance's own. */
export function componentAct(c: Page, scope: Scope, instance: Element, outer: Act): Act {
  return {
    fire: (e, event, payload) => {
      const h = e.handlers.find((x) => x.event === event);
      if (!h) return;
      const emit = (name: string, sent?: unknown) => outer.fire(instance, String(name), sent);
      runHandler(h.code, scope, emit, payload ?? null, `${c.name} ${e.props.name ?? e.id} ${event}`);
    },
  };
}
