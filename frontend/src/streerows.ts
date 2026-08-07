/* The one .stree-row family: the folder-listing rows the source tree, the type tree
 * and the Data explorer all draw. Row DATA stays with each caller (their build_rows);
 * this module owns the anatomy — caret / kind-or-fold icon / label / caller-supplied
 * trailing cells — plus, for the two picker popovers, the search-flattened tree view
 * with the split-click rule. Expansion state is owned by the caller and passed in, so
 * each tree keeps its own folds across openings. (tree.ts's .layer-row family is a
 * different animal and stays where it is.) */

import { el } from "./dom.js";
import { iconMarkup, kindMark } from "./icons.js";

/* the fold cell: live rows rotate a chevron shut; the rest keep the blank spacer */
export function streeCaret(live: boolean, open: boolean): HTMLElement {
  return live
    ? el("span", {
        class: "stree-caret",
        html: iconMarkup("chevron-down", 9, 2),
        style: open ? "" : "transform:rotate(-90deg)",
      })
    : el("span", { class: "stree-caret" });
}

export interface StreeRowSpec {
  depth: number;
  caret: HTMLElement;
  kind?: string;      /* kind mark on entity/variable rows; otherwise the fold icon */
  icon: string;
  label: string;
  folder: boolean;    /* not pickable: .stree-folder */
  current: boolean;   /* the row the caller's reference already holds */
  rowClass?: string;  /* the Data explorer's extra class */
  attrs?: Record<string, string | undefined>;
  /* cells after the label, in the caller's order (note, shape, a live readout) */
  trail?: (HTMLElement | null)[];
}

export function streeRow(spec: StreeRowSpec): HTMLElement {
  return el(
    "button",
    {
      class: "stree-row" + (spec.rowClass ? " " + spec.rowClass : "") +
             (spec.folder ? " stree-folder" : "") + (spec.current ? " current" : ""),
      style: "padding-left:" + (8 + spec.depth * 14) + "px",
      ...spec.attrs,
    },
    [
      spec.caret,
      spec.kind ? kindMark(spec.kind) : el("span", {
        class: "stree-foldicon",
        html: iconMarkup(spec.icon, 11, 1.6),
      }),
      el("span", { class: "stree-label", text: spec.label }),
      ...(spec.trail ?? []),
    ],
  );
}

/* ---- the tree view the picker popovers share: search box + row list ---- */

export interface StreeTreeRow {
  depth: number;
  key: string;          /* expansion identity */
  label: string;
  kind?: string;
  icon?: string;
  current?: boolean;
  expandable: boolean;
  onPick?: () => void;  /* absent = a pure folder */
  trail?: (HTMLElement | null)[];
}

export interface StreeTree {
  search: HTMLInputElement;
  list: HTMLElement;
  render(): void;
}

export function streeTree(opts: {
  placeholder: string;
  /* fold state, owned by the caller so it survives across openings */
  expanded: Set<string>;
  defaultIcon: string;
  rows(filter: string): StreeTreeRow[];
  /* extra content after the rows (the source tree's fresh-name row) */
  footer?(list: HTMLElement, filter: string): void;
  /* the fresh-name variant never shows the empty marker */
  noEmpty?: boolean;
}): StreeTree {
  const search = el("input", {
    class: "stree-search",
    placeholder: opts.placeholder,
    spellcheck: "false",
  }) as HTMLInputElement;
  const list = el("div", { class: "stree-list" });

  const render = () => {
    const filter = search.value.trim().toLowerCase();
    list.innerHTML = "";
    for (const row of opts.rows(filter)) {
      const node = streeRow({
        depth: row.depth,
        caret: streeCaret(row.expandable && !filter, opts.expanded.has(row.key)),
        kind: row.kind,
        icon: row.icon ?? opts.defaultIcon,
        label: row.label,
        folder: !row.onPick,
        current: Boolean(row.current),
        trail: row.trail,
      });
      const toggle = () => {
        if (opts.expanded.has(row.key)) opts.expanded.delete(row.key);
        else opts.expanded.add(row.key);
        render();
      };
      node.addEventListener("click", (ev) => {
        /* a row that both expands and picks splits at its ICON: everything left of it
           (the indent and the caret) folds, the name and what follows picks. A click
           with no coordinates (keyboard, scripted) always picks. */
        if (row.expandable && row.onPick && !filter && ev.detail !== 0) {
          const icon = node.children[1] as HTMLElement;
          if (ev.clientX < icon.getBoundingClientRect().left) {
            toggle();
            return;
          }
        }
        if (row.onPick) {
          row.onPick();
          return;
        }
        if (row.expandable) toggle();
      });
      list.appendChild(node);
    }
    opts.footer?.(list, filter);
    if (!list.childElementCount && !opts.noEmpty)
      list.appendChild(el("div", { class: "stree-empty", text: "nothing matches" }));
  };
  search.addEventListener("input", render);
  return { search, list, render };
}

/* land on what the reference already holds */
export function scrollToCurrent(list: HTMLElement): void {
  list.querySelector(".stree-row.current")?.scrollIntoView({ block: "center" });
}
