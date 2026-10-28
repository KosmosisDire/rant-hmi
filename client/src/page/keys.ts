// The keyboard on a running screen. One listener on the window hands each key to the elements
// that listen while they show on the top page, never while a field is typed in. A key held on
// one ends with its keyup however it ends: let go, the window losing focus, the element gone or
// covered, or its keydown's while turning false.

import { createEffect, createMemo, onCleanup } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { Scope } from "../state/bind";
import { eventInfo, takes } from "../state/events";
import { held } from "../state/input";
import { type Act, numberOf, QUICKEST } from "./act";
import { holds, type Listener, Listening } from "./listening";

/** What a key's event brings. */
export interface Key {
  key: string;
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export const keyOf = (e: KeyboardEvent): Key => ({ key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });

/** An element listening. `down` says whether a handler of its named the key. */
interface KeyListener extends Listener {
  down(k: Key): boolean;
  up(k: Key): void;
}

// the keys a handler named going down, whose keyup does nothing else either
const named = new Set<string>();

function keydown(e: KeyboardEvent) {
  if (e.repeat || (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
  const k = keyOf(e);
  let took = false;
  for (const l of listening.shown()) took = l.down(k) || took;
  // a key a handler names does only what the handler does, as Space never presses a button
  if (took) {
    e.preventDefault();
    named.add(k.code);
  }
}

function keyup(e: KeyboardEvent) {
  for (const l of listening.each()) l.up(keyOf(e));
  if (named.delete(e.code)) e.preventDefault();
}

/** The window's own listeners, ahead of the screen's own keys so those see a key a handler took. */
const listening = new Listening<KeyListener>(
  () => {
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
    };
  },
  () => named.clear(),
);

// the screen itself listens while code reads the keys held, each by the key its code typed
held.feedWith(() => {
  const down = new Map<string, string>();
  const show = () => held.set(new Set([...down].flat()));
  return listening.add({
    el: document.documentElement,
    down: (k) => {
      down.set(k.code, k.key);
      show();
      return false;
    },
    up: (k) => down.delete(k.code) && show(),
    lose: () => {
      down.clear();
      show();
    },
  });
});

const keyboard = (h: Handler) => eventInfo(h.event)?.from === "keyboard";

/** Hands an element's keys to its handlers while it shows: keydown, each keyrepeat on its own
 *  beat, and keyup however the key ends, with `lost` when it never came up. */
export function useKeys(p: { element: Element; act?: Act; scope: Scope }, self: () => globalThis.Element | undefined) {
  const listens = createMemo(() => !!p.act && p.element.handlers.some(keyboard));
  createEffect(() => {
    const [el, act] = [self(), p.act];
    if (!listens() || !el || !act) return;
    const fire = (event: string, k: Key & { lost?: boolean }, only?: Handler) => act.fire(p.element, event, k, p.scope, only);
    const held = holds<Key>((k, up) => fire("keyup", up ? { ...k, shift: up.shift, ctrl: up.ctrl, alt: up.alt } : { ...k, lost: true }));
    const stop = listening.add({
      el,
      down: (k) => {
        const hs = p.element.handlers.filter((h) => keyboard(h) && takes(h, h.event, k));
        if (hs.length === 0 || held.get(k.code)) return false;
        // ends once any keydown that heard it is no longer heard
        const by = hs.filter((h) => h.event === "keydown" && act.hears(p.element, h, p.scope));
        const hold = held.begin(k.code, k, by.length > 0 ? () => by.every((h) => act.hears(p.element, h, p.scope)) : undefined);
        fire("keydown", k);
        // a repeat runs at once, then on each beat until the key ends
        for (const h of hs.filter((x) => x.event === "keyrepeat")) {
          fire("keyrepeat", k, h);
          const beat = setInterval(() => fire("keyrepeat", k, h), Math.max(numberOf(h, "every", p.scope), QUICKEST));
          hold.stops.push(() => clearInterval(beat));
        }
        return hs.some((h) => Object.keys(h.filter).length > 0);
      },
      up: (k) => held.end(k.code, k),
      lose: held.endAll,
    });
    onCleanup(() => {
      stop();
      held.endAll();
    });
  });
}
