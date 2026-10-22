// The keyboard on a running screen. One listener on the window hands each key to the elements
// that listen while they show on the top page, never while a field is typed in. A key held on
// one ends with its keyup however it ends: let go, the window losing focus, the element gone or
// covered, or its keydown's while turning false.

import { createEffect, createMemo, createRoot, on, onCleanup } from "solid-js";
import type { Element } from "../protocol/Element";
import type { Handler } from "../protocol/Handler";
import type { At, Scope } from "../state/bind";
import { eventInfo, takes } from "../state/events";
import { type Act, QUICKEST, timeOf } from "./act";

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
interface Listener {
  el: globalThis.Element;
  down(k: Key): boolean;
  up(k: Key): void;
  lose(): void;
}

const listeners = new Set<Listener>();
// the keys a handler named going down, whose keyup does nothing else either
const named = new Set<string>();

/** Whether `el` shows on the top page: on the page, with nothing above it hidden or covered. */
const shows = (el: globalThis.Element) => el.isConnected && !el.closest("[hidden], [inert]");

function keydown(e: KeyboardEvent) {
  if (e.repeat || (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
  const k = keyOf(e);
  let took = false;
  for (const l of [...listeners]) if (shows(l.el)) took = l.down(k) || took;
  // a key a handler names does only what the handler does, as Space never presses a button
  if (took) {
    e.preventDefault();
    named.add(k.code);
  }
}

function keyup(e: KeyboardEvent) {
  for (const l of [...listeners]) l.up(keyOf(e));
  if (named.delete(e.code)) e.preventDefault();
}

function loseAll() {
  named.clear();
  for (const l of [...listeners]) l.lose();
}

const away = () => document.visibilityState === "hidden" && loseAll();
// a page hidden or covered ends what its elements hold
const covered = new MutationObserver(() => [...listeners].filter((l) => !shows(l.el)).forEach((l) => l.lose()));

/** Adds a listener, the window's own listeners with the first, ahead of the screen's own keys
 *  so those see a key a handler took. Gives back its removal. */
function listen(l: Listener): () => void {
  if (listeners.size === 0) {
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", loseAll);
    document.addEventListener("visibilitychange", away);
    covered.observe(document.documentElement, { attributes: true, attributeFilter: ["hidden", "inert"], subtree: true });
  }
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size > 0) return;
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("blur", loseAll);
    document.removeEventListener("visibilitychange", away);
    covered.disconnect();
  };
}

const keyboard = (h: Handler) => eventInfo(h.event)?.from === "keyboard";

/** Hands an element's keys to its handlers while it shows: keydown, each keyrepeat on its own
 *  beat, and keyup however the key ends, with `lost` when it never came up. */
export function useKeys(p: { element: Element; act?: Act; at?: At; scope: Scope }, self: () => globalThis.Element | undefined) {
  const listens = createMemo(() => !!p.act && p.element.handlers.some(keyboard));
  createEffect(() => {
    const [el, act] = [self(), p.act];
    if (!listens() || !el || !act) return;
    const fire = (event: string, k: Key & { lost?: boolean }, only?: Handler) => act.fire(p.element, event, k, p.at, only);
    const held = new Map<string, { k: Key; beats: ReturnType<typeof setInterval>[]; stop: () => void }>();
    const end = (code: string, up?: Key) => {
      const h = held.get(code);
      if (!h) return;
      held.delete(code);
      h.beats.forEach(clearInterval);
      h.stop();
      fire("keyup", up ? { ...h.k, shift: up.shift, ctrl: up.ctrl, alt: up.alt } : { ...h.k, lost: true });
    };
    // ends once any keydown that heard it is no longer heard
    const watch = (code: string, by: Handler[]) =>
      createRoot((dispose) => {
        createEffect(on(() => by.every((h) => act.hears(p.element, h, p.at)), (all) => all || queueMicrotask(() => end(code)), { defer: true }));
        return dispose;
      });
    const stop = listen({
      el,
      down: (k) => {
        const hs = p.element.handlers.filter((h) => keyboard(h) && takes(h, h.event, k));
        if (hs.length === 0 || held.has(k.code)) return false;
        const by = hs.filter((h) => h.event === "keydown" && act.hears(p.element, h, p.at));
        const hold = { k, beats: [] as ReturnType<typeof setInterval>[], stop: by.length > 0 ? watch(k.code, by) : () => {} };
        held.set(k.code, hold);
        fire("keydown", k);
        // a repeat runs at once, then on each beat until the key ends
        for (const h of hs.filter((x) => x.event === "keyrepeat")) {
          fire("keyrepeat", k, h);
          hold.beats.push(setInterval(() => fire("keyrepeat", k, h), Math.max(timeOf(h, "every", p.scope), QUICKEST)));
        }
        return hs.some((h) => Object.keys(h.filter).length > 0);
      },
      up: (k) => end(k.code, k),
      lose: () => [...held.keys()].forEach((code) => end(code)),
    });
    onCleanup(() => {
      stop();
      [...held.keys()].forEach((code) => end(code));
    });
  });
}
