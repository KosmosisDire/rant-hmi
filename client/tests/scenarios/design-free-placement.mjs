// A part of a laid out frame is placed freely from the inspector: it stays where it was drawn,
// the parts after it close up, its x and y show and a drag moves it over the layout, which
// leaves it out, from the end of it the part closed up over it leaves bare. Put back in the
// layout, it takes its place in the column again.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Free parts");
  const column = await hmi.addElement(pageId, "div", { name: "Column", x: "4", y: "4", w: "hug", h: "hug", layout: '"down"', gap: "1", padding: "1", background: "#2a2f35" });
  const parts = [];
  for (const [i, colour] of ["#d2574b", "#4a8fd6", "#3fa66b"].entries()) parts.push(await hmi.addElement(pageId, "div", { name: `F${i}`, w: i === 1 ? "12" : "8", h: "4", background: colour }, column));
  await d.openPage("Free parts");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const [was, third] = [await d.box(parts[1]), await d.box(parts[2])];
  const near = (a, b) => Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;

  await d.pick(parts[1]);
  check((await d.field("x").count()) === 0, "a part the column lays out offers x");
  await right.locator(".ghost", { hasText: "Place it freely" }).click();
  await eventually(() => props(hmi, pageId, parts[1]).position === '"absolute"', "the part placed freely");
  check(near(await d.box(parts[1]), was), `the freed part moved from ${JSON.stringify(was)} to ${JSON.stringify(await d.box(parts[1]))}`);
  const { x, y } = props(hmi, pageId, parts[1]);
  check(x === "1" && y === "6", `the freed part's x and y read ${x} and ${y}`);
  await eventually(async () => near(await d.box(parts[2]), { x: was.x, y: was.y }), "the last part to close up into its place");
  await d.field("x").waitFor();

  // over the layout a drag moves it, with grips to size it
  check((await page.locator(".artboard .ring .handle").count()) === 8, "the freed part offers no grips");
  const k = (await page.locator(".artboard .page-layer.open > .page").boundingBox()).width / 128;
  const b = await d.box(parts[1]);
  await d.gesture(b.x + b.width - 2 * k, b.y + b.height / 2, 20 * k, 3 * k);
  await eventually(() => props(hmi, pageId, parts[1]).x === "21" && props(hmi, pageId, parts[1]).y === "9", () => `the drag to move it, it is at ${props(hmi, pageId, parts[1]).x}, ${props(hmi, pageId, parts[1]).y}`);

  await right.locator(".ghost", { hasText: "Put it back in the layout" }).click();
  await eventually(() => props(hmi, pageId, parts[1]).position === undefined, "the part back in the layout");
  await eventually(async () => near(await d.box(parts[1]), was) && near(await d.box(parts[2]), third), "the column as it was");
}
