// A user works the Objects tab from its right click menus: adds an entity from the mesh tree to
// the object open and removes it again, flips a member's intent, copies its name, sets state
// back to its start and removes it.

export default async function ({ page, hmi, d, check, eventually }) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const pick = (target, item) => d.menu(target, item);
  for (const i of hmi.state.imports.filter((x) => x.entity === "Robot/Pose")) await hmi.unimport(i.alias);
  await d.openObject("Robot");

  // the mesh tree: an entity no member offers to join the object open, a member to go
  const pose = await d.meshRow("Robot/Pose");
  await pick(pose, "Add to Robot");
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Robot.Pose"), "Robot/Pose added");
  await pick(pose, "Remove Robot.Pose");
  await eventually(() => !hmi.state.imports.some((i) => i.entity === "Robot/Pose"), "Robot/Pose removed");

  // a member's intent, either way, and its name to the clipboard
  await d.openObject("Line");
  const speed = d.member("Speed");
  await pick(speed, "Read only");
  await eventually(() => hmi.state.imports.find((i) => i.alias === "Line.Speed")?.intent === "read", "Speed to be read only");
  await speed.click({ button: "right" });
  check((await page.locator(".popover.menu .menu-item:disabled .menu-label").allTextContents()).join() === "Read only", "the intent Speed has is not the one shown off");
  await page.keyboard.press("Escape");
  await pick(speed, "Read and set");
  await eventually(() => hmi.state.imports.find((i) => i.alias === "Line.Speed")?.intent === "write", "Speed to be set again");
  await pick(speed, "Copy the name");
  check((await page.evaluate(() => navigator.clipboard.readText())) === "Line.Speed", "the name did not reach the clipboard");

  // state back to its start, then gone
  hmi.setVariable("Hmi.menuCount", 5);
  await eventually(() => hmi.state.values["Hmi.menuCount"]?.value === 5, "the state");
  hmi.set("Hmi.menuCount", 9);
  await eventually(() => hmi.state.values["Hmi.menuCount"]?.value === 9, "the state set to 9");
  await d.openObject("Hmi");
  const count = d.member("menuCount");
  await pick(count, "Reset to its start");
  await eventually(() => hmi.state.values["Hmi.menuCount"]?.value === 5, "the state back to 5");
  await pick(count, "Remove");
  await eventually(() => !hmi.state.variables.some((v) => v.name === "Hmi.menuCount"), "the state to go");
}
