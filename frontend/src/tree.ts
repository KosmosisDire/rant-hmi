/* The tree row idiom, shared by the editor's trees: the Layers hierarchy in Content and
 * the component list in Design.
 *
 * Each tree owns its own FOLD state, because expansion decides which rows EXIST — unlike
 * a section fold, which only hides rows that are already built. So a toggle bumps a
 * revision that rides the owning panel's shape string, and the panel rebuilds. Two trees
 * in two workspaces therefore expand independently and neither rebuilds the other. */

import { el } from "./dom.js";
import { iconMarkup } from "./icons.js";

export interface Fold {
  /* is this row open? `dflt` is what an untouched key means (part boxes open, widgets
     and components closed) */
  open(key: string, dflt: boolean): boolean;
  toggle(key: string, dflt: boolean, then: () => void): void;
  /* bumped by every toggle: the number a shape string carries so the panel rebuilds */
  revision(): number;
}

export function makeFold(): Fold {
  const state = new Map<string, boolean>();
  let revision = 0;
  return {
    open: (key, dflt) => state.get(key) ?? dflt,
    toggle: (key, dflt, then) => {
      state.set(key, !(state.get(key) ?? dflt));
      revision++;
      then();
    },
    revision: () => revision,
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
    class: "layer-caret",
    html: fold ? iconMarkup("chevron-down", 9, 2) : "",
    style: fold && !fold.open ? "transform:rotate(-90deg)" : "",
  });
  if (fold)
    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fold.toggle();
    });
  return el(
    "button",
    {
      class: "layer-row " + cls,
      "data-key": key,
      style: "padding-left:" + (4 + depth * 12) + "px",
      title,
      onclick,
    },
    [caret, ...kids],
  );
}

/* draw-kind glyphs: one mono mark per box direction / part draw, shared by both trees */
export const PART_GLYPH: Record<string, string> = {
  row: "→", col: "↓", stack: "▤", auto: "⇆",
  rect: "▭", bar: "▮", text: "T", icon: "✦",
  arc: "◠", needle: "↗", plot: "∿", path: "◇", code: "λ",
};
