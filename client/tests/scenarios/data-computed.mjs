// A designer makes a computed value from the Data screen: speed in percent, with a setter that
// writes the speed back. It reads as Speed does, a write to it sets Speed, a getter that cannot
// work says why, one that reads itself is refused, and a setter that does not undo the getter
// gets a warning.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  const side = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => side.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const write = async (label, text) => {
    const box = field(label).locator("input");
    await box.fill(text);
    await box.press("Enter");
  };
  const percent = () => hmi.state.computed.find((c) => c.name === "speedPercent");

  await page.locator(".screen:not([hidden]) .detail button", { hasText: "Add a computed value" }).click();
  await side.locator(".tag", { hasText: /^computed$/ }).waitFor();
  await write("Name", "speedPercent");
  await eventually(percent, "the computed value named");
  // a getter that cannot work says why under its field
  await write("Is", "squareRoot(Speed)");
  await field("Is").locator(".field-note", { hasText: "squareRoot names no mesh import" }).waitFor();
  await write("Is", "Speed * 100");
  await eventually(async () => (await field("Is").locator(".field-note").count()) === 0, "the note to go once the getter works");
  // the system works it out, which reads no theme, so no token is offered
  check(hmi.state.tokens.length > 0, "the project has no token to leave out");
  const is = field("Is").locator("input");
  await is.fill("");
  await is.pressSequentially("$");
  await page.waitForTimeout(300);
  check((await page.locator(".suggest").count()) === 0, `a computed value is offered ${await page.locator(".suggest .suggest-name").allTextContents()}`);
  await is.press("Escape");
  await eventually(async () => (await is.inputValue()) === "Speed * 100", "Escape to keep the getter");
  await write("Unit", "%");
  await field("Writes").locator("select").selectOption("Speed");
  await eventually(() => percent()?.set?.target === "Speed", "its setter");
  await write("As", "v / 100");
  await eventually(() => percent()?.get === "Speed * 100" && percent()?.unit === "%" && percent()?.set?.value === "v / 100", "the computed value whole");

  hmi.set("Speed", 0.5);
  await eventually(() => hmi.state.values.speedPercent?.value === 50, () => `speedPercent to read 50, not ${hmi.state.values.speedPercent?.value}`);
  // shown in the table too, with its unit
  await page.locator(".screen:not([hidden]) .detail tr.row", { hasText: "speedPercent" }).locator(".cell-value", { hasText: "%" }).waitFor();

  hmi.set("speedPercent", 80);
  await eventually(() => hmi.state.values.Speed?.value === 0.8, () => `a write of 80 to set Speed to 0.8, not ${hmi.state.values.Speed?.value}`);

  await write("Is", "speedPercent + 1");
  await page.locator(".notice", { hasText: "reads itself" }).waitFor();
  check(percent().get === "Speed * 100", "a getter reading itself was kept");

  // picking the target warned already, of its first setter v, so this looks for its own words
  await write("As", "v * 4");
  await page.locator(".notice.warn", { hasText: "does not undo it: writing 1 reads back as 400" }).waitFor();
  await write("As", "v / 100");
  await eventually(() => percent()?.set?.value === "v / 100", "the setter put right");
}
