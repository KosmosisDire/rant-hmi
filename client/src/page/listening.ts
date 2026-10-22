// How an element hears raw input, as keys and gamepads: only while it shows on the top page and
// the window has focus, and whatever it holds ends once, however it ends.

import { createEffect, createRoot, on } from "solid-js";

/** Whether `el` shows on the top page: on the page, with nothing above it hidden or covered. */
export const shows = (el: globalThis.Element) => el.isConnected && !el.closest("[hidden], [inert]");

/** An element listening to one input. `lose` ends all it holds. */
export interface Listener {
  el: globalThis.Element;
  lose(): void;
}

/** The elements listening to one input. While any listens, `start` hears the input and gives
 *  back its undoing, and each lets go of what it holds when the window loses focus or hides or
 *  the element stops showing, `lost` told too. */
export class Listening<L extends Listener> {
  private readonly all = new Set<L>();
  private stop = () => {};
  private readonly blur = () => this.loseAll();
  private readonly away = () => document.visibilityState === "hidden" && this.loseAll();
  // a page hidden or covered ends what its elements hold
  private readonly covered = new MutationObserver(() => this.each().forEach((l) => shows(l.el) || l.lose()));

  constructor(
    private readonly start: () => () => void,
    private readonly lost = () => {},
  ) {}

  /** Adds `l`, giving back its removal. */
  add(l: L): () => void {
    if (this.all.size === 0) {
      const stop = this.start();
      window.addEventListener("blur", this.blur);
      document.addEventListener("visibilitychange", this.away);
      this.covered.observe(document.documentElement, { attributes: true, attributeFilter: ["hidden", "inert"], subtree: true });
      this.stop = () => {
        stop();
        window.removeEventListener("blur", this.blur);
        document.removeEventListener("visibilitychange", this.away);
        this.covered.disconnect();
      };
    }
    this.all.add(l);
    return () => {
      this.all.delete(l);
      if (this.all.size === 0) this.stop();
    };
  }

  /** Each listening now, as a list, so one may leave while it is walked. */
  each(): L[] {
    return [...this.all];
  }

  /** Each listening now that shows. */
  shown(): L[] {
    return this.each().filter((l) => shows(l.el));
  }

  loseAll() {
    this.lost();
    this.each().forEach((l) => l.lose());
  }
}

/** One held input: what began it, and what to undo when it ends. */
interface Hold<P> {
  p: P;
  stops: (() => void)[];
}

/** What one element holds of an input, by id. Each hold ends once: `ended` gets what began it,
 *  and what ended it, or nothing when it was lost. A hold whose `heard` turns false ends lost, as
 *  a key held past its keydown's while. */
export function holds<P>(ended: (p: P, by?: P) => void) {
  const held = new Map<string, Hold<P>>();
  const end = (id: string, by?: P) => {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    h.stops.forEach((stop) => stop());
    ended(h.p, by);
  };
  return {
    get: (id: string) => held.get(id),
    ids: () => [...held.keys()],
    /** Holds `id`, begun by `p`. Gives back the hold, to add what to undo when it ends. */
    begin(id: string, p: P, heard?: () => boolean): Hold<P> {
      const hold: Hold<P> = { p, stops: [] };
      if (heard) {
        const watch = createRoot((dispose) => {
          createEffect(on(heard, (yes) => yes || queueMicrotask(() => end(id)), { defer: true }));
          return dispose;
        });
        hold.stops.push(watch);
      }
      held.set(id, hold);
      return hold;
    },
    end,
    endAll: () => [...held.keys()].forEach((id) => end(id)),
  };
}
