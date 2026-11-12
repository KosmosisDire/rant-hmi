// A user points a mesh member at another entity from its Entity field, a function becoming a
// task, and what names it keeps naming it. Removing a member a page still names goes ahead with
// a warning.

export default async function ({ page, hmi, d, check, eventually }) {
  // an entity takes one member, so what brings the task from earlier scenarios goes first
  for (const i of hmi.state.imports.filter((x) => x.alias === "Line.Act" || x.entity === "Line1/Fill")) await hmi.unimport(i.alias);
  await hmi.import("Line.Act", "Cell/Camera/Home");
  await eventually(() => hmi.state.imports.find((i) => i.alias === "Line.Act")?.kind === "function", "the member as a function");
  const pageId = await hmi.addPage("Repoint page");
  const button = await hmi.addElement(pageId, "div", { name: "Act", x: "4", y: "4", w: "20", h: "6", background: "$accent" });
  await hmi.setHandler(pageId, button, "tap", "await Line.Act();");

  await d.openObject("Line");
  await d.pickMember("Act");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await right.locator("button.value-pick").click();
  const picker = page.locator(".popover.mesh-picker");
  check((await picker.locator('.list-row.selected[title="Cell/Camera/Home"]').count()) === 1, "the tree does not open on the entity the member brings");
  await picker.locator(".filter input").fill("Line1/Fill");
  await picker.locator('.list-row[title="Line1/Fill"]').click();
  await eventually(() => {
    const i = hmi.state.imports.find((x) => x.alias === "Line.Act");
    return i?.kind === "task" && i.entity.endsWith("Fill");
  }, "the member to bring the task under its own name");
  await right.locator(".pane-head .tag", { hasText: /^mesh task$/ }).waitFor();
  check(hmi.page(pageId).children[0].handlers[0].code === "await Line.Act();", "the page stopped naming the member");

  // a member a page still names goes, with a warning
  await d.menu(d.member("Act"), "Remove");
  await eventually(() => !hmi.state.imports.some((i) => i.alias === "Line.Act"), "the member to go though a page names it");
  await page.locator(".notices", { hasText: "1 place still names Line.Act" }).waitFor();
}
