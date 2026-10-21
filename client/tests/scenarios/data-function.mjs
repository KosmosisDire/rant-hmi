// A user imports a camera's home, a function that takes and gives nothing: the Data view says
// so and offers no intent, since a function is only called, and a button that calls it homes
// the camera.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await (await d.meshRow("Cell/Camera/Home")).click();
  await right.getByText("Takes nothing.").waitFor();
  await right.getByText("Gives nothing back.").waitFor();
  check(!(await right.locator(".choice").isVisible()), "a function offers an intent");
  await right.locator("button", { hasText: /^Import$/ }).click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Home" && i.intent === "write"), "the import, to call");
  await eventually(async () => (await right.locator(".head-title").textContent()).includes("Home"), "the inspector to show the import");
  check((await right.locator(".tag").first().textContent()) === "call", "the import is not tagged call");
  await right.getByText("on the mesh", { exact: true }).waitFor();
  check(!(await right.locator(".field", { has: page.locator("label", { hasText: /^Intent$/ }) }).isVisible()), "the import offers an intent");
  await right.getByText("Takes nothing.").waitFor();

  await hmi.import("Homes", "Cell/Camera/Homes");
  await eventually(() => hmi.state.values.Homes?.known, "the count of homes");
  const before = hmi.state.values.Homes.value;
  const pageId = await hmi.addPage("Home camera");
  const button = await hmi.addElement(pageId, "div", { name: "Home", x: "44", y: "44", w: "176", h: "66", background: "#2a2f35" });
  await hmi.setHandler(pageId, button, "tap", "await Home();");
  await d.openPage("Home camera");
  await d.tab("Run");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${button}"]`).click();
  await eventually(() => hmi.state.values.Homes?.value === before + 1, () => `the camera to home, it homed ${hmi.state.values.Homes?.value} times`);
}
