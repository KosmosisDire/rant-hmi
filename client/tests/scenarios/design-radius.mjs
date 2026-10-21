// A designer rounds a frame's corners: a drag on the radius's lead scrubs every corner, a click
// on it opens a field per corner, a first corner of its own starts the others at the one for
// all and takes its place, and one radius for every corner again takes the top left's.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Corners");
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "44", y: "44", w: "264", h: "132", background: "#2a2f35", "border-radius": "8" });
  await d.openPage("Corners");
  await d.el(card).click();
  const now = () => hmi.page(pageId).children[0].props;
  const radius = page.locator(".screen:not([hidden]) .sidebar.right .field", { has: page.locator("label", { hasText: /^Radius$/ }) });
  const lead = radius.locator(".lead");

  const b = await lead.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await eventually(() => Number(now()["border-radius"]) > 8, "a drag on the lead to scrub the radius");
  check((await page.locator(".popover.parts").count()) === 0, "a drag on the lead opened the corners");
  await d.setField("Radius", "8");
  await eventually(() => now()["border-radius"] === "8", "the radius typed back to 8");

  await lead.click();
  const labels = await page.locator(".popover.parts .field label").allTextContents();
  check(labels.join() === "Top left,Top right,Bottom right,Bottom left", `the corners offered are ${labels}`);
  await d.setField("Top left", "20");
  await eventually(() => now()["border-top-left-radius"] === "20" && now()["border-radius"] === undefined, "the corner to take the place of the one for all");
  const others = ["border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"].map((k) => now()[k]);
  check(others.join() === "8,8,8", `the other corners start at ${others}, not 8`);
  const drawn = await d.el(card).evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderTopRightRadius].join());
  check(drawn === "200px,80px", `the corners draw as ${drawn}`);
  await page.keyboard.press("Escape");
  const sum = await radius.locator(".border-sum span").allTextContents();
  check(sum.join() === "20,8,8,8", `the row sums the corners up as ${sum}`);

  await radius.locator('button[title="One radius for every corner"]').click();
  await eventually(() => now()["border-radius"] === "20" && now()["border-top-left-radius"] === undefined, "one radius for every corner, the top left's");
}
