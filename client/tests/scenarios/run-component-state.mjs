// A designer gives a hold button a variable of its own from the inspector, a bar that fills
// with root.heldFor and a hold handler that counts. Held long enough, it counts once, the bar
// fills as it goes and empties on release, and each instance keeps its own count.

export default async function ({ page, hmi, d, check, eventually }) {
  const button = await hmi.addComponent("HoldButton");
  await hmi.edit({ kind: "resize_page", page: button, width: 220, height: 88 });
  await d.openPage("HoldButton");
  const interface_ = () => hmi.page(button).interface;

  // a variable from the inspector, renamed, starting at 0
  await page.locator('.screen:not([hidden]) .sidebar.right button[title="Add a variable"]').click();
  await eventually(() => interface_().variables.length === 1, "a variable");
  const name = page.locator(".screen:not([hidden]) .sidebar.right .handler .input-name").last();
  await name.fill("count");
  await name.press("Enter");
  await eventually(() => interface_().variables[0]?.name === "count", "the variable renamed");

  const face = await hmi.addElement(button, "div", { name: "face", x: "0", y: "0", w: "220", h: "88", background: "#2a2f35", "border-radius": "8" });
  await hmi.addElement(button, "div", { name: "bar", x: "0", y: "80", w: "220 * Math.min(root.heldFor / 600, 1)", h: "8", background: "#4a8fd6" }, face);
  await hmi.addElement(button, "span", { name: "label", x: "22", y: "22", w: "176", h: "44", text: 'count + " holds"', color: "#e4e6e8", "font-size": "22" }, face);

  // completion offers the parts' pointer state after a dot
  await page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: /^face$/ }) }).click();
  await d.addEvent("hold");
  await d.code("hold").click();
  await page.keyboard.type("root.");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).join() === "pressed,hovered,heldFor", "the pointer state offered");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("count = count + 1;");
  await page.keyboard.press("Control+Enter");
  const after = page.locator(".screen:not([hidden]) .sidebar.right .event .event-when input");
  await after.fill("600");
  await after.press("Enter");
  const hold = () => hmi.page(button).children.find((e) => e.id === face).handlers.find((h) => h.event === "hold");
  await eventually(() => hold()?.code === "count = count + 1;" && hold()?.after === "600", "the hold handler and its time");

  const pageId = await hmi.addPage("Holds");
  const place = (x) => hmi.addElement(pageId, "use", { name: "Hold", x: String(x), y: "44", w: "220", h: "88" }, null, "HoldButton");
  const first = await place(44);
  const second = await place(308);
  await d.openPage("Holds");
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const label = (id) => inst(id).locator(".instance .el.text");
  const bar = async (id) => (await inst(id).locator('.instance .el[data-name="bar"]').boundingBox())?.width ?? 0;
  await eventually(async () => (await label(first).textContent()) === "0 holds", "the count to start at 0");

  const b = await inst(first).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  // seen part filled while the hold goes on, before its time is up
  let seen = 0;
  await eventually(async () => (seen = await bar(first)) > 20 && seen < 200, () => `the bar to fill part way, it is ${seen} wide`, 550);
  await eventually(async () => (await label(first).textContent()) === "1 holds", "the hold to count once its time is up");
  await page.waitForTimeout(400);
  check((await label(first).textContent()) === "1 holds", "a long hold counted more than once");
  await page.mouse.up();
  await eventually(async () => (await bar(first)) === 0, "the bar to empty on release");

  // a press let go early counts nothing, and the other instance keeps its own
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(600);
  check((await label(first).textContent()) === "1 holds", "a short press counted");
  check((await label(second).textContent()) === "0 holds", "the second instance shares the first one's count");
}
