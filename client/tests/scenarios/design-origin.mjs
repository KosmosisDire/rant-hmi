// A designer sets a frame's origin to its middle: its x and y then place its middle, a frame
// inside it at 0, 0 sits with its corner there, the editor marks the point at its middle, a
// nudge or a drag moves its x by the travel alone, and the run draws it where the editor does.
// Turned, a new origin leaves it and what it holds where they are drawn.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Origins");
  const panel = await hmi.addElement(pageId, "div", { name: "panel", x: "60", y: "20", w: "20", h: "10", origin: '"50% 50%"', background: "#2a2f35" });
  const dot = await hmi.addElement(pageId, "div", { name: "dot", x: "0", y: "0", w: "2", h: "2", background: "#c62828" }, panel);
  await d.openPage("Origins");
  // where its corner is drawn in what holds it, in page units
  const left = (id) =>
    d.el(id).evaluate((e) => {
      const [r, o] = [e.getBoundingClientRect(), e.parentElement.closest(".el, .page").getBoundingClientRect()];
      const k = e.closest(".page").getBoundingClientRect().width / 128;
      return [Math.round((r.left - o.left) / k), Math.round((r.top - o.top) / k)];
    });
  check((await left(panel)).join() === "50,15", `x and y place the panel's corner at ${await left(panel)}, not its middle`);
  check((await left(dot)).join() === "10,5", `the dot inside sits at ${await left(dot)}, not at the panel's middle`);

  // its middle holds the dot, so a press near its corner picks it
  await d.el(panel).click({ position: { x: 8, y: 8 } });
  check((await d.field("Origin").inputValue()) === '"50% 50%"', "the inspector does not show the origin under Placement");
  const [mark, middle] = [await page.locator(".artboard .origin").boundingBox(), await d.el(panel).boundingBox()];
  const off = [mark.x + mark.width / 2 - (middle.x + middle.width / 2), mark.y + mark.height / 2 - (middle.y + middle.height / 2)];
  check(off.every((v) => Math.abs(v) < 0.6), `the origin's mark is ${off.map((v) => v.toFixed(1))} off the point`);
  await page.keyboard.press("ArrowRight");
  await eventually(() => props(hmi, pageId, panel).x === "61", () => `a nudge to move x by its step of 1, x is ${props(hmi, pageId, panel).x}`);
  check(props(hmi, pageId, panel).y === "20", "a nudge across moved y");

  // a drag moves x and y by the pointer's travel, and the page's own numbers take over after
  const k = (await d.el(panel).boundingBox()).width / 20;
  const at = await d.el(panel).boundingBox();
  await page.mouse.move(at.x + 8, at.y + 8);
  await page.mouse.down();
  // Alt, so it lands on the pixel the pointer goes to, a tenth of a unit, and not on the grid
  await page.keyboard.down("Alt");
  await page.mouse.move(at.x + 8 + 4.4 * k, at.y + 8 + 2.2 * k, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const near = (key, v) => Math.abs(Number(props(hmi, pageId, panel)[key]) - v) <= 0.11 && /^\d+(\.\d)?$/.test(props(hmi, pageId, panel)[key]);
  await eventually(() => near("x", 65.4) && near("y", 22.2), () => `the drag to land on the pixel at 65.4, 22.2, not ${props(hmi, pageId, panel).x}, ${props(hmi, pageId, panel).y}`);
  await hmi.setProps(pageId, panel, { x: "70" });
  await eventually(async () => (await left(panel))[0] === 60, async () => `a later x to move it, it stays at ${await left(panel)}`);

  await d.tab("Run");
  const ran = page.locator(`.run-layer:not([hidden]) [data-id="${dot}"]`);
  const [box, frame] = [await ran.boundingBox(), await page.locator(`.run-layer:not([hidden]) [data-id="${panel}"]`).boundingBox()];
  check(Math.abs(box.x - (frame.x + frame.width / 2)) < 1.5 && Math.abs(box.y - (frame.y + frame.height / 2)) < 1.5, "the run does not put the dot at the panel's middle");

  // turned, a new origin leaves the panel and the dot it holds where they are drawn
  await d.tab("Design");
  await hmi.setProps(pageId, panel, { rotate: "30" });
  await d.select("panel");
  await page.waitForTimeout(300);
  const boxes = async () => [await d.el(panel).boundingBox(), await d.el(dot).boundingBox()].flatMap((b) => [b.x, b.y, b.width, b.height]);
  const before = await boxes();
  // picked from the nine points of its box
  await page.locator('.screen:not([hidden]) .sidebar.right .lead[title="Pick a point of its box"]').click();
  await page.locator('.popover .point[title="Bottom right"]').click();
  await eventually(() => props(hmi, pageId, panel).origin === '"100% 100%"', "the new origin"); 
  let after = [];
  await eventually(async () => (after = await boxes()).every((v, i) => Math.abs(v - before[i]) < 1), () => `the panel and dot moved from ${before.map(Math.round)} to ${after.map(Math.round)}`);
}
