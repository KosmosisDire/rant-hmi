// An operator switches a screen between light and dark from buttons the app gives. A handler's
// theme.toggle() runs on the screen. One that also writes a shared value runs on the system,
// reads the screen's mode and still switches the screen that ran it. The operator's screen keeps
// the choice when it opens again, and in the editor the switch turns the editor's own theme.

export default async function ({ page, hmi, d, sys, check, eventually }) {
  hmi.setVariable("Hmi.modeSeen", "");
  const pageId = await hmi.addPage("Modes");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "20", h: "4", text: "theme.mode", color: "$text" });
  const flip = await hmi.addElement(pageId, "div", { name: "Flip", x: "4", y: "10", w: "10", h: "6", background: "$panel" });
  await hmi.setHandler(pageId, flip, "tap", "theme.toggle();");
  const back = await hmi.addElement(pageId, "div", { name: "Back", x: "16", y: "10", w: "10", h: "6", background: "$panel" });
  await hmi.setHandler(pageId, back, "tap", 'Hmi.modeSeen = theme.mode;\ntheme.set("dark");');
  hmi.send({ type: "set_start", page: pageId });

  const device = await page.context().browser().newContext({ colorScheme: "dark" });
  const screen = await device.newPage();
  await screen.goto(`${sys.url}/run`);
  const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const reads = (want) => async () => (await el(shown).textContent()) === want;
  await eventually(reads("dark"), "the screen to follow its dark device");
  const colour = () => el(shown).evaluate((e) => getComputedStyle(e).color);
  const dark = await colour();
  await el(flip).click();
  await eventually(reads("light"), "a tap to switch the screen to light");
  check((await colour()) !== dark, "the tokens kept their dark values");

  await el(back).click();
  await eventually(() => hmi.state.values["Hmi.modeSeen"]?.value === "light", () => `the system to read light, not ${JSON.stringify(hmi.state.values["Hmi.modeSeen"]?.value)}`);
  await eventually(reads("dark"), "the system to switch the screen back to dark");
  check((await colour()) === dark, "dark draws as before");

  await el(flip).click();
  await eventually(reads("light"), "light again");
  await screen.reload();
  await eventually(reads("light"), "the screen to keep light as it opens again");
  await device.close();

  // the editor's Run draws in the editor's theme, which the switch turns
  const editor = () => page.evaluate(() => document.documentElement.dataset.theme);
  const before = await editor();
  await d.openPage("Modes");
  await d.tab("Run");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${flip}"]`).click();
  await eventually(async () => (await editor()) !== before, "the editor's theme to turn");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${flip}"]`).click();
  await eventually(async () => (await editor()) === before, "the editor's theme to turn back");
}
