// A user adds a camera's home to Cell, a function that takes and gives nothing: the Objects tab
// says so and offers no intent, since a function is only called, and a button that calls it
// homes the camera.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const i of hmi.state.imports.filter((x) => x.entity === "Cell/Camera/Home")) await hmi.unimport(i.alias);
  if (!hmi.object("Cell")) await hmi.addObject("Cell", "Cell");
  await d.openObject("Cell");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await (await d.meshRow("Cell/Camera/Home")).click();
  await right.getByText("Takes nothing.").waitFor();
  await right.getByText("Gives nothing back.").waitFor();
  check(!(await right.locator(".choice").isVisible()), "a function offers an intent");
  await right.locator("button", { hasText: /^Add to Cell$/ }).click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Cell.Home" && i.intent === "write"), "the member, to call");
  await right.locator(".head-title", { hasText: /^Cell\.Home$/ }).waitFor();
  check((await right.locator(".pane-head .tag").first().textContent()) === "mesh function", "the member is not tagged a mesh function");
  await right.getByText("on the mesh", { exact: true }).waitFor();
  check(!(await right.locator(".field", { has: page.locator("label", { hasText: /^Intent$/ }) }).isVisible()), "the member offers an intent");
  await right.getByText("Takes nothing.").waitFor();

  await hmi.import("Cell.Homes", "Cell/Camera/Homes");
  await eventually(() => hmi.state.values["Cell.Homes"]?.known, "the count of homes");
  const before = hmi.state.values["Cell.Homes"].value;
  const pageId = await hmi.addPage("Home camera");
  const button = await hmi.addElement(pageId, "div", { name: "Home", x: "44", y: "44", w: "176", h: "66", background: "#2a2f35" });
  await hmi.setHandler(pageId, button, "tap", "await Cell.Home();");
  await d.openPage("Home camera");
  await d.tab("Run");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${button}"]`).click();
  await eventually(() => hmi.state.values["Cell.Homes"]?.value === before + 1, () => `the camera to home, it homed ${hmi.state.values["Cell.Homes"]?.value} times`);
}
