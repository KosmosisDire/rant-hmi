// A user writes the HMI's own handlers: a counting timer, a warning when the line runs too
// fast, one that follows Running. A removed timer stops, and element handlers are listed.

export default async function ({ page, hmi, d, check, eventually }) {
  const variable = (name, start) => hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  variable("ticks", 0);
  variable("lastRunning", "none");
  const pageId = await hmi.addPage("Logic page");
  const lamp = await hmi.addElement(pageId, "div", { name: "Lamp", x: "44", y: "44", w: "88", h: "88" });
  await hmi.setHandler(pageId, lamp, "tap", "log(1);");

  await d.tab("Logic");
  const boxes = page.locator(".rules .handler");
  const add = async () => {
    const before = hmi.state.rules.length;
    await page.locator("button", { hasText: "Add a handler" }).click();
    await eventually(async () => hmi.state.rules.length === before + 1 && (await boxes.count()) === before + 1, "a new handler");
    return boxes.nth(before);
  };
  const commit = async (locator, text) => {
    await locator.fill(text);
    await locator.press(text.includes("\n") ? "Control+Enter" : "Enter");
  };

  let box = await add();
  await commit(box.locator(".input-name"), "Count");
  await commit(box.locator(".rule-field input"), "200");
  await box.locator(".editor.code").fill("ticks = ticks + 1;");
  await box.locator(".editor.code").press("Control+Enter");
  await eventually(() => hmi.state.values.ticks?.value >= 3, "the timer to count", 5000);

  box = await add();
  await commit(box.locator(".input-name"), "Too fast");
  await box.locator(".rule-kind").selectOption("turns");
  await commit(box.locator(".rule-field input").first(), "Speed > 1.5");
  await commit(box.locator(".rule-field input").nth(1), "300");
  await box.locator(".editor.code").fill('notify("The line runs too fast");');
  await box.locator(".editor.code").press("Control+Enter");
  await eventually(() => hmi.state.rules.some((r) => r.when.kind === "turns" && r.when.ms === 300 && r.code.includes("too fast")), "the condition rule");
  await hmi.set("Speed", 2);
  await page.locator(".notice", { hasText: "The line runs too fast" }).waitFor({ timeout: 4000 });

  box = await add();
  await box.locator(".rule-kind").selectOption("changes");
  await commit(box.locator(".rule-field input"), "Running");
  await box.locator(".editor.code").fill("lastRunning = p.value;");
  await box.locator(".editor.code").press("Control+Enter");
  await eventually(() => hmi.state.rules.some((r) => r.when.kind === "changes" && r.code.includes("lastRunning")), "the change rule");
  await hmi.set("Running", false);
  await eventually(() => hmi.state.values.lastRunning?.value === false, "the change rule to see Running go false");
  await hmi.set("Running", true);

  await page.locator('.rules button[title="Remove Count"]').click();
  await eventually(() => !hmi.state.rules.some((r) => r.name === "Count"), "the timer to go");
  const stopped = hmi.state.values.ticks.value;
  await page.waitForTimeout(600);
  check(hmi.state.values.ticks.value <= stopped + 1, "a removed timer still counts");

  check((await page.locator(".overview-page", { hasText: "Logic page" }).count()) === 1, "the overview misses the page with a handler");
  await page.locator(".overview-page", { hasText: "Logic page" }).click();
  await page.locator(".pages .list-row.selected", { hasText: "Logic page" }).waitFor();
}
