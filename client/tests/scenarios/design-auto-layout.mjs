// A frame lays out what it holds: in a row with a gap and padding, hugging them; reversed;
// down a column centred; spread over its length with an auto gap; with one part filling the
// room left; and wrapped. A part it lays out shows its ring where it is drawn, offers no grips,
// and a drag leaves its x be. The inspector lays a frame out from its Auto layout section, and
// a part it lays out offers its size, not its x and y.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Rows");
  const row = await hmi.addElement(pageId, "div", { name: "Row", x: "40", y: "40", w: "hug", h: "hug", layout: '"right"', gap: "10", padding: "10", background: "#2a2f35" });
  const parts = [];
  for (const [i, colour] of ["#d2574b", "#4a8fd6", "#3fa66b"].entries()) parts.push(await hmi.addElement(pageId, "div", { name: `P${i}`, x: String(500 + i), y: "300", w: "60", h: "40", background: colour }, row));
  await d.openPage("Rows");
  const k = async () => (await page.locator(".artboard .page").boundingBox()).width / 1408;
  // where each sits in the row, in page pixels from the row's corner
  const at = async (id) => {
    const [r, b, z] = [await d.box(row), await d.box(id), await k()];
    return [Math.round((b.x - r.x) / z), Math.round((b.y - r.y) / z), Math.round(b.width / z), Math.round(b.height / z)];
  };
  const size = async () => {
    const [r, z] = [await d.box(row), await k()];
    return [Math.round(r.width / z), Math.round(r.height / z)];
  };
  const set = (id, p) => hmi.setProps(pageId, id, p);
  const shows = (what, fn) => eventually(fn, what, 2000);

  await shows("the row to hug its parts", async () => (await size()).join() === "220,60");
  check((await at(parts[0])).join() === "10,10,60,40" && (await at(parts[2])).join() === "150,10,60,40", `the parts sit at ${await at(parts[0])} and ${await at(parts[2])}`);

  await set(row, { layout: '"left"' });
  await shows("the reversed row to start at the right", async () => (await at(parts[0]))[0] === 150 && (await at(parts[2]))[0] === 10);

  await set(row, { layout: '"down"', align: '"center"', w: "300" });
  await shows("a centred column", async () => (await size()).join() === "300,160" && (await at(parts[1])).join() === "120,60,60,40");

  await set(row, { gap: '"auto"', h: "300" });
  await shows("an auto gap to spread them", async () => (await at(parts[0]))[1] === 10 && (await at(parts[2]))[1] === 250 && (await at(parts[1]))[1] === 130);

  await set(row, { layout: '"right"', gap: "10", align: null, w: "400", h: "hug" });
  await set(parts[1], { w: "fill" });
  await shows("the fill to take the room left", async () => (await at(parts[1])).join() === "80,10,240,40");

  await set(parts[1], { w: "60" });
  await set(row, { w: "150", wrap: "true" });
  await shows("the parts to wrap", async () => (await at(parts[2])).join() === "10,60,60,40");

  // a part the row lays out: its ring where it is drawn, no grips, and a drag moves nothing
  await d.el(parts[2]).click();
  const [ring, drawn] = [await page.locator(".artboard .ring").boundingBox(), await d.box(parts[2])];
  check(Math.abs(ring.x - drawn.x) < 2 && Math.abs(ring.y - drawn.y) < 2 && Math.abs(ring.width - drawn.width) < 2, "the ring is not where the part is drawn");
  check((await page.locator(".artboard .ring .handle").count()) === 0, "a part the row lays out shows grips");
  await d.drag(parts[2], 60, 60);
  await page.waitForTimeout(300);
  check(props(hmi, pageId, parts[2]).x === "502", `a drag moved a part the row lays out to ${props(hmi, pageId, parts[2]).x}`);

  const box = await hmi.addElement(pageId, "div", { name: "Box", x: "40", y: "400", w: "300", h: "200", background: "#2a2f35" });
  for (const name of ["A", "B"]) await hmi.addElement(pageId, "div", { name, x: "0", y: "0", w: "50", h: "50", background: "#4a8fd6" }, box);
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => right.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const is = (key, value) => eventually(() => props(hmi, pageId, box)[key] === value, () => `${key} to be ${value}, not ${props(hmi, pageId, box)[key]}`);
  await d.select("Box");
  await right.locator(".ghost", { hasText: "Lay out what it holds" }).click();
  await is("layout", '"down"');
  await right.locator('button[title="Left to right"]').click();
  await is("layout", '"right"');
  await right.locator('.point[title="Center"]').click();
  await is("align", '"center"');
  await field("Spacing").locator("button", { hasText: /^Spread$/ }).click();
  await is("gap", '"auto"');
  await field("Width").locator("button", { hasText: /^Hug$/ }).click();
  await is("w", "hug");
  await shows("the box to hug its parts", async () => Math.round((await d.box(box)).width / (await k())) === 100);
  await field("Width").locator("button", { hasText: /^Fixed$/ }).click();
  await is("w", "100");
  await d.select("A");
  await field("Width").waitFor();
  check((await right.locator(".placement .lead", { hasText: /^x$/ }).count()) === 0, "a part the box lays out offers x");
  await field("Width").locator("button", { hasText: /^Fill$/ }).click();
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === box).children[0].props.w === "fill", "A to fill");
}
