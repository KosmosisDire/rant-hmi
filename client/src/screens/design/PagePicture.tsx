// A page or component drawn whole as a picture, as a tree's row shows it while the pointer rests
// there, and a component dropped on a page on the board, placed there.

import { fitIn, PageView } from "../../page/PageView";
import type { Page } from "../../protocol/Page";
import { UNIT } from "../../state/bind";
import { page as pageOf } from "../../state/store";
import { addElement } from "./add";

/** A page or component drawn whole, as large as fits in `w` by `h` px, as a tree's row shows it
 *  while the pointer rests there. */
export function PagePicture(p: { page: Page; w?: number; h?: number }) {
  const [w, h] = [() => p.page.width * UNIT, () => p.page.height * UNIT];
  const k = () => fitIn(w(), h(), { w: p.w ?? 240, h: p.h ?? 150 }).k;
  return (
    <div class="page-picture" style={{ width: `${w() * k()}px`, height: `${h() * k()}px` }}>
      <div style={{ width: `${w()}px`, height: `${h()}px`, transform: `scale(${k()})`, "transform-origin": "0 0" }}>
        <PageView page={p.page} />
      </div>
    </div>
  );
}

/** Places an instance of `component` on the page on the board under a point, centred there,
 *  unless that page is the component itself. */
export function placeComponent(component: Page, x: number, y: number) {
  const layer = document.elementFromPoint(x, y)?.closest(".artboard .page-layer[data-page]");
  const page = layer && pageOf(layer.getAttribute("data-page") ?? "");
  const sheet = layer?.querySelector(":scope > .page");
  if (!page || !sheet || page.id === component.id) return;
  const r = sheet.getBoundingClientRect();
  const k = r.width / page.width;
  const { name, width: w, height: h } = component;
  addElement(page, null, "use", { name, w: String(w), h: String(h) }, name, { x: (x - r.left) / k - w / 2, y: (y - r.top) / k - h / 2 });
}
