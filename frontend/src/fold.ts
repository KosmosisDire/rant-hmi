/* THE ONE FOLD STORE: every caret that hides or shows content keeps its state in an
 * instance of this — the inspector sections, the two trees, the flow and variable cards.
 * State is per view and never synced; a fold is presentation, not document.
 *
 * Two idioms ride the same store, and the CONSUMER picks by what it does after a change,
 * never by a flag here. A section fold hides rows that are already built (one display
 * toggle, no rebuild), so it never reads revision(). A tree or card fold decides which
 * rows EXIST, so its owner rides revision() — or the open bit itself — in the panel's
 * shape string, and a toggle rebuilds exactly that panel. */

export interface Folds {
  /* is this key open? `dflt` is what an untouched key means */
  open(key: string, dflt?: boolean): boolean;
  /* flip it; an untouched key flips away from `dflt` */
  toggle(key: string, dflt?: boolean): void;
  set(key: string, open: boolean): void;
  /* bumped by every change: the number a shape string carries so a rebuild fires */
  revision(): number;
}

export function makeFolds(): Folds {
  const state = new Map<string, boolean>();
  let revision = 0;
  const open = (key: string, dflt = false) => state.get(key) ?? dflt;
  const set = (key: string, next: boolean) => {
    state.set(key, next);
    revision++;
  };
  return {
    open,
    set,
    toggle: (key, dflt = false) => set(key, !open(key, dflt)),
    revision: () => revision,
  };
}
