// A designer sees on the board only the panel a view picks, as a repeat of none hides the others
// as it does when running. The board's run button runs the pages there: a tap switches the view,
// while a drag and Delete edit nothing and a panel hidden still picks from the layers. Turned
// off, a click picks again.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.boardView", "a");
  const pageId = await hmi.addPage("Board run");
  const tab = await hmi.addElement(pageId, "div", { name: "Tab B", x: "4", y: "4", w: "10", h: "5", background: "#4a8fd6" });
  await hmi.setHandler(pageId, tab, "tap", 'Hmi.boardView = "b";');
  const panel = (name, view, colour) => ({ name, x: "4", y: "12", w: "40", h: "20", repeat: `Hmi.boardView == "${view}" ? 1 : 0`, background: colour });
  const a = await hmi.addElement(pageId, "div", panel("Panel A", "a", "#335"));
  const b = await hmi.addElement(pageId, "div", panel("Panel B", "b", "#533"));
  await d.openPage("Board run");
  const drawn = async (id) => (await d.el(id).count()) === 1;
  await eventually(async () => (await drawn(a)) && !(await drawn(b)), "the board to draw Panel A alone");

  const run = page.locator(".artboard .zoom button:has(svg.lucide-play)");
  await run.click();
  check(await run.evaluate((e) => e.classList.contains("on")), "the run button is not lit while the board runs");
  await d.el(tab).click();
  await eventually(async () => (await drawn(b)) && !(await drawn(a)), "a tap on the running board to switch to Panel B");
  check((await page.locator(".artboard .ring").count()) === 0, "a press on the running board picked something");

  await d.drag(tab, 40, 0);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  check(props(hmi, pageId, tab).x === "4", `a drag on the running board moved Tab B to ${props(hmi, pageId, tab).x}`);
  check(!!hmi.page(pageId).children.find((e) => e.id === tab), "Delete removed Tab B while the board ran");

  // a hidden panel still picks from the layers, ringed where it would show, with no grips
  await d.select("Panel A");
  await eventually(async () => (await page.locator(".artboard .ring").count()) === 1, "Panel A to be ringed");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "the running board offers grips");

  await run.click();
  await d.pick(tab);
  check((await page.locator(".artboard .ring .handle").count()) > 0, "editing again offers no grips");
  check(await drawn(b), "Panel B went away once the board stopped running");
}
