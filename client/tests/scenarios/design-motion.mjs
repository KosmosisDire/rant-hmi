// A frame's changes animate, set field by field from each field's menu: the fill starts at
// 300 ms, its popover changes the time and the ease, and a mark beside the field shows it
// and opens it again. Design draws no motion, so a drag follows the pointer, while Run
// animates each property as set, and a stop leaves the others.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Motion");
  const lamp = await hmi.addElement(pageId, "div", { name: "Lamp", x: "4", y: "4", w: "10", h: "6", background: "#3fa66b" });
  await d.openPage("Motion");
  await d.select("Lamp");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => right.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const transition = () => props(hmi, pageId, lamp).transition;

  await d.menu(field("Fill").locator("label"), "Animate changes");
  await eventually(() => transition() === '"background 300ms ease"', () => `the fill to animate, the transition is ${transition()}`);
  const popover = page.locator(".popover.motion");
  const time = popover.locator(".field", { has: page.locator("label", { hasText: "Time, ms" }) }).locator("input");
  await time.fill("500");
  await time.press("Enter");
  await popover.locator(".choice button", { hasText: /^Out$/ }).click();
  await eventually(() => transition() === '"background 500ms ease-out"', () => `the time and the ease, the transition is ${transition()}`);
  await page.keyboard.press("Escape");
  await field("Fill").locator(".motion-mark").waitFor();

  await d.menu(right.locator('.lead.inside[aria-label="x"]'), "Animate changes");
  await eventually(() => transition() === '"background 500ms ease-out, left 300ms ease"', () => `x to animate too, the transition is ${transition()}`);
  await page.keyboard.press("Escape");
  check((await right.locator(".field.inside > .motion-mark").count()) === 1, "x shows no mark");

  const drawn = (l) => l.evaluate((e) => [getComputedStyle(e).transitionProperty, getComputedStyle(e).transitionDuration].join(" / "));
  check((await drawn(d.el(lamp))) === "all / 0s", `Design draws motion: ${await drawn(d.el(lamp))}`);
  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${lamp}"]`);
  await eventually(async () => (await drawn(run)) === "background, left / 0.5s, 0.3s", async () => `Run to animate both, it draws ${await drawn(run)}`);

  await d.tab("Design");
  await d.select("Lamp");
  await field("Fill").locator(".motion-mark").click();
  await popover.locator(".ghost", { hasText: "Stop animating" }).click();
  await eventually(() => transition() === '"left 300ms ease"', () => `only x to animate, the transition is ${transition()}`);
  check((await field("Fill").locator(".motion-mark").count()) === 0, "the fill still shows its mark");
}
