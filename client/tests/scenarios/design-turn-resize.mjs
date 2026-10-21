// A designer resizes turned elements by their grips: the pull counts along the element's own
// sides, so a frame turned upright grows down from its east grip, and the side across from
// the grip stays put whether it turns about its corner or its middle.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Turned grips");
  const corner = await hmi.addElement(pageId, "div", { name: "Corner", x: "200", y: "200", w: "100", h: "50", rotate: "90", background: "#2a2f35" });
  const middle = await hmi.addElement(pageId, "div", { name: "Middle", x: "600", y: "300", w: "100", h: "50", rotate: "90", origin: '"50% 50%"', background: "#4a8fd6" });
  await d.openPage("Turned grips");
  const k = (await page.locator(".artboard .page").boundingBox()).width / 1408;
  const pull = async (id, dx, dy) => {
    await d.el(id).click();
    const g = await page.locator(".artboard .ring .handle.e").boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + dx * k, g.y + g.height / 2 + dy * k, { steps: 5 });
    await page.mouse.up();
  };
  const at = (id) => ["x", "y", "w", "h"].map((key) => props(hmi, pageId, id)[key]).join();

  // turned upright about its corner, its east side faces down, and the corner holds
  await pull(corner, 0, 50);
  await eventually(() => at(corner) === "200,200,150,50", () => `the corner frame to grow down to 150 wide, it is ${at(corner)}`);

  // about its middle, the middle moves so its west side, now its top, holds
  await pull(middle, 0, 40);
  await eventually(() => at(middle) === "600,320,140,50", () => `the middle frame to grow down with its top kept, it is ${at(middle)}`);
}
