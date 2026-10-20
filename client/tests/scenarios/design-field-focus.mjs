// A user clicks into a field, the value changes elsewhere meanwhile (another screen, a drag),
// and they click away without typing. The field must not write its old value back.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Focus");
  await d.openPage("Focus");
  await page.locator('button[title="Add a frame"]').click();
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the frame");

  await d.field("w").click();
  await hmi.setProps(pageId, id, { w: "264" });
  await page.locator(".artboard").click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(300);
  check(props(hmi, pageId, id).w === "264", `clicking away wrote w back to ${props(hmi, pageId, id).w}`);
}
