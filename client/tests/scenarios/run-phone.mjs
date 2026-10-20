// An operator opens the HMI on a phone held upright: the page's blocks stack one under another
// in reading order, all at one zoom along the left, and the page scrolls to the last of them.

export default async function ({ page, hmi, sys, check }) {
  const pageId = await hmi.addPage("Phone");
  const block = (name, x, y, w, h) => hmi.addElement(pageId, "div", { name, x: String(x), y: String(y), w: String(w), h: String(h), background: "#2a2f35" });
  const header = await block("Header", 44, 0, 638, 88);
  const right = await block("Right", 726, 132, 638, 528);
  const left = await block("Left", 44, 154, 638, 528);
  const footer = await block("Footer", 44, 704, 638, 88);
  hmi.send({ type: "set_start", page: pageId });

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 600 } });
  const screen = await phone.newPage();
  await screen.goto(`${sys.url}/run`);
  const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await el(footer).waitFor();
  const boxes = await Promise.all([header, left, right, footer].map((id) => el(id).boundingBox()));
  check(boxes.every((b, i) => i === 0 || b.y >= boxes[i - 1].y + boxes[i - 1].height), "the blocks are not one under another in reading order");
  check(boxes.every((b) => Math.abs(b.x - boxes[0].x) < 1), "the blocks do not line up along the left");
  check(Math.abs(boxes[1].height / boxes[0].height - 528 / 88) < 0.01, "the blocks are not at one zoom");
  const layer = screen.locator(".run-layer:not([hidden])");
  check(await layer.evaluate((l) => l.classList.contains("stacked") && l.scrollHeight > l.clientHeight), "the stacked page does not scroll");
  await phone.close();
}
