// A user duplicates a page and a component: each copy opens under a free name with the same
// elements, and Ctrl Z takes a copy away again.

export default async function ({ page, hmi, d, check, eventually }) {
  const line = await hmi.addPage("Line");
  await hmi.addElement(line, "div", { name: "Box", x: "44", y: "44", w: "88", h: "88", background: "#2a2f35" });
  const duplicate = () => page.locator(".screen:not([hidden]) .sidebar.right button", { hasText: "Duplicate" }).click();
  const named = (name) => hmi.state.pages.find((p) => p.name === name);
  const open = (name) => page.locator(".pages .list-row.selected", { hasText: name }).waitFor();

  await d.openPage("Line");
  await duplicate();
  await eventually(() => named("Line copy"), "the copy");
  check(named("Line copy").children[0]?.props.name === "Box", "the copy lost the box");
  await open("Line copy");
  await d.openPage("Line");
  await duplicate();
  await eventually(() => named("Line copy 2"), "a second copy under a free name");
  await open("Line copy 2");
  await page.keyboard.press("Control+z");
  await eventually(() => !named("Line copy 2"), "Ctrl Z to take the second copy away");

  await hmi.addComponent("Gauge");
  await d.openPage("Gauge");
  await duplicate();
  await eventually(() => named("GaugeCopy")?.interface, "the component's copy");
}
