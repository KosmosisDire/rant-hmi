// A designer gives Line a computed value on the Objects tab: its speed in percent, with a setter
// that writes the speed back, worked out at most ten times a second. It reads as Speed does, a
// write to it sets Speed, a getter that cannot work says why, one that reads itself is refused,
// and a setter that does not undo the getter gets a warning.

export default async function ({ page, hmi, d, check, eventually }) {
  const side = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => side.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const write = async (label, text) => {
    const box = field(label).locator("input");
    await box.fill(text);
    await box.press("Enter");
  };
  const percent = () => hmi.state.computed.find((c) => c.name === "Line.speedPercent");

  await d.openObject("Line");
  await d.addMember("Add a computed value", "speedPercent");
  await eventually(percent, "the computed value named");
  // a getter that cannot work says why under its field
  await write("Get", "squareRoot(Speed)");
  await field("Get").locator(".field-note", { hasText: "squareRoot names no" }).waitFor();
  await write("Get", "Speed * 100");
  await eventually(async () => (await field("Get").locator(".field-note").count()) === 0, "the note to go once the getter works");
  // the system works it out, which reads no theme, so no token is offered
  check(hmi.state.tokens.length > 0, "the project has no token to leave out");
  const get = field("Get").locator("input");
  await get.fill("");
  await get.pressSequentially("$");
  await page.waitForTimeout(300);
  check((await page.locator(".suggest").count()) === 0, `a computed value is offered ${await page.locator(".suggest .suggest-name").allTextContents()}`);
  await get.press("Escape");
  await eventually(async () => (await get.inputValue()) === "Speed * 100", "Escape to keep the getter");
  await write("Unit", "%");
  // a rate says how long each time may take, and one past the most is refused
  await field("Rate").locator("input").waitFor();
  check((await side.locator(".field-hint", { hasText: "At most 30 a second, each time stopped after 33 ms." }).count()) === 1, "the rate says the most it takes when it names none");
  await write("Rate", "10");
  await eventually(() => percent()?.rate === 10, "its rate");
  await side.locator(".field-hint", { hasText: "At most 10 a second, each time stopped after 100 ms." }).waitFor();
  await write("Rate", "31");
  await field("Rate").locator("input.bad").waitFor();
  check(percent().rate === 10, `a rate of 31 was taken as ${percent().rate}`);
  await field("Rate").locator("input").press("Escape");
  await field("Set").locator("select").selectOption("Speed");
  await eventually(() => percent()?.set?.target === "Speed", "its setter");
  await write("As", "v / 100");
  await eventually(() => percent()?.get === "Speed * 100" && percent()?.unit === "%" && percent()?.set?.value === "v / 100", "the computed value whole");

  hmi.set("Line.Speed", 0.5);
  await eventually(() => hmi.state.values["Line.speedPercent"]?.value === 50, () => `speedPercent to read 50, not ${hmi.state.values["Line.speedPercent"]?.value}`);
  // its row on the sheet says what it is, with its unit
  await d.member("speedPercent").locator(".member-def", { hasText: "= Speed * 100, %" }).waitFor();

  hmi.set("Line.speedPercent", 80);
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 0.8, () => `a write of 80 to set Speed to 0.8, not ${hmi.state.values["Line.Speed"]?.value}`);

  await write("Get", "speedPercent + 1");
  await page.locator(".notice", { hasText: "reads itself" }).waitFor();
  check(percent().get === "Speed * 100", "a getter reading itself was kept");

  // picking the target warned already, of its first setter v, so this looks for its own words
  await write("As", "v * 4");
  await page.locator(".notice.warn", { hasText: "does not undo it: writing 1 reads back as 400" }).waitFor();
  await write("As", "v / 100");
  await eventually(() => percent()?.set?.value === "v / 100", "the setter put right");
}
