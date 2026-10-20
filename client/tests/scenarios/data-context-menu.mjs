// A user works the Data screen from its right click menus: imports an entity from the mesh
// tree and removes it again, flips an import's intent, copies its alias, sets a variable back
// to its start and deletes it.

export default async function ({ page, hmi, d, check, eventually }) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await d.tab("Data");
  const screen = page.locator(".screen:not([hidden])");
  const pick = (target, item) => d.menu(target, item);

  // the mesh tree: an entity not imported offers to import it, an imported one to remove it
  const pose = await d.meshRow("Robot/Pose");
  if (hmi.state.imports.some((i) => i.entity === "Robot/Pose")) await hmi.unimport(hmi.state.imports.find((i) => i.entity === "Robot/Pose").alias);
  await pick(pose, "Import to read");
  await eventually(() => hmi.state.imports.some((i) => i.entity === "Robot/Pose"), "Robot/Pose imported");
  const alias = hmi.state.imports.find((i) => i.entity === "Robot/Pose").alias;
  await pick(pose, `Remove ${alias}`);
  await eventually(() => !hmi.state.imports.some((i) => i.entity === "Robot/Pose"), "Robot/Pose removed");

  // an import's intent, either way, and its alias to the clipboard
  const speed = screen.locator(".detail tr.row", { has: page.locator("td.name .mono", { hasText: /^Speed$/ }) });
  await pick(speed, "Read only");
  await eventually(() => hmi.state.imports.find((i) => i.alias === "Speed")?.intent === "read", "Speed to be read only");
  await speed.click({ button: "right" });
  check((await page.locator(".popover.menu .menu-item:disabled .menu-label").allTextContents()).join() === "Read only", "the intent Speed has is not the one shown off");
  await page.keyboard.press("Escape");
  await pick(speed, "Read and set");
  await eventually(() => hmi.state.imports.find((i) => i.alias === "Speed")?.intent === "write", "Speed to be set again");
  await pick(speed, "Copy the alias");
  check((await page.evaluate(() => navigator.clipboard.readText())) === "Speed", "the alias did not reach the clipboard");

  // a variable back to its start, then gone
  hmi.send({ type: "set_variable", name: "menuCount", variable: { name: "menuCount", start: 5, per: "hmi" } });
  await eventually(() => hmi.state.values.menuCount?.value === 5, "the variable");
  hmi.set("menuCount", 9);
  await eventually(() => hmi.state.values.menuCount?.value === 9, "the variable set to 9");
  const count = screen.locator(".detail tr.row", { has: page.locator("td.name", { hasText: /^menuCount$/ }) });
  await pick(count, "Reset to its start");
  await eventually(() => hmi.state.values.menuCount?.value === 5, "the variable back to 5");
  await pick(count, "Delete");
  await eventually(() => !hmi.state.variables.some((v) => v.name === "menuCount"), "the variable to go");
}
