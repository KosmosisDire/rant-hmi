// A user writes event code with help: the add list sets a component's own events apart from the
// pointer's and says what each sends, each card says what p brings, and p's fields come up in a
// list that floats whole under the line typed, in the inspector and in the Logic tab alike.

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
  check(heads.join() === "Pad,Pointer", `the add list's groups are ${heads.join()}`);
  const first = await page.locator(".popover .menu-item").first().textContent();
  check(first.startsWith("move") && first.includes("sends { x, y }"), `the add list starts with ${first}`);
  await page.locator(".popover .menu-item", { has: page.locator(".mono", { hasText: /^move$/ }) }).click();
  await eventually(async () => (await right.locator(".event-meta").textContent())?.trim() === "p = { x, y }", "the move card to say what p brings");

  await d.el(start).click();
  await d.addEvent("tap");
  await eventually(async () => (await right.locator(".event-meta").textContent())?.trim() === "p = { x, y, angle, on, inside }", "the tap card to say what p brings");
  await d.code("tap").click();
  await page.keyboard.type("p.");
  await eventually(async () => (await names()).join() === "x,y,angle,on,inside", "the fields of p");
  const box = await whole("the inspector");
  const code = await d.code("tap").boundingBox();
  check(box.y < code.y + code.height, "the list opens under the whole box, not the line typed");
  await page.keyboard.type("x;");
  await page.keyboard.press("Control+Enter");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === start).handlers[0]?.code === "p.x;", "the code typed");

  await d.tab("Logic");
  const logic = page.locator(".screen:not([hidden])");
  // the card follows the handler picked, a pointer's marked apart from a component's
  await logic.locator(".handler-list .list-row", { hasText: "Pad1" }).click();
  await eventually(async () => (await logic.locator(".detail .event-icon .lucide-component").count()) === 1, "the move card marked as the component's");
  await logic.locator(".handler-list .list-row", { hasText: "Start" }).click();
  await eventually(async () => (await logic.locator(".detail .event-icon .lucide-zap").count()) === 1, "the tap card marked as the pointer's");
  const big = logic.locator(".detail .editor.code");
  await big.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("p.an");
  await eventually(async () => (await names()).join() === "angle", "p's angle in the Logic tab");
  const low = await whole("the Logic tab");
  const tall = await big.boundingBox();
  check(low.y > tall.y + 30 && low.y < tall.y + 80, `the list opens under the second line, at ${low.y - tall.y} px down the box`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Open in Design shows the element picked, with the caret in its handler
  check((await logic.locator(".detail-head .tag").count()) === 0, "the handler's head shows tags");
  await logic.locator(".detail-head button", { hasText: "Open in Design" }).click();
  const typing = () => page.evaluate(() => document.activeElement?.closest(".screen:not([hidden]) .sidebar.right .event")?.querySelector(".event-name")?.textContent ?? "");
  await eventually(async () => (await typing()) === "tap", "the caret in the tap handler");
  const picked = await page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").evaluateAll((rows) => rows.map((r) => r.dataset.id));
  check(picked.join() === start, `the layers pick ${picked.join(", ")}`);
  await d.tab("Logic");

  // the HMI's own handler on a change brings the new value and the old
  await logic.locator('button[title="Add a handler"]').click();
  await logic.locator(".rule-kind").selectOption("changes");
  await eventually(async () => (await logic.locator(".detail .event-meta").textContent())?.trim() === "p = { value, previous }", "a change rule to say what p brings");
}
