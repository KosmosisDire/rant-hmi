// An import whose lists hold lists: the robot's routes, each leg a list of points, and a name per
// route. The Data tab names each list's type and the fields of its records, and a page reads an
// item of an item, which comes on its own as it moves.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Routes", "Cell/Routes");
  const pageId = await hmi.addPage("Routes");
  const shown = await hmi.addElement(pageId, "span", { name: "Last", x: "4", y: "4", w: "60", h: "4", text: '`${Routes.names[1]}: ${Routes.legs[1].pts[2].x.toFixed(2)}`' });

  await d.tab("Data");
  const on = (css) => page.locator(`.screen:not([hidden]) ${css}`);
  await on(".detail tr.row").filter({ has: page.locator("td.name .mono", { hasText: /^Routes$/ }) }).click();
  const tag = async (name) => ((await on(".sidebar.right .vrow").filter({ has: page.locator(".vname", { hasText: new RegExp(`^${name}$`) }) }).first().locator(".tag").textContent()) ?? "").trim();
  await eventually(async () => (await tag("legs")) === "Leg[]", async () => `legs tagged Leg[], not ${await tag("legs")}`);
  check((await tag("names")) === "string[]", `names tagged ${await tag("names")}`);
  // a list of records shows its items' fields, a list of points among them
  await eventually(async () => (await tag("pts")) === "Double2[]", async () => `a leg's points tagged Double2[], not ${await tag("pts")}`);

  await d.openPage("Routes");
  const text = () => d.el(shown).textContent();
  await eventually(async () => /^place and return: \d\.\d\d$/.test((await text()) ?? ""), async () => `the second route's name and its last point, not ${await text()}`);
  const first = await text();
  await eventually(async () => (await text()) !== first, "the last point to move as the routes come");
}
