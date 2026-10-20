// A new user drags a text across the page and resizes it: no browser text selection may
// start, since pressing on selected text would start a text drag instead of a move.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Text drag");
  await d.openPage("Text drag");
  await page.locator('button[title="Add a text"]').click();
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the text");
  const at = () => props(hmi, pageId, id);

  for (const [what, act, keys] of [
    ["a move", () => d.drag(id, 150, 30), ["x"]],
    ["a resize", () => d.resize("e", 120, 0), ["w"]],
    ["a move after the resize", () => d.drag(id, 60, 60), ["x", "y"]],
    ["another resize", () => d.resize("s", 0, 40), ["h"]],
  ]) {
    const before = { ...at() };
    await act();
    await eventually(() => keys.some((k) => at()[k] !== before[k]), what);
    const selected = await page.evaluate(() => String(window.getSelection()));
    check(selected === "", `${what} selected the text "${selected}"`);
  }
}
