// A user picks several elements with Shift and Ctrl: a drag moves them together as one undo,
// the arrows nudge them, Ctrl A takes the whole page, and Delete removes them all as one undo.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Many");
  const box = (name, x) => ({ name, x: String(x), y: "44", w: "88", h: "88", background: "#2a2f35" });
  const a = await hmi.addElement(pageId, "div", box("A", 44));
  const b = await hmi.addElement(pageId, "div", box("B", 220));
  const c = await hmi.addElement(pageId, "div", box("C", 396));
  await d.openPage("Many");
  const x = (id) => props(hmi, pageId, id).x;
  const head = page.locator(".screen:not([hidden]) .sidebar.right .head-title");
  const row = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });

  await d.el(a).click();
  await d.el(b).click({ modifiers: ["Shift"] });
  await eventually(async () => (await head.textContent()) === "2 elements", "the inspector to count two");
  check((await page.locator(".artboard .ring").count()) === 2, "a selected element has no ring");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "several show grips");
  check((await page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row.selected").count()) === 2, "the layers do not show both");

  await d.drag(b, 88, 44);
  await eventually(() => x(b) !== "220", "the drag to move B");
  const moved = Number(x(b)) - 220;
  check(Number(x(a)) - 44 === moved && x(c) === "396", `the drag moved A by ${Number(x(a)) - 44} and B by ${moved}, C to ${x(c)}`);
  check(props(hmi, pageId, a).y === props(hmi, pageId, b).y, "A and B left their row");
  await page.keyboard.press("Control+z");
  await eventually(() => x(a) === "44" && x(b) === "220", "one undo to take both back");

  await page.keyboard.press("ArrowRight");
  await eventually(() => x(a) === "55" && x(b) === "231", "the arrows to nudge both");

  await row("C").click({ modifiers: ["Control"] });
  await eventually(async () => (await head.textContent()) === "3 elements", "a layer row to join the selection");
  await d.el(b).click({ modifiers: ["Shift"] });
  await eventually(async () => (await head.textContent()) === "2 elements", "Shift click to take B away");

  await page.keyboard.press("Control+a");
  await eventually(async () => (await head.textContent()) === "3 elements", "Ctrl A to take the page");
  await page.keyboard.press("Delete");
  await eventually(() => hmi.page(pageId).children.length === 0, "Delete to remove all");
  await page.keyboard.press("Control+z");
  await eventually(() => hmi.page(pageId).children.length === 3, "one undo to bring all back");
}
