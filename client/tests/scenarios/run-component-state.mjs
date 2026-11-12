// A designer gives a hold button a variable of its own from the inspector, a bar that fills
// with root.heldFor and a hold handler that counts. Held long enough, it counts once, the bar
// fills as it goes and empties on release, and each instance keeps its own count.

export default async function ({ page, hmi, d, check, eventually }) {
  const button = await hmi.addComponent("HoldButton");
  await hmi.edit({ kind: "resize_page", page: button, width: 20, height: 8 });
  await d.openPage("HoldButton");

  // state from the inspector, named count, starting at 0
  await d.addState("count", "0");
  await eventually(() => hmi.page(button).state[0]?.name === "count", "the state named count");

  const face = await hmi.addElement(button, "div", { name: "face", x: "0", y: "0", w: "20", h: "8", background: "#2a2f35", "border-radius": "0.8" });
  await hmi.addElement(button, "div", { name: "bar", x: "0", y: "7.2", w: "20 * Math.min(root.heldFor / 600, 1)", h: "0.8", background: "#4a8fd6" }, face);
  await hmi.addElement(button, "span", { name: "label", x: "2", y: "2", w: "16", h: "4", text: 'count + " holds"', color: "#e4e6e8", "font-size": "2" }, face);

  // completion offers the parts' pointer state after a dot
  await d.el(face).waitFor();
  await d.select("face");
  await d.addEvent("hold");
  await d.code("hold").click();
  await page.keyboard.type("root.");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).join() === "pressed,hovered,heldFor", "the pointer state offered");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("count = count + 1;");
  await page.keyboard.press("Control+Enter");
  const after = page.locator(".screen:not([hidden]) .sidebar.right .event .event-when .field", { has: page.locator("label", { hasText: "After ms" }) }).locator("input");
  await after.fill("600");
  await after.press("Enter");
  const hold = () => hmi.page(button).children.find((e) => e.id === face).handlers.find((h) => h.event === "hold");
  await eventually(() => hold()?.code === "count = count + 1;" && hold()?.attrs.after === "600", "the hold handler and its time");

  const pageId = await hmi.addPage("Holds");
  const place = (x) => hmi.addElement(pageId, "use", { name: "Hold", x: String(x), y: "4", w: "20", h: "8" }, null, "HoldButton");
  const first = await place(4);
  const second = await place(28);
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
  let [seen, look] = [0, ""];
  const filling = async () => {
    look = await inst(first).locator('.el[data-name="face"]').getAttribute("class");
    return (seen = await bar(first)) > 20 && seen < 200;
  };
  await eventually(filling, () => `the bar to fill part way, it is ${seen} wide and the face is ${look}`, 550);
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

  // what a component holds keeps state too, each copy of a repeat and each instance its own
  const lamps = await hmi.addComponent("Lamps");
  await hmi.edit({ kind: "resize_page", page: lamps, width: 30, height: 4 });
  const row = await hmi.addElement(lamps, "div", { name: "row", x: "0", y: "0", w: "30", h: "4", layout: '"right"' });
  const lamp = await hmi.addElement(lamps, "span", { name: "lamp", repeat: "3", w: "10", h: "4", text: 'lit ? "on" : "off"' }, row);
  await hmi.edit({ kind: "set_state", page: lamps, id: lamp, name: "lit", var: { name: "lit", start: false, per: "screen" } });
  await hmi.setHandler(lamps, lamp, "tap", "lit = !lit;");
  const shelf = await hmi.addPage("Shelf");
  const put = (y) => hmi.addElement(shelf, "use", { name: "Lamps", x: "4", y: String(y), w: "30", h: "4" }, null, "Lamps");
  const [upper, lower] = [await put(4), await put(12)];
  await d.tab("Design");
  await d.openPage("Shelf");
  await d.tab("Run");
  const lit = async (id) => (await inst(id).locator('.el[data-name="lamp"]').allTextContents()).join(" ");
  await eventually(async () => (await lit(upper)) === "off off off", "the lamps to start off");
  await inst(upper).locator('.el[data-name="lamp"]').nth(1).click();
  await eventually(async () => (await lit(upper)) === "off on off", async () => `a tap to light the middle lamp alone, it shows ${await lit(upper)}`);
  check((await lit(lower)) === "off off off", `the other instance shows ${await lit(lower)}`);
}
