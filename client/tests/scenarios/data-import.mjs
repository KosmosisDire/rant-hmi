// A user imports the robot's pose with the + beside it, uses it on a page and in a handler,
// then renames it: the page and the handler follow. They change its intent, and a name code
// already uses is refused with a reason.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  const row = page.locator('.screen:not([hidden]) .sidebar.left .list-row[title="Robot/Pose"]');
  await row.locator(".row-add").click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Pose" && i.intent === "read"), "the one click import");
  await eventually(async () => (await page.locator(".screen:not([hidden]) .sidebar.right .head-title").textContent()).includes("Pose"), "the inspector to show the import");
  check((await row.locator(".row-add").count()) === 0, "an imported row still offers +");

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

  await page.locator(".screen:not([hidden]) .sidebar.right .choice button", { hasText: "Write" }).click();
  await eventually(() => hmi.state.imports.find((i) => i.alias === "RobotPose")?.intent === "write", "the intent change");

  await alias.fill("Math");
  await alias.press("Enter");
  await page.locator(".screen:not([hidden]) .sidebar.right .error-line", { hasText: "Math is a name code already uses" }).waitFor();
}
