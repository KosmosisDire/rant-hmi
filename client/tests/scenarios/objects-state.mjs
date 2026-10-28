// A user adds to Hmi a jog mode each screen keeps and a flip count every screen shares: a button
// flips and counts, a text shows both, only the count reaches another screen, renames follow.

export default async function ({ page, hmi, d, check, eventually }) {
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const variable = (name) => hmi.state.variables.find((v) => v.name === `Hmi.${name}`);
  const add = async (name, per, start) => {
    await d.addMember("Add state", name);
    if (per) await right.locator(".field", { has: page.locator("label", { hasText: /^Kept$/ }) }).locator("button", { hasText: per }).click();
    await d.setField("Starts", start);
  };

  await d.openObject("Hmi");
  await add("jogMode", "Each screen", '"Joint"');
  await add("flips", null, "0");
  await eventually(() => variable("jogMode")?.per === "screen" && variable("jogMode")?.start === "Joint" && variable("flips")?.start === 0, "both pieces of state");

  const pageId = await hmi.addPage("State");
  const flip = await hmi.addElement(pageId, "div", { name: "Flip", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.setHandler(pageId, flip, "tap", 'Hmi.jogMode = Hmi.jogMode === "Joint" ? "Cartesian" : "Joint";\nHmi.flips = Hmi.flips + 1;');
  const shows = await hmi.addElement(pageId, "span", { name: "Shows", x: "264", y: "44", w: "352", h: "44", text: 'Hmi.jogMode + " " + Hmi.flips', color: "#e4e6e8" });

  await d.openPage("State");
  await d.tab("Run");
  const text = () => page.locator(`.run-layer:not([hidden]) .el[data-id="${shows}"]`).textContent();
  await eventually(async () => (await text()) === "Joint 0", "the text to show the start values");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${flip}"]`).click();
  await eventually(async () => (await text()) === "Cartesian 1", "a tap to flip the mode and count");
  await eventually(() => hmi.state.values["Hmi.flips"]?.value === 1, "the count to reach another screen");
  check(hmi.state.values["Hmi.jogMode"]?.value === "Joint", `another screen's own mode became ${hmi.state.values["Hmi.jogMode"]?.value}`);

  await d.openObject("Hmi");
  await d.pickMember("flips");
  await d.setField("Name", "flipCount");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === flip)?.handlers[0].code.includes("Hmi.flipCount = Hmi.flipCount + 1"), "the handler to follow the rename");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === shows)?.props.text === 'Hmi.jogMode + " " + Hmi.flipCount', "the text to follow the rename");
  check(hmi.state.values["Hmi.flipCount"]?.value === 1, "the rename lost the count");
}
