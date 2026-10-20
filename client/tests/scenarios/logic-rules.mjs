// A user writes the HMI's own handlers: a counting timer, a warning when the line runs too
// fast, one that follows Running. A new one opens in the middle, a removed timer stops and
// comes back with Ctrl Z, and the open page's element handlers are listed with what they read
// and write and what their event brings, while another page's are not.

export default async function ({ page, hmi, d, check, eventually }) {
  const variable = (name, start) => hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  variable("ticks", 0);
  variable("lastRunning", "none");
  const pageId = await hmi.addPage("Logic page");
  const lamp = await hmi.addElement(pageId, "div", { name: "Lamp", x: "44", y: "44", w: "88", h: "88" });
  await hmi.setHandler(pageId, lamp, "tap", "if (Speed > 1) ticks = 0;");
  const elsewhere = await hmi.addPage("Other logic page");
  await hmi.setHandler(elsewhere, await hmi.addElement(elsewhere, "div", { name: "Far", x: "44", y: "44", w: "88", h: "88" }), "tap", "log(1);");

  await d.openPage("Logic page");
  await d.tab("Logic");
  const box = page.locator(".screen.logic .detail");
  const add = async () => {
    const before = hmi.state.rules.length;
    await page.locator('.screen.logic button[title="Add a handler"]').click();
    await eventually(() => hmi.state.rules.length === before + 1, "a new handler");
    const name = hmi.state.rules.at(-1).name;
    await eventually(async () => (await box.locator(".hero-name").inputValue()) === name, "the new handler to open");
    return box;
  };
  const commit = async (locator, text) => {
    await locator.fill(text);
    await locator.press(text.includes("\n") ? "Control+Enter" : "Enter");
  };

  await add();
  await commit(box.locator(".hero-name"), "Count");
  await commit(box.locator(".rule-field input"), "200");
  await box.locator(".editor.code").fill("ticks = ticks + 1;");
  await box.locator(".editor.code").press("Control+Enter");
  await eventually(() => hmi.state.values.ticks?.value >= 3, "the timer to count", 5000);

  await add();
  await commit(box.locator(".hero-name"), "Too fast");
  await box.locator(".rule-kind").selectOption("turns");
  await commit(box.locator(".rule-field input").first(), "Speed > 1.5");
  await commit(box.locator(".rule-field input").nth(1), "300");
  await box.locator(".editor.code").fill('notify("The line runs too fast");');
  await box.locator(".editor.code").press("Control+Enter");
  await eventually(() => hmi.state.rules.some((r) => r.when.kind === "turns" && r.when.ms === 300 && r.code.includes("too fast")), "the condition rule");
  await hmi.set("Speed", 2);
  await page.locator(".notice", { hasText: "The line runs too fast" }).waitFor({ timeout: 4000 });

  // the line runs before the rule is made, whatever scenarios before left it at
  hmi.set("Running", true);
  await eventually(() => hmi.state.values.Running?.value === true, "the line running");
  await add();
  await box.locator(".rule-kind").selectOption("changes");
  await commit(box.locator(".rule-field input"), "Running");
  await box.locator(".editor.code").fill("lastRunning = p.value;");
  await box.locator(".editor.code").press("Control+Enter");
  await eventually(() => hmi.state.rules.some((r) => r.when.kind === "changes" && r.code.includes("lastRunning")), "the change rule");
  await hmi.set("Running", false);
  await eventually(() => hmi.state.values.lastRunning?.value === false, "the change rule to see Running go false");
  await hmi.set("Running", true);

  await page.locator(".handler-list .list-row", { hasText: "Count" }).click();
  await page.locator('.screen.logic .detail button[title="Remove Count"]').click();
  await eventually(() => !hmi.state.rules.some((r) => r.name === "Count"), "the timer to go");
  const stopped = hmi.state.values.ticks.value;
  await page.waitForTimeout(600);
  check(hmi.state.values.ticks.value <= stopped + 1, "a removed timer still counts");
  await page.keyboard.press("Control+z");
  await eventually(() => hmi.state.rules.some((r) => r.name === "Count"), "Ctrl Z to bring the timer back");
  await page.locator(".handler-list .list-row", { hasText: "Count" }).waitFor();
  await page.keyboard.press("Control+Shift+z");
  await eventually(() => !hmi.state.rules.some((r) => r.name === "Count"), "Ctrl Shift Z to remove it again");

  check((await page.locator(".handler-list .list-group", { hasText: /^Logic page$/ }).count()) === 1, "the list misses the open page");
  check((await page.locator(".handler-list .list-row", { hasText: "Far" }).count()) === 0, "the list shows another page's handler");
  await page.locator(".handler-list .list-row", { hasText: "Lamp" }).click();
  const rows = () => page.locator(".screen.logic .uses-row").allTextContents();
  await eventually(async () => (await rows()).join() === "Speedvariable, write,tickssets", "the lamp's reads and writes");
  check((await box.locator(".event-meta").textContent()) === "p = { x, y, angle, on, inside }", "the card does not say what its event brings");
  await box.locator("button", { hasText: "Open in Design" }).click();
  await page.locator(".pages .list-row.selected", { hasText: "Logic page" }).waitFor();
}
