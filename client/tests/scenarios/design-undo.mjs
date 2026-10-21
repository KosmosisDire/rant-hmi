// A new user builds, changes their mind, and steps back and forth with Ctrl Z and Ctrl Y:
// every step comes back exactly, a deleted element returns selected, a deleted page reopens.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Undo");
  await d.openPage("Undo");
  await d.addRow("Frame");
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the frame");
  const at = () => props(hmi, pageId, id);
  const start = { ...at() };

  await d.drag(id, 110, 0);
  await eventually(() => at().x !== start.x, "the move");
  const moved = at().x;
  await d.setField("Fill", "#ff0000");
  await eventually(() => at().background === "#ff0000", "the fill");
  await page.locator(".artboard").click({ position: { x: 5, y: 5 } });
  await d.el(id).click();
  await page.keyboard.press("Delete");
  await eventually(() => !at(), "the delete");

  await page.keyboard.press("Control+z");
  await eventually(() => at()?.background === "#ff0000", "undo to bring the frame back");
  await eventually(async () => (await page.locator(".list-row.selected", { hasText: "Frame" }).count()) > 0, "the frame to come back selected");
  await page.keyboard.press("Control+z");
  await eventually(() => at().background === start.background, "undo to put the fill back");
  await page.keyboard.press("Control+z");
  await eventually(() => at().x === start.x, "undo to put the frame back in place");
  await page.keyboard.press("Control+Shift+z");
  await eventually(() => at().x === moved, "redo to move it again");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await eventually(() => !at(), "undo to take the frame away");
  await page.keyboard.press("Control+y");
  await eventually(() => at()?.x === start.x, "redo to add it back");

  // a field keeps Ctrl Z for its own text
  await d.field("Name").click();
  await page.keyboard.type(" two");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Escape");
  check(at() !== undefined, "Ctrl Z in a field undid an edit");

  // the page: resize, delete, and back
  await page.locator(".artboard").click({ position: { x: 5, y: 5 } });
  await d.setField("h", "844");
  await d.setField("w", "390");
  await eventually(() => hmi.page(pageId)?.width === 390 && hmi.page(pageId)?.height === 844, "the new size");
  await d.menu(page.locator(".screen:not([hidden]) .pages :is(.list-row, .card)", { has: page.getByText("Undo", { exact: true }) }), "Delete page");
  await eventually(() => !hmi.page(pageId), "the page to go");
  await eventually(async () => (await page.locator(".pages .list-row", { hasText: "Undo" }).count()) === 0, "the deleted page to leave the list");
  await page.keyboard.press("Control+z");
  await eventually(() => hmi.page(pageId)?.width === 390, "undo to bring the page back");
  await page.locator(".pages .list-row.selected", { hasText: "Undo" }).waitFor();
}
