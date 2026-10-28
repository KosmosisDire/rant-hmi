// Clicks at one point pick what lies there in turn: the outermost frame first, then each
// click one further in, then what lies beneath, then around again. A press on the one picked
// moves it, even one covered by others, and once a frame is entered a click picks its other
// parts directly.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Pick through");
  // added first, so the frame is drawn over it
  const under = await hmi.addElement(pageId, "div", { name: "Under", x: "6", y: "6", w: "10", h: "10", background: "#3fa66b" });
  const frame = await hmi.addElement(pageId, "div", { name: "Over", x: "4", y: "4", w: "30", h: "20", background: "#2a2f35" });
  const part = await hmi.addElement(pageId, "div", { name: "Part", x: "2", y: "2", w: "10", h: "6", background: "#4a8fd6" }, frame);
  const other = await hmi.addElement(pageId, "div", { name: "Other", x: "18", y: "2", w: "10", h: "6", background: "#d2574b" }, frame);
  await d.openPage("Pick through");

  const picked = () => page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id").catch(() => null);
  const board = await page.locator(".artboard .page-layer.open > .page").boundingBox();
  const k = board.width / 128;
  // page units to the screen
  const at = (x, y) => [board.x + x * k, board.y + y * k];
  // over the part, the frame and the one beneath at once
  const [x, y] = at(10, 9);
  const names = { [frame]: "Over", [part]: "Part", [under]: "Under" };
  for (const want of [frame, part, under, frame]) {
    await page.mouse.click(x, y);
    await eventually(async () => (await picked()) === want, async () => `a click to pick ${names[want]}, it picked ${await picked()}`);
  }

  // inside the frame, a click on its other part picks it at once
  await page.mouse.click(x, y);
  await eventually(async () => (await picked()) === part, "the part picked again");
  const [ox, oy] = at(22, 9);
  await page.mouse.click(ox, oy);
  await eventually(async () => (await picked()) === other, async () => `a click on the frame's other part to pick it, it picked ${await picked()}`);

  // the one beneath, picked, moves with a press over the frame and keeps the pick
  for (let n = 0; n < 4 && (await picked()) !== under; n++) await page.mouse.click(x, y);
  check((await picked()) === under, `the clicks never came to Under, at ${await picked()}`);
  await d.gesture(x, y, 4 * k, 2 * k);
  await eventually(() => props(hmi, pageId, under).x === "10" && props(hmi, pageId, under).y === "8", () => `Under moved to ${props(hmi, pageId, under).x}, ${props(hmi, pageId, under).y}`);
  check(props(hmi, pageId, frame).x === "4", `the frame moved to ${props(hmi, pageId, frame).x}`);
  check((await picked()) === under, `the move picked ${await picked()} in place of Under`);
}
