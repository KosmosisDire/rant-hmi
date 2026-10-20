// A user drags a frame off the page, lets go of it, and wants it back: it must stay in
// sight and take a press, though the page will not show it when it runs.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Off page");
  await d.openPage("Off page");
  await page.locator('button[title="Add a frame"]').click();
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the frame");
  const at = () => props(hmi, pageId, id);

  const sheet = await page.locator(".artboard .page").boundingBox();
  const b = await d.box(id);
  await d.drag(id, 0, sheet.y + sheet.height + 40 - b.y);
  await eventually(() => Number(at().y) > 792, "the frame to land below the page");

  await page.keyboard.press("Escape");
  const out = await d.box(id);
  check(out && out.height > 10, "the frame off the page is not drawn");
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".el")?.getAttribute("data-id"), [out.x + out.width / 2, out.y + out.height / 2]);
  check(hit === id, `a press on the frame off the page reaches ${hit ?? "nothing"}`);

  const before = { ...at() };
  await d.drag(id, 0, -300);
  await eventually(() => Number(at().y) < Number(before.y), "the frame to come back up");
}
