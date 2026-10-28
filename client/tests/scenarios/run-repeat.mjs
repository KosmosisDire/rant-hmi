// A designer repeats a frame six times from the inspector, places each copy by its index and
// marks the one an operator last pressed. Completion offers index, the ring sits on the first
// copy, and a press on the fourth copy tells its handler index 3.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.axis", -1);
  const pageId = await hmi.addPage("Axes");
  await d.openPage("Axes");
  await d.addRow("Frame");
  await eventually(() => hmi.page(pageId).children.length === 1, "a frame");
  const id = hmi.page(pageId).children[0].id;
  const props = () => hmi.page(pageId).children[0].props;

  await d.setField("Repeat", "6");
  await d.setField("w", "110");
  const x = d.field("x");
  await x.click();
  await x.fill("44 + ");
  await page.keyboard.type("ind");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).includes("index"), "completion to offer index");
  await page.keyboard.type("ex * 132");
  await x.press("Enter");
  await d.setField("Fill", 'index === Hmi.axis ? "#4a8fd6" : "#2a2f35"');
  await eventually(() => props().repeat === "6" && props().x === "44 + index * 132", "the repeat and its placement");
  await d.addEvent("press");
  await d.code("press").click();
  await page.keyboard.type("Hmi.axis = index;");
  await page.keyboard.press("Control+Enter");
  await eventually(() => hmi.page(pageId).children[0].handlers[0]?.code === "Hmi.axis = index;", "the press handler");

  const copies = d.el(id);
  await eventually(async () => (await copies.count()) === 6, "six copies on the artboard");
  const [ring, first] = [await page.locator(".ring").first().boundingBox(), await copies.first().boundingBox()];
  check(Math.abs(ring.x - first.x) < 2 && Math.abs(ring.width - first.width) < 2, `the ring is at ${ring.x}, the first copy at ${first.x}`);

  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await run.count()) === 6, "six copies running");
  await run.nth(3).click();
  await eventually(() => hmi.state.values["Hmi.axis"]?.value === 3, "the fourth copy's press to set axis to 3");
  const fill = (n) => run.nth(n).evaluate((e) => getComputedStyle(e).backgroundColor);
  await eventually(async () => (await fill(3)) === "rgb(74, 143, 214)" && (await fill(2)) !== "rgb(74, 143, 214)", "only the pressed copy marked");
}
