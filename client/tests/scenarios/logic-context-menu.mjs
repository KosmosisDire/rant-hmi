// A user works the Logic tab's list from its right click menu: adds a handler on the empty
// list, duplicates one with its code, deletes the copy, and opens an element's handler in
// the Design tab.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Logic menus");
  const pad = await hmi.addElement(pageId, "div", { name: "menuPad", x: "44", y: "44", w: "88", h: "88" });
  await hmi.setHandler(pageId, pad, "tap", "log(1);");
  await d.tab("Logic");
  const list = page.locator(".screen:not([hidden]) .handler-list");
  const before = hmi.state.rules.length;

  const empty = await list.boundingBox();
  await page.mouse.click(empty.x + empty.width / 2, empty.y + empty.height - 20, { button: "right" });
  await page.locator(".popover.menu .menu-item", { hasText: "Add a handler" }).click();
  await eventually(() => hmi.state.rules.length === before + 1, "a new handler");
  const made = hmi.state.rules.at(-1);
  hmi.send({ type: "edit", edit: { kind: "set_rule", id: made.id, rule: { ...made, code: "ticks = 1;" } } });
  await eventually(() => hmi.state.rules.find((r) => r.id === made.id)?.code === "ticks = 1;", "its code");

  const row = (name) => list.locator(".list-row", { has: page.locator(".list-trail", { hasText: new RegExp(`^${name}$`) }) });
  await d.menu(row(made.name), "Duplicate");
  await eventually(() => hmi.state.rules.some((r) => r.name === `${made.name} copy` && r.code === "ticks = 1;"), "a copy with the code");
  await d.menu(row(`${made.name} copy`), "Delete");
  await eventually(() => !hmi.state.rules.some((r) => r.name === `${made.name} copy`), "the copy to go");
  await d.menu(row(made.name), "Delete");
  await eventually(() => hmi.state.rules.length === before, "the new handler to go");

  await d.menu(list.locator(".list-row", { has: page.locator(".list-label", { hasText: /^menuPad$/ }) }), "Open in Design");
  await page.locator(".screen:not([hidden]) .pages .list-row.selected", { hasText: "Logic menus" }).waitFor();
  check((await page.locator(".tab.on").textContent()).includes("Design"), "the Design tab did not open");
}
