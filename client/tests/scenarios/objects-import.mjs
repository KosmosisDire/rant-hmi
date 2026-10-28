// A user adds the robot's pose to Robot with its mesh row's +, uses it, renames it so a page and
// a handler follow, changes its intent, and finds a name code already uses refused. An entity
// picked offers to join whichever object is open.

export default async function ({ page, hmi, d, check, eventually }) {
  // the entities it adds start as no member, whatever scenarios ran on this system before
  for (const i of hmi.state.imports.filter((x) => ["Robot/Pose", "Line1/Conveyor"].includes(x.entity))) await hmi.unimport(i.alias);
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await d.openObject("Robot");
  // the mesh starts as its folders alone
  await left.locator(".list-row.branch").first().waitFor();
  check((await left.locator(".list-row[title]").count()) === 0, "the mesh tree started open");
  const row = await d.meshRow("Robot/Pose");
  await row.locator('.row-add[title="Add to Robot"]').click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Robot.Pose" && i.entity === "Robot/Pose" && i.intent === "read"), "the one click member");
  await right.locator(".head-title", { hasText: /^Robot\.Pose$/ }).waitFor();
  await d.member("Pose").waitFor();
  await eventually(async () => (await row.locator(".row-add").count()) === 0, "the added row to stop offering +");
  check((await row.locator(".list-trail").textContent()) === "Robot.Pose", "the row does not name its member");

  const pageId = await hmi.addPage("Pose page");
  const text = await hmi.addElement(pageId, "span", { name: "Pose", x: "44", y: "44", w: "264", h: "44", text: "Robot.Pose.position.x.toFixed(2)" });
  await hmi.setHandler(pageId, text, "tap", 'log(Robot.Pose.position.x, "Pose");');

  await d.setField("Name", "Place");
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Robot.Place"), "the rename");
  await eventually(() => hmi.page(pageId).children[0].props.text === "Robot.Place.position.x.toFixed(2)", "the page to follow");
  const e = hmi.page(pageId).children[0];
  check(e.props.name === "Pose", "the layer name changed with the member");
  check(e.handlers[0].code === 'log(Robot.Place.position.x, "Pose");', `the handler reads ${e.handlers[0].code}`);
  await eventually(() => hmi.state.values["Robot.Place"]?.known, "the value to carry on under the new name");

  await right.locator(".choice button", { hasText: /^Read and / }).click();
  await eventually(() => hmi.state.imports.find((i) => i.alias === "Robot.Place")?.intent === "write", "the intent change");

  await d.setField("Name", "Math");
  await right.locator(".error-line", { hasText: "Math is a name code already uses" }).waitFor();

  // an entity picked offers to join the object open, under its own name
  await (await d.meshRow("Line1/Conveyor")).click();
  await right.locator("button", { hasText: /^Add to Robot$/ }).waitFor();
  await d.openObject("Line");
  await (await d.meshRow("Line1/Conveyor")).click();
  await right.locator("button", { hasText: /^Add to Line$/ }).click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Line.Conveyor" && i.entity === "Line1/Conveyor"), "the conveyor added to Line");
  await right.locator(".head-title", { hasText: /^Line\.Conveyor$/ }).waitFor();
}
