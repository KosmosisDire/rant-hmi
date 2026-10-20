// A user moves a frame, then takes their time over a second move, holding still before
// letting go. The second move must land even though the first one's wait ran out meanwhile.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Slow drag");
  await d.openPage("Slow drag");
  await d.addRow("Frame");
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the frame");
  const at = () => props(hmi, pageId, id);

  let before = { ...at() };
  await d.drag(id, 110, 0);
  await eventually(() => at().x !== before.x, "the first move");

  before = { ...at() };
  const b = await d.box(id);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 80, { steps: 4 });
  await page.waitForTimeout(3300);
  await page.mouse.up();
  await eventually(() => at().y !== before.y, "the slow second move to land");
}
