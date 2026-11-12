// Pages show in the Objects tab apart from the objects. A page's sheet lists all the state it
// keeps, its own and each element's under that element, and the inspector edits a piece of it as
// the Design inspector does: its start, a new piece, one removed. The page opens in Design.

export default async function ({ page, hmi, d, check, eventually }) {
  const id = await hmi.addPage("Stately");
  const holder = await hmi.addElement(id, "div", { name: "Holder", x: "4", y: "4", w: "20", h: "10" });
  await hmi.edit({ kind: "set_state", page: id, id: null, name: "count", var: { name: "count", start: 0, per: "screen" } });
  await hmi.edit({ kind: "set_state", page: id, id: holder, name: "flag", var: { name: "flag", start: false, per: "screen" } });

  await d.tab("Objects");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const sheet = page.locator(".screen:not([hidden]) .object-sheet");
  await left.locator(`.list-row[data-page="${id}"]`).click();
  await sheet.locator(".hero", { hasText: /^Stately$/ }).waitFor();
  const holderPart = sheet.locator(".members", { has: page.locator(".section", { hasText: /^Holder/ }) });
  await holderPart.locator('[data-state="flag"]').waitFor();

  // a piece of state opens in the inspector, which edits it
  await sheet.locator('[data-state="count"]').click();
  await right.locator(".head-title", { hasText: "count" }).waitFor();
  const starts = right.locator(".field", { has: page.locator("label", { hasText: /^Starts$/ }) }).locator("input");
  await starts.fill("5");
  await starts.press("Enter");
  await eventually(() => hmi.page(id).state.find((v) => v.name === "count")?.start === 5, "the start to change");

  // state added to the page, and the element's removed
  await sheet.locator(".members").first().locator('button[title="Add state"]').click();
  await eventually(() => hmi.page(id).state.length === 2, "a new piece of state on the page");
  await holderPart.locator('[data-state="flag"]').click();
  await right.locator("button", { hasText: /^Remove$/ }).click();
  await eventually(() => hmi.page(id).children[0].state.length === 0, "the element's state removed");

  // Remove goes back to the page itself, which opens in Design
  await right.locator("button", { hasText: /^Open in Design$/ }).click();
  await page.locator(".tab.on", { hasText: "Design" }).waitFor();
}
