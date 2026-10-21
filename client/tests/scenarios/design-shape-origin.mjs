// A turned shape in a diagram takes a new point to turn about from the nine of its box and
// stays where it is drawn: its outline moves to make up for the turn about the new point.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Shape origin");
  const diagram = await hmi.addElement(pageId, "svg", { name: "Plan", x: "4", y: "4", w: "40", h: "30" });
  const bar = await hmi.addElement(pageId, "rect", { name: "Bar", x: "10", y: "10", width: "12", height: "4", rotate: "30", fill: '"#4a8fd6"' }, diagram);
  await d.openPage("Shape origin");
  await d.select("Bar");
  const drawn = async () => {
    const b = await d.el(bar).boundingBox();
    return [b.x, b.y, b.width, b.height];
  };
  await page.waitForTimeout(300);
  const before = await drawn();
  await page.locator('.screen:not([hidden]) .sidebar.right .lead[title="Pick a point of its box"]').click();
  await page.locator('.popover .point[title="Top left"]').click();
  await eventually(() => props(hmi, pageId, bar).origin === '"0% 0%"', "the new origin");
  const { x, y } = props(hmi, pageId, bar);
  check(x !== "10" || y !== "10", "the outline stayed put, so the turn about the new point moved it");
  let after = [];
  await eventually(async () => (after = await drawn()).every((v, i) => Math.abs(v - before[i]) < 1), () => `the bar moved from ${before.map(Math.round)} to ${after.map(Math.round)}`);
}
