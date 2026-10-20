// A user adds a jog mode each screen keeps and a press count every screen shares: a button
// flips and counts, a text shows both, only the count reaches another screen, renames follow.

export default async function ({ page, hmi, d, check, eventually }) {
  const inspector = (label) => page.locator(".screen:not([hidden]) .sidebar.right .field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) });
  const set = async (label, text) => {
    const f = inspector(label).locator("input");
    await f.fill(text);
    await f.press("Enter");
  };
  const variable = (name) => hmi.state.variables?.find((v) => v.name === name);
  const add = async (name, per, start) => {
    await page.locator("button", { hasText: "Add a variable" }).click();
    await page.locator(".screen:not([hidden]) .sidebar.right .head-title", { hasText: "newVariable" }).waitFor();
    await set("Name", name);
    await page.locator(".screen:not([hidden]) .sidebar.right .head-title", { hasText: name }).waitFor();
    if (per) await inspector("Kept").locator("button", { hasText: per }).click();
    await set("Starts", start);
  };

  await d.tab("Data");
  await add("jogMode", "Each screen", '"Joint"');
  await add("presses", null, "0");
  await eventually(() => variable("jogMode")?.per === "screen" && variable("jogMode")?.start === "Joint" && variable("presses")?.start === 0, "both variables");

  const pageId = await hmi.addPage("State");
  const flip = await hmi.addElement(pageId, "div", { name: "Flip", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.setHandler(pageId, flip, "tap", 'jogMode = jogMode === "Joint" ? "Cartesian" : "Joint";\npresses = presses + 1;');
  const shows = await hmi.addElement(pageId, "span", { name: "Shows", x: "264", y: "44", w: "352", h: "44", text: "jogMode + \" \" + presses", color: "#e4e6e8" });

  await d.openPage("State");
  await d.tab("Run");
  const text = () => page.locator(`.run-layer:not([hidden]) .el[data-id="${shows}"]`).textContent();
  await eventually(async () => (await text()) === "Joint 0", "the text to show the start values");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${flip}"]`).click();
  await eventually(async () => (await text()) === "Cartesian 1", "a tap to flip the mode and count");
  await eventually(() => hmi.state.values.presses?.value === 1, "the count to reach another screen");
  check(hmi.state.values.jogMode?.value === "Joint", `another screen's own mode became ${hmi.state.values.jogMode?.value}`);

  await d.tab("Data");
  await page.locator(".data-detail tr", { hasText: "presses" }).click();
  await set("Name", "taps");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === flip)?.handlers[0].code.includes("taps = taps + 1"), "the handler to follow the rename");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === shows)?.props.text === 'jogMode + " " + taps', "the text to follow the rename");
  check(hmi.state.values.taps?.value === 1, "the rename lost the count");
}
