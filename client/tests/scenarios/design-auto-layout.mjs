// A frame lays out what it holds: in a row with a gap and padding, hugging them; reversed;
// down a column centred; spread over its length with an auto gap; with one part filling the
// room left; and wrapped. A part it lays out shows its ring where it is drawn, its grips make a
// size that fills a number, and a drag takes it to another place in the row, its x left be,
// a line showing where it goes. The inspector lays a frame out from its Auto layout section, and
// a part it lays out offers its size, not its x and y, its w and h labels offering Fixed, Hug or
// Fill where they may.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Rows");
  const row = await hmi.addElement(pageId, "div", { name: "Row", x: "4", y: "4", w: "hug", h: "hug", layout: '"right"', gap: "1", padding: "1", background: "#2a2f35" });
  const parts = [];
  for (const [i, colour] of ["#d2574b", "#4a8fd6", "#3fa66b"].entries()) parts.push(await hmi.addElement(pageId, "div", { name: `P${i}`, x: String(50 + i), y: "30", w: "6", h: "4", background: colour }, row));
  await d.openPage("Rows");
  const k = async () => (await page.locator(".artboard .page").boundingBox()).width / 128;
  // where each sits in the row, in page units from the row's corner, to a tenth
  const at = async (id) => {
    const [r, b, z] = [await d.box(row), await d.box(id), await k()];
    return [(b.x - r.x) / z, (b.y - r.y) / z, b.width / z, b.height / z].map((v) => Math.round(v * 10) / 10);
  };
  const size = async () => {
    const [r, z] = [await d.box(row), await k()];
    return [r.width / z, r.height / z].map((v) => Math.round(v * 10) / 10);
  };
  const set = (id, p) => hmi.setProps(pageId, id, p);
  const shows = (what, fn) => eventually(fn, what, 2000);

  await shows("the row to hug its parts", async () => (await size()).join() === "22,6");
  check((await at(parts[0])).join() === "1,1,6,4" && (await at(parts[2])).join() === "15,1,6,4", `the parts sit at ${await at(parts[0])} and ${await at(parts[2])}`);

  await set(row, { layout: '"left"' });
  await shows("the reversed row to start at the right", async () => (await at(parts[0]))[0] === 15 && (await at(parts[2]))[0] === 1);

  await set(row, { layout: '"down"', align: '"center"', w: "30" });
  await shows("a centred column", async () => (await size()).join() === "30,16" && (await at(parts[1])).join() === "12,6,6,4");

  await set(row, { gap: '"auto"', h: "30" });
  await shows("an auto gap to spread them", async () => (await at(parts[0]))[1] === 1 && (await at(parts[2]))[1] === 25 && (await at(parts[1]))[1] === 13);

  await set(row, { layout: '"right"', gap: "1", align: null, w: "40", h: "hug" });
  await set(parts[1], { w: "fill" });
  await shows("the fill to take the room left", async () => (await at(parts[1])).join() === "8,1,24,4");

  // a side's own padding counts in units too
  await set(row, { padding: null, "padding-left": "3" });
  await shows("a left padding of 3 units", async () => (await at(parts[0]))[0] === 3);
  await set(row, { padding: "1", "padding-left": null });

  await set(parts[1], { w: "6" });
  await set(row, { w: "15", wrap: "true" });
  await shows("the parts to wrap", async () => (await at(parts[2])).join() === "1,6,6,4");

  // a part the row lays out: its ring where it is drawn, and grips that size a fill as a number
  await set(parts[2], { w: "fill" });
  await shows("the last part to fill its line", async () => (await at(parts[2])).join() === "1,6,13,4");
  await d.pick(parts[2]);
  const [ring, drawn] = [await page.locator(".artboard .ring").boundingBox(), await d.box(parts[2])];
  check(Math.abs(ring.x - drawn.x) < 2 && Math.abs(ring.y - drawn.y) < 2 && Math.abs(ring.width - drawn.width) < 2, "the ring is not where the part is drawn");
  check((await page.locator(".artboard .ring .handle").count()) === 8, "a part the row lays out offers no grips");
  await d.resize("e", -5 * (await k()), 0);
  await eventually(() => props(hmi, pageId, parts[2]).w === "8", () => `the fill to become 8 wide, it is ${props(hmi, pageId, parts[2]).w}`);
  await shows("the part drawn 8 wide", async () => (await at(parts[2])).join() === "1,6,8,4");

  // a drag along the row puts it before the first, and its x stays
  const [from, first] = [await d.box(parts[2]), await d.box(parts[0])];
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(from.x + from.width / 2 + ((first.x + 2 - from.x - from.width / 2) * i) / 4, from.y + from.height / 2 + ((first.y + first.height / 2 - from.y - from.height / 2) * i) / 4);
  const slot = await page.locator(".artboard .slot").boundingBox();
  check(slot && Math.abs(slot.x + slot.width / 2 - first.x) < 2 && Math.abs(slot.y - first.y) < 2, `the line shows at ${JSON.stringify(slot)}, not at the first part's ${JSON.stringify(first)}`);
  await page.mouse.up();
  const order = () => hmi.page(pageId).children.find((e) => e.id === row).children.map((c) => c.id).join();
  await eventually(() => order() === [parts[2], parts[0], parts[1]].join(), () => `the part to go first, the row holds ${order()}`);
  check(props(hmi, pageId, parts[2]).x === "52", `a drag moved a part the row lays out to ${props(hmi, pageId, parts[2]).x}`);
  check((await page.locator(".artboard .slot").count()) === 0, "the line stays after the drag");
  await set(parts[2], { w: "6" });

  const box = await hmi.addElement(pageId, "div", { name: "Box", x: "4", y: "40", w: "30", h: "20", background: "#2a2f35" });
  for (const name of ["A", "B"]) await hmi.addElement(pageId, "div", { name, x: "0", y: "0", w: "5", h: "5", background: "#4a8fd6" }, box);
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => right.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const is = (key, value) => eventually(() => props(hmi, pageId, box)[key] === value, () => `${key} to be ${value}, not ${props(hmi, pageId, box)[key]}`);
  await d.select("Box");
  const marked = () => right.locator(".placement .lead .sizes").count();
  check((await marked()) === 0, "a frame that holds nothing laid out offers to hug");
  await right.locator(".ghost", { hasText: "Lay out what it holds" }).click();
  await is("layout", '"down"');
  await is("gap", "$space");
  await right.locator('button[title="Left to right"]').click();
  await is("layout", '"right"');
  await right.locator('.point[title="Center"]').click();
  await is("align", '"center"');
  await field("Spacing").locator("button", { hasText: /^Spread$/ }).click();
  await is("gap", '"auto"');
  await field("Spacing").locator("button", { hasText: /^Packed$/ }).click();
  await is("gap", "$space");
  await field("Spacing").locator("button", { hasText: /^Spread$/ }).click();
  await is("gap", '"auto"');
  await eventually(async () => (await marked()) === 2, "w and h to offer their sizes once it lays out");
  await d.size("w", "Hug");
  await is("w", "hug");
  await shows("the box to hug its parts", async () => Math.round((await d.box(box)).width / (await k())) === 10);
  await d.size("w", "Fixed");
  await is("w", "10");
  await d.select("A");
  await right.locator('.lead.inside[aria-label="w"] .sizes').waitFor();
  check((await right.locator(".placement .lead", { hasText: /^x$/ }).count()) === 0, "a part the box lays out offers x");
  await d.size("w", "Fill");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === box).children[0].props.w === "fill", "A to fill");
}
