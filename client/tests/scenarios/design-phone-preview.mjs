// A designer previews a wide page as an upright phone lays it out: as wide as the phone and at
// least as tall, its bands in reading order across the whole width. A click there picks and
// a drag pans, never moving a block, an edit lays it out again at once, and the same button
// brings the page back. A page taller than wide has no preview.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Phone preview");
  const box = (name, x, y, w, h) => ({ name, x: String(x), y: String(y), w: String(w), h: String(h), background: "#2a2f35" });
  // B and C share the top band, B left of it, and A starts below them both
  const a = await hmi.addElement(pageId, "div", box("A", 64, 40, 20, 10));
  const b = await hmi.addElement(pageId, "div", box("B", 4, 4, 30, 10));
  const c = await hmi.addElement(pageId, "div", box("C", 40, 4, 20, 20));
  await d.openPage("Phone preview");
  const phone = page.locator(".artboard .zoom button:has(svg.lucide-smartphone)");
  const sheet = page.locator(".artboard .page");
  const head = page.locator(".screen:not([hidden]) .sidebar.right .pane-head");
  const says = (words) => eventually(async () => (await head.textContent())?.includes(words), () => `the inspector to say ${words}`);

  await phone.click();
  check(await phone.evaluate((e) => e.classList.contains("on")), "the phone button is not lit while it previews");
  await eventually(async () => (await sheet.evaluate((e) => [e.style.width, e.style.minHeight].join())) === "390px,844px", "the page to take the phone's width and height");
  // B and C are too wide to share a line, so each fills one, then A
  const [pb, pc, pa, ps] = [await d.box(b), await d.box(c), await d.box(a), await sheet.boundingBox()];
  check(pb.y + pb.height <= pc.y && pc.y + pc.height <= pa.y, "the blocks do not read B, C then A down the phone");
  check([pa, pb, pc].every((x) => Math.abs(x.width - pb.width) < 1 && x.width > ps.width * 0.85), "the blocks do not each fill the phone's width");

  // a click picks and rings the block where the phone lays it, with no grips to move it
  await d.pick(a);
  await says("A");
  const [ring, drawn] = [await page.locator(".artboard .ring").boundingBox(), await d.box(a)];
  check(Math.abs(ring.x - drawn.x) < 2 && Math.abs(ring.y - drawn.y) < 2 && Math.abs(ring.width - drawn.width) < 2, "the ring is not where A is laid out");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "the preview offers grips");
  await d.drag(a, 60, 30);
  const moved = await d.box(a);
  check(Math.abs(moved.x - drawn.x - 60) < 2 && Math.abs(moved.y - drawn.y - 30) < 2, "a drag in the preview did not pan");
  check(props(hmi, pageId, a).x === "64" && props(hmi, pageId, a).y === "40", `a drag in the preview moved A to ${props(hmi, pageId, a).x}, ${props(hmi, pageId, a).y}`);

  // C made narrow lets it share B's line as it lands
  await d.pick(c);
  await says("C");
  await d.setField("w", "10");
  await eventually(async () => Math.abs((await d.box(c)).y - (await d.box(b)).y) < 1, "C to join B's line");

  await phone.click();
  await eventually(async () => (await sheet.evaluate((e) => e.style.width)) === "1280px", "the page to come back");
  check((await d.el(a).evaluate((e) => e.style.top)) === "400px", `back on the page A sits at ${await d.el(a).evaluate((e) => e.style.top)}`);

  // a page taller than wide shows on a phone as it is
  await hmi.addPage("Phone tall");
  await d.openPage("Phone tall");
  await d.setField("w", "40");
  await d.setField("h", "80");
  await eventually(() => phone.isDisabled(), "the phone button to be off for a tall page");
  check((await phone.getAttribute("title")) === "A page taller than wide shows on a phone as it is", `the button says ${await phone.getAttribute("title")}`);
}
