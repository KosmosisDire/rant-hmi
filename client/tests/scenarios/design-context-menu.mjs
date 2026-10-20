// A user works an element from its right click menu, on the canvas and in the layers: copies
// it and pastes it on the canvas, duplicates it, brings it to the front, picks what holds a
// child, deletes it, and walks the menu with the keys.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Menus");
  const box = await hmi.addElement(pageId, "div", { name: "Box", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.addElement(pageId, "div", { name: "Other", x: "264", y: "44", w: "88", h: "88", background: "#3a4046" });
  const badge = await hmi.addElement(pageId, "span", { name: "Badge", x: "11", y: "11", w: "44", h: "22", text: '"On"' }, box);
  await d.openPage("Menus");
  const top = () => hmi.page(pageId).children;
  const menu = page.locator(".popover.menu");
  // the box's left edge, which neither its badge nor a copy one grid step on covers
  const onBox = async (item) => {
    const b = await d.el(box).boundingBox();
    const k = b.width / 176;
    await page.mouse.click(b.x + 5 * k, b.y + 66 * k, { button: "right" });
    await menu.locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${item}$`) }) }).click();
  };

  // the rows the element offers
  await d.el(box).click({ button: "right" });
  const rows = await menu.locator(".menu-label").allTextContents();
  check(rows.join() === "Cut,Copy,Paste,Duplicate,Make a component,Bring forward,Send backward,Bring to front,Send to back,Delete", `the menu offers ${rows.join()}`);
  await page.keyboard.press("Escape");
  await eventually(async () => (await menu.count()) === 0, "Escape to close the menu");

  // the keys walk it: the first row is Cut, one down is Copy
  await d.el(box).click({ button: "right" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  // a right click on the canvas, away from every element, pastes there
  const canvas = await page.locator(".screen:not([hidden]) .artboard").boundingBox();
  const spot = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height * 0.6 };
  await page.mouse.click(spot.x, spot.y, { button: "right" });
  await menu.locator(".menu-item", { hasText: /^Paste here/ }).click();
  await eventually(() => top().length === 3, "the copy to paste onto the page");
  const pasted = await d.el(top()[2].id).boundingBox();
  const step = (await d.el(box).boundingBox()).width / 16;
  check(Math.abs(pasted.x - spot.x) <= step && Math.abs(pasted.y - spot.y) <= step, `the copy landed at ${pasted.x}, ${pasted.y}, not where the menu opened`);

  await onBox("Duplicate");
  await eventually(() => top().length === 4, "a duplicate");
  await onBox("Bring to front");
  await eventually(() => top().at(-1).id === box, "the box to come to the front");

  await d.menu(page.locator(`.screen:not([hidden]) .sidebar.left .list-row[data-id="${badge}"]`), "Select what holds it");
  await eventually(async () => (await page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id")) === box, "the box to be picked");

  await onBox("Delete");
  await eventually(() => !top().some((e) => e.id === box), "the box to go");
}
