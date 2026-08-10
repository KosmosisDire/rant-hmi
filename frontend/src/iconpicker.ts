/* THE ICON PICKER: a searchable grid over the full Lucide set. Generic on purpose,
 * like the color picker beside it: a name in, a name out, no knowledge of slots or the
 * inspector. The GRID is the literal editor an icon-shaped value earns — the value box
 * opens it from its type icon, the raw editors (a prop's DEFAULT, a variable's INIT)
 * from their glyph button — and what a pick hands back is only ever the icon's NAME;
 * each caller spells it into its own encoding (quoted in expression text, bare in a
 * raw document value).
 *
 * The whole set is ~1500 glyphs and every cell is an inline SVG, so an unfiltered
 * render is capped: the search narrows, the footer says what the cap hid, and Enter
 * picks the first hit so "gau⏎" is a complete gesture. */

import { commitInput, el } from "./dom.js";
import { iconMarkup } from "./icons.js";
import { LUCIDE } from "./lucide.js";
import { makeShell, Shell } from "./popover.js";
import { bind, bindField } from "./reconcile.js";

/* one test for "is this text an icon literal", shared with the value box's gesture
 * gate and glyph face, so the grid and the box can never disagree */
export function isIconName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LUCIDE, name);
}

/* the face an unknown or empty name paints — a stand-in, never a stale glyph */
export const ICON_UNKNOWN_GLYPH = "shapes";

let shell: Shell | null = null;
function ensure(): Shell {
  return (shell ??= makeShell({
    id: "ipick",
    boxClass: "ipick-pop",
    dismiss: "backdrop",
    wheel: "passive",
  }));
}

/* how many cells one render pass will draw; past it the footer counts the rest */
const GRID_CAP = 224;

export function openIconPicker(
  anchor: HTMLElement,
  current: string,
  onPick: (name: string) => void,
): void {
  const sh = ensure();
  sh.box.innerHTML = "";
  const names = Object.keys(LUCIDE);

  const search = el("input", {
    class: "field ipick-search",
    placeholder: "search icons",
    spellcheck: "false",
  }) as HTMLInputElement;
  const grid = el("div", { class: "ipick-grid" });
  const foot = el("div", { class: "ipick-foot" });

  let first = "";
  const render = () => {
    const filter = search.value.trim().toLowerCase();
    let hits = filter ? names.filter((n) => n.includes(filter)) : names;
    /* unfiltered, the CURRENT pick leads the grid: "which one is it now" must never
       hide behind the render cap or need scrolling */
    if (!filter && isIconName(current))
      hits = [current, ...names.filter((n) => n !== current)];
    first = hits[0] ?? "";
    grid.innerHTML = "";
    for (const name of hits.slice(0, GRID_CAP)) {
      const cell = el("button", {
        class: "ipick-cell" + (name === current ? " on" : ""),
        title: name,
        html: iconMarkup(name, 18, 1.7),
      });
      cell.addEventListener("click", () => {
        sh.close();
        onPick(name);
      });
      grid.appendChild(cell);
    }
    foot.textContent =
      hits.length > GRID_CAP ? hits.length - GRID_CAP + " more — search to narrow"
      : hits.length === 0 ? "no icon matches"
      : "";
  };
  search.addEventListener("input", render);
  search.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" && first) {
      ev.preventDefault();
      sh.close();
      onPick(first);
    }
  });
  render();

  sh.box.appendChild(search);
  sh.box.appendChild(grid);
  sh.box.appendChild(foot);
  sh.openUnder(anchor, { fallbackW: 300, minW: 300, fallbackH: 330, clampFlip: true });
  search.focus?.();
}

/* THE RAW-VALUE FIELD, the colorField's sibling (editors.ts): a glyph button that
 * paints the CURRENT icon and opens the grid, beside a plain text field holding the
 * bare name — the document value of a prop default or a variable init, never the
 * quoted expression spelling. */
export function iconField(
  value: string,
  commit: (name: string) => void,
  key?: string,
  read?: () => string,
): HTMLElement {
  const face = el("button", { class: "swatch ipick-face", title: "pick an icon" });
  const paintFace = (name: string) => {
    face.innerHTML = iconMarkup(isIconName(name) ? name : ICON_UNKNOWN_GLYPH, 14, 1.7);
    face.classList.toggle("unknown", !isIconName(name));
  };
  const field = commitInput(value, (text) => commit(text.trim()),
                            { class: "field grow", spellcheck: "false" });
  paintFace(value);
  if (key && read) {
    bindField(key, field as HTMLInputElement, read);
    bind(key + ".face", face, () => paintFace(read()));
  }
  face.addEventListener("click", () =>
    openIconPicker(face, read ? read() : (field as HTMLInputElement).value, (name) => {
      (field as HTMLInputElement).value = name;
      paintFace(name);
      commit(name);
    }));
  return el("span", { class: "value-cell grow" }, [face, field]);
}
