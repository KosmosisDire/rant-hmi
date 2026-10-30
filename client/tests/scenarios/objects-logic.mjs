// A user writes Hmi's logic on the Objects tab: a counting timer, a warning when the line runs
// too fast judged five times a second, one that follows Line's Running. A new rule opens with its
// name ready to type, and a removed timer stops.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.ticks", 0);
  hmi.setVariable("Hmi.lastRunning", "none");
  await d.openObject("Hmi");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => right.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const commit = async (locator, text) => {
    await locator.fill(text);
    await locator.press("Enter");
  };
  const code = async (text) => {
    await right.locator(".editor.code").fill(text);
    await right.locator(".editor.code").press("Control+Enter");
  };
  const add = async (name) => {
    const before = hmi.state.rules.length;
    await page.locator('.object-sheet button[title="Add logic"]').click();
    await eventually(() => hmi.state.rules.length === before + 1, "a new rule");
    const box = field("Name").locator("input");
    await eventually(() => box.evaluate((e) => e === document.activeElement), "the new rule's name ready to type");
    await commit(box, name);
    await page.locator(`.object-sheet [data-rule="${name}"]`).waitFor();
  };

  await add("Count");
  await commit(field("Every ms").locator("input"), "200");
  await code("ticks = ticks + 1;");
  await eventually(() => hmi.state.values["Hmi.ticks"]?.value >= 3, "the timer to count", 5000);

  // the speed starts below the condition, whatever scenarios before left it at, so it turns true
  hmi.set("Line.Speed", 1);
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 1, "the line at a safe speed");
  await add("Too fast");
  await field("Runs").locator("select").selectOption("turns");
  await commit(field("Condition").locator("input"), "Line.Speed > 1.5");
  await commit(field("For ms").locator("input"), "300");
  await commit(field("Rate").locator("input"), "5");
  await code('notify("The line runs too fast");');
  await eventually(() => hmi.state.rules.some((r) => r.when.kind === "turns" && r.when.ms === 300 && r.when.rate === 5 && r.code.includes("too fast")), "the condition rule");
  await hmi.set("Line.Speed", 2);
  await page.locator(".notice", { hasText: "The line runs too fast" }).waitFor({ timeout: 4000 });

  // the line runs before the rule is made, whatever scenarios before left it at
  hmi.set("Line.Running", true);
  await eventually(() => hmi.state.values["Line.Running"]?.value === true, "the line running");
  await add("Follow");
  await field("Runs").locator("select").selectOption("changes");
  await commit(field("Of").locator("input"), "Line.Running");
  await code("lastRunning = p.value;");
  await eventually(() => hmi.state.rules.some((r) => r.when.kind === "changes" && r.code.includes("lastRunning")), "the change rule");
  await hmi.set("Line.Running", false);
  await eventually(() => hmi.state.values["Hmi.lastRunning"]?.value === false, "the change rule to see Running go false");
  await hmi.set("Line.Running", true);
  await hmi.set("Line.Speed", 1);

  await page.locator('.object-sheet [data-rule="Count"]').click();
  await right.locator("button", { hasText: /^Remove$/ }).click();
  await eventually(() => !hmi.state.rules.some((r) => r.name === "Count"), "the timer to go");
  const stopped = hmi.state.values["Hmi.ticks"].value;
  await page.waitForTimeout(600);
  check(hmi.state.values["Hmi.ticks"].value <= stopped + 1, "a removed timer still counts");
  for (const name of ["Too fast", "Follow"]) await hmi.setRule("Hmi", hmi.state.rules.find((r) => r.name === name).id, null);
}
