// A designer previews a wide page as an upright phone shows it: its blocks one under another in
// reading order. A click there picks and a drag pans, never moving a block, an edit restacks it
// at once, and the same button brings the page back. A page taller than wide has no preview.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Phone preview");
  const box = (name, x, y, w, h) => ({ name, x: String(x), y: String(y), w: String(w), h: String(h), background: "#2a2f35" });
  // B and C share the top row, B left of it, and A starts below them both
  const a = await hmi.addElement(pageId, "div", box("A", 64, 40, 20, 10));
  const b = await hmi.addElement(pageId, "div", box("B", 4, 4, 30, 10));
  const c = await hmi.addElement(pageId, "div", box("C", 40, 4, 20, 20));
  await d.openPage("Phone preview");
  const phone = page.locator(".artboard .zoom button:has(svg.lucide-smartphone)");
  const sheet = page.locator(".artboard .page");
  const top = (id) => d.el(id).evaluate((e) => e.style.top);
  const head = page.locator(".screen:not([hidden]) .sidebar.right .pane-head");
  const says = (words) => eventually(async () => (await head.textContent())?.includes(words), () => `the inspector to say ${words}`);

  await phone.click();
  check(await phone.evaluate((e) => e.classList.contains("on")), "the phone button is not lit while it previews");
  // the widest block and a margin across, one phone screen down, B then C then A
  await eventually(async () => (await sheet.evaluate((e) => e.style.width)) === "340px", "the page to take the stack's width");
  check((await sheet.evaluate((e) => e.style.height)) === "730px", `the stacked page is ${await sheet.evaluate((e) => e.style.height)} tall, not a phone screen`);
  const tops = [await top(b), await top(c), await top(a)].join();
  check(tops === "20px,140px,360px", `the blocks stack at ${tops}`);

  // a click picks and rings the block where it stacks, with no grips to move it
  await d.pick(a);
  await says("A");
  const [ring, drawn] = [await page.locator(".artboard .ring").boundingBox(), await d.box(a)];
  check(Math.abs(ring.x - drawn.x) < 2 && Math.abs(ring.y - drawn.y) < 2, "the ring is not where A stacks");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "the preview offers grips");
  await d.drag(a, 60, 30);
  const moved = await d.box(a);
  check(Math.abs(moved.x - drawn.x - 60) < 2 && Math.abs(moved.y - drawn.y - 30) < 2, "a drag in the preview did not pan");
  check(props(hmi, pageId, a).x === "64" && props(hmi, pageId, a).y === "40", `a drag in the preview moved A to ${props(hmi, pageId, a).x}, ${props(hmi, pageId, a).y}`);

  // B made wider widens the stack as it lands
  await d.pick(b);
  await says("B");
  await d.setField("w", "40");
  await eventually(async () => (await sheet.evaluate((e) => e.style.width)) === "440px", "the stack to widen with B");

  await phone.click();
  await eventually(async () => (await sheet.evaluate((e) => e.style.width)) === "1280px", "the page to come back");
  check((await top(a)) === "400px", `back on the page A sits at ${await top(a)}`);

  // a page taller than wide shows on a phone as it is
  await hmi.addPage("Phone tall");
  await d.openPage("Phone tall");
  await d.setField("w", "40");
  await d.setField("h", "80");
  await eventually(() => phone.isDisabled(), "the phone button to be off for a tall page");
  check((await phone.getAttribute("title")) === "A page taller than wide shows on a phone as it is", `the button says ${await phone.getAttribute("title")}`);
}
