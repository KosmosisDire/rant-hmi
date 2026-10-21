// A user imports the robot's pose with its +, uses it, renames it so a page and a handler
// follow, changes its intent, and finds each entity picked starts the import form over.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  // the mesh starts as its folders alone
  await page.locator(".screen:not([hidden]) .sidebar.left .list-row.branch").first().waitFor();
  check((await page.locator(".screen:not([hidden]) .sidebar.left .list-row[title]").count()) === 0, "the mesh tree started open");
  const row = await d.meshRow("Robot/Pose");
  await row.locator(".row-add").click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Pose" && i.intent === "read"), "the one click import");
  await eventually(async () => (await page.locator(".screen:not([hidden]) .sidebar.right .head-title").textContent()).includes("Pose"), "the inspector to show the import");
  await eventually(async () => (await row.locator(".row-add").count()) === 0, "the imported row to stop offering +");

  const pageId = await hmi.addPage("Pose page");
  const text = await hmi.addElement(pageId, "span", { name: "Pose", x: "44", y: "44", w: "264", h: "44", text: "Pose.position.x.toFixed(2)" });
  await hmi.setHandler(pageId, text, "tap", 'log(Pose.position.x, "Pose");');

  const alias = page.locator(".screen:not([hidden]) .sidebar.right .field", { has: page.locator("label", { hasText: /^Alias$/ }) }).locator("input");
  await alias.fill("RobotPose");
  await alias.press("Enter");
  await eventually(() => hmi.state.imports.some((i) => i.alias === "RobotPose"), "the rename");
  await eventually(() => hmi.page(pageId).children[0].props.text === "RobotPose.position.x.toFixed(2)", "the page to follow");
  const e = hmi.page(pageId).children[0];
  check(e.props.name === "Pose", "the layer name changed with the alias");
  check(e.handlers[0].code === 'log(RobotPose.position.x, "Pose");', `the handler reads ${e.handlers[0].code}`);
  await eventually(() => hmi.state.values.RobotPose?.known, "the value to carry on under the new name");

  await page.locator(".screen:not([hidden]) .sidebar.right .choice button", { hasText: /^Read and / }).click();
  await eventually(() => hmi.state.imports.find((i) => i.alias === "RobotPose")?.intent === "write", "the intent change");

  await alias.fill("Math");
  await alias.press("Enter");
  await page.locator(".screen:not([hidden]) .sidebar.right .error-line", { hasText: "Math is a name code already uses" }).waitFor();

  const pick = async (name) => (await d.meshRow(name)).click();
  const form = page.locator("#alias");
  await pick("Line1/Conveyor");
  await eventually(async () => (await form.inputValue()) === "Conveyor", "the form to suggest Conveyor");
  await form.fill("Belt");
  await pick("Line1/Jog");
  await eventually(async () => (await form.inputValue()) === "Jog", "another entity to start the form over");
}
