/* The tree row idiom, shared by the editor's trees: the Layers hierarchy in Content and
 * the component list in Design.
 *
 * Each tree owns its own FOLD state, because expansion decides which rows EXIST — unlike
 * a section fold, which only hides rows that are already built. So a toggle bumps a
 * revision that rides the owning panel's shape string, and the panel rebuilds. Two trees
 * in two workspaces therefore expand independently and neither rebuilds the other. */

import { el } from "./dom.js";
import { makeFolds } from "./fold.js";
import { iconMarkup } from "./icons.js";

export interface Fold {
  /* is this row open? `dflt` is what an untouched key means (element boxes open, instances
     and components closed) */
  open(key: string, dflt: boolean): boolean;
  toggle(key: string, dflt: boolean, then: () => void): void;
  /* bumped by every toggle: the number a shape string carries so the panel rebuilds */
  revision(): number;
}

/* an instance of the one fold store (fold.ts), wearing the tree's toggle-then-rebuild
 * idiom: `then` is where the owner asks for its refresh */
export function makeFold(): Fold {
  const folds = makeFolds();
  return {
    open: (key, dflt) => folds.open(key, dflt),
    toggle: (key, dflt, then) => {
      folds.toggle(key, dflt);
      then();
    },
    revision: () => folds.revision(),
  };
}

/* one tree row: indent, a caret when it expands, then the caller's cells. The caret owns
 * its own click, so a fold never changes the selection. */
export function treeRow(
  key: string,
  depth: number,
  cls: string,
  fold: { open: boolean; toggle: () => void } | null,
  kids: (HTMLElement | null)[],
  onclick: () => void,
  title?: string,
): HTMLElement {
  const caret = el("span", {
    class: "icon-mark layer-caret",
    html: fold ? iconMarkup("chevron-down", 10, 2) : "",
    style: `flex-basis: calc(0.75em + ` + (depth) + `em);`,
  });
  if (fold)
    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fold.toggle();
    });
  return el(
    "button",
    {
      class: "layer-row " + cls + (fold && !fold.open ? " collapsed" : ""),
      "data-key": key,
      title,
      onclick,
    },
    [caret, ...kids],
  );
}

/* draw-kind glyphs: one mono mark per node kind / box direction / element draw, shared by
   both trees. `frame` and `rect` wear the same box mark — one is the node kind, the other
   the draw it stands for. */
export const KIND_GLYPH: Record<string, string> = {
  row: "→", col: "↓", stack: "▤", auto: "⇆",
  frame: "▭", rect: "▭", bar: "▮", text: "T", icon: "✦",
  arc: "◠", needle: "↗", plot: "∿", path: "◇", code: "λ",
};
