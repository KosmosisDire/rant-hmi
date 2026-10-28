// A user writes event code with help: the add list sets a component's own events apart from the
// pointer's and says what each sends, each card says what p brings, and p's fields come up in a
// list that floats whole under the line typed, in the inspector and in an object's logic alike.

export default async function ({ page, hmi, d, check, eventually }) {
  const pad = await hmi.addComponent("Pad");
  await hmi.edit({ kind: "set_event", page: pad, name: "move", to: "move" });
  const face = await hmi.addElement(pad, "div", { name: "face", x: "0", y: "0", w: "200", h: "100" });
  await hmi.setHandler(pad, face, "drag", 'emit("move", { x: p.x, y: p.y });');
  const pageId = await hmi.addPage("Help");
  const start = await hmi.addElement(pageId, "div", { name: "Start", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  const instance = await hmi.addElement(pageId, "use", { name: "Pad1", x: "44", y: "200", w: "200", h: "100" }, null, "Pad");
  await d.openPage("Help");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const names = () => page.locator(".suggest .suggest-name").allTextContents();
  // the list shows whole: its bottom row is what the pointer would press there
  const whole = async (what) => {
    const box = await page.locator(".suggest").boundingBox();
    const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".suggest"), { x: box.x + box.width / 2, y: box.y + box.height - 6 });
    check(hit, `${what}: the list is cut off`);
    return box;
  };

  await d.el(instance).click();
  await right.locator(".ghost", { hasText: "Add event" }).click();
  const heads = await page.locator(".popover .menu-head").allTextContents();
  check(heads.join() === "Pad,Pointer,Wheel and pinch,Keyboard,Gamepad", `the add list's groups are ${heads.join()}`);
  const first = await page.locator(".popover .menu-item").first().textContent();
  check(first.startsWith("move") && first.includes("sends { x, y }"), `the add list starts with ${first}`);
  await page.locator(".popover .menu-item", { has: page.locator(".mono", { hasText: /^move$/ }) }).click();
  await eventually(async () => (await right.locator(".event-meta").textContent())?.trim() === "p = { x, y }", "the move card to say what p brings");

  await d.el(start).click();
  await d.addEvent("tap");
  await eventually(async () => (await right.locator(".event-meta").textContent())?.trim() === "p = { x, y, angle, on, inside, button, shift, ctrl, alt, w, h }", "the tap card to say what p brings");
  await d.code("tap").click();
  await page.keyboard.type("p.");
  await eventually(async () => (await names()).join() === "x,y,angle,on,inside,button,shift,ctrl,alt,w,h", "the fields of p");
  const box = await whole("the inspector");
  const code = await d.code("tap").boundingBox();
  check(box.y < code.y + code.height, "the list opens under the whole box, not the line typed");
  await page.keyboard.type("x;");
  await page.keyboard.press("Control+Enter");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === start).handlers[0]?.code === "p.x;", "the code typed");

  // an object's rule on a change says it brings the new value and the old, and offers them
  await d.openObject("Hmi");
  const before = hmi.state.rules.length;
  await page.locator('.object-sheet button[title="Add logic"]').click();
  await eventually(() => hmi.state.rules.length === before + 1, "a new rule");
  await right.locator(".field", { has: page.locator("label", { hasText: /^Runs$/ }) }).locator("select").selectOption("changes");
  await eventually(async () => (await right.locator(".section .mono").textContent())?.trim() === "p = { value, previous }", "a change rule to say what p brings");
  const big = right.locator(".editor.code");
  await big.click();
  await page.keyboard.type("p.pr");
  await eventually(async () => (await names()).join() === "previous", "p's previous in an object's rule");
  await whole("an object's rule");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await hmi.setRule("Hmi", hmi.state.rules.at(-1).id, null);
}
