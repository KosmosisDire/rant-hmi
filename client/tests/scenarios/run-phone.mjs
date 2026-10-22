// An operator opens the HMI on a phone held upright: the page is laid out again for its width,
// unzoomed. What sits on a panel stays on it, a label over a diagram stays over it, a row of
// small blocks stays a row, a repeat's copies stay apart, a row too wide wraps inside the
// screen, bands read top to bottom, and the page scrolls to its foot.

export default async function ({ page, hmi, sys, check }) {
  const pageId = await hmi.addPage("Phone");
  const add = (tag, name, x, y, w, h, more = {}, parent = null) => hmi.addElement(pageId, tag, { name, x: String(x), y: String(y), w: String(w), h: String(h), background: "#2a2f35", ...more }, parent);
  const bar = await add("div", "Bar", 1, 1, 126, 5, { layout: '"right"', gap: "1" });
  for (let i = 0; i < 5; i++) await add("div", `Bar part ${i}`, 0, 0, 20, 4, {}, bar);
  const panel = await add("div", "Panel", 1, 8, 40, 20);
  const reading = await add("span", "Panel reading", 3, 10, 20, 3, { text: '"Speed"', background: "#3a4048" });
  const picture = await add("svg", "Picture", 44, 8, 30, 20, { viewbox: '"0 0 30 20"' });
  const label = await add("span", "Picture label", 46, 9, 10, 2, { text: '"Cam"', background: "#3a4048" });
  const tank = await add("div", "Tank", "80 + index * 9", 8, 7, 20, { repeat: "3" });
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await add("div", `Key ${i}`, 1 + i * 9, 32, 8, 4));
  const foot = await add("div", "Foot", 1, 60, 60, 10);
  hmi.send({ type: "set_start", page: pageId });

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 600 } });
  const screen = await phone.newPage();
  await screen.goto(`${sys.url}/run`);
  const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await el(foot).waitFor();
  const box = (id) => el(id).first().boundingBox();
  const holds = (outer, inner) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

  check(holds(await box(panel), await box(reading)), "the reading left the panel it sits on");
  check(holds(await box(picture), await box(label)), "the label left the diagram it marks");
  const k = await Promise.all(keys.map(box));
  check(k.every((b) => Math.abs(b.y - k[0].y) < 1) && k.every((b, i) => i === 0 || b.x > k[i - 1].x), "the row of keys did not stay a row");
  check(Math.abs(k[0].height - 40) < 1, `a 4 unit key is ${k[0].height} px tall, not 40`);
  const copies = await el(tank).evaluateAll((all) => all.map((e) => e.getBoundingClientRect().x));
  check(copies.length === 3 && new Set(copies.map(Math.round)).size === 3, `the tank's copies sit at ${copies}`);
  const parts = await Promise.all([0, 1, 2, 3, 4].map((i) => screen.locator(`.el[data-name="Bar part ${i}"]`).boundingBox()));
  check(parts.some((b) => b.y > parts[0].y + 1), "the bar too wide for the phone did not wrap");
  check(parts.every((b) => b.x + b.width <= 390), "a part of the bar runs off the screen");
  const order = await Promise.all([bar, panel, picture, keys[0], foot].map(box));
  check(order.every((b, i) => i === 0 || b.y >= order[i - 1].y + order[i - 1].height), "the bands do not read top to bottom");
  const layer = screen.locator(".run-layer:not([hidden])");
  check(await layer.evaluate((l) => l.classList.contains("phone") && l.scrollHeight > l.clientHeight), "the phone page does not scroll");
  check(await layer.evaluate((l) => l.scrollWidth <= l.clientWidth), "the phone page runs wider than the screen");
  await phone.close();
}
