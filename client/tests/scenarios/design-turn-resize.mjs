// A designer resizes turned elements by their grips: the pull counts along the element's own
// sides, so a frame turned upright grows down from its east grip, and the side across from
// the grip stays put whether it turns about its corner or its middle.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Turned grips");
  const corner = await hmi.addElement(pageId, "div", { name: "Corner", x: "20", y: "20", w: "10", h: "5", rotate: "90", background: "#2a2f35" });
  const middle = await hmi.addElement(pageId, "div", { name: "Middle", x: "60", y: "30", w: "10", h: "5", rotate: "90", origin: '"50% 50%"', background: "#4a8fd6" });
  await d.openPage("Turned grips");
  const k = (await page.locator(".artboard .page-layer.open > .page").boundingBox()).width / 128;
  const pull = async (id, dx, dy) => {
    await d.el(id).click();
    const g = await page.locator(".artboard .ring .handle.e").boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + dx * k, g.y + g.height / 2 + dy * k, { steps: 5 });
    await page.mouse.up();
  };
  const at = (id) => ["x", "y", "w", "h"].map((key) => props(hmi, pageId, id)[key]).join();

  // turned upright about its corner, its east grip faces down and shows so, and the corner holds
  await d.el(corner).click();
  await eventually(async () => (await page.locator(".artboard .ring .handle.e").evaluate((g) => g.style.cursor)) === "ns-resize", "the east grip of an upright frame to show an up and down cursor");
  await pull(corner, 0, 5);
  await eventually(() => at(corner) === "20,20,15,5", () => `the corner frame to grow down to 15 wide, it is ${at(corner)}`);

  // about its middle, the middle moves so its west side, now its top, holds
  await pull(middle, 0, 4);
  await eventually(() => at(middle) === "60,32,14,5", () => `the middle frame to grow down with its top kept, it is ${at(middle)}`);
}
