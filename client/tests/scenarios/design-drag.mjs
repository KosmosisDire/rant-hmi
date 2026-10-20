// A new user adds a frame, then moves and resizes it several times in quick succession.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Drag");
  await d.openPage("Drag");
  await page.locator('button[title="Add a frame"]').click();
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the frame");
  const at = () => props(hmi, pageId, id);

  const moved = async (what, before, keys) => {
    await eventually(() => keys.some((k) => at()[k] !== before[k]), what);
    for (const k of keys) check(Number(at()[k]) % 11 === 0, `${k} ${at()[k]} is off the grid after ${what}`);
  };

  let before = { ...at() };
  await d.drag(id, 120, 60);
  await moved("the first move", before, ["x", "y"]);

  before = { ...at() };
  await d.drag(id, -60, 40);
  await moved("a second move right after", before, ["x", "y"]);

  before = { ...at() };
  await d.resize("se", 80, 50);
  await moved("a resize", before, ["w", "h"]);

  before = { ...at() };
  await d.drag(id, 70, 0);
  await moved("a move right after the resize", before, ["x"]);

  before = { ...at() };
  await d.resize("nw", -40, -40);
  await moved("a resize from the other corner", before, ["x", "y", "w", "h"]);

  // what the canvas shows matches what was saved
  const box = await d.box(id);
  const k = box.width / Number(at().w);
  check(Math.abs(box.height / Number(at().h) - k) < 0.01, "the drawn box has the saved shape");
}
