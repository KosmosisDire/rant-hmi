// A user works an element from its right click menu, on the canvas and in the layers: adds a
// text where the canvas was clicked, a frame inside the box, a text from the layers' empty space and a component, copies the box
// and pastes it on the canvas, duplicates it, brings it to the front, picks what holds a
// child, deletes it, and walks the menu and a submenu with the keys.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Menus");
  const box = await hmi.addElement(pageId, "div", { name: "Box", x: "4", y: "4", w: "16", h: "8", background: "#2a2f35" });
  await hmi.addElement(pageId, "div", { name: "Other", x: "24", y: "4", w: "8", h: "8", background: "#3a4046" });
  const badge = await hmi.addElement(pageId, "span", { name: "Badge", x: "1", y: "1", w: "4", h: "2", text: '"On"' }, box);
  await d.openPage("Menus");
  const top = () => hmi.page(pageId).children;
  const menu = page.locator(".popover.menu");
  // the box's left edge, which neither its badge nor a copy one grid step on covers
  const onBox = async (item) => {
    const b = await d.el(box).boundingBox();
    const k = b.width / 16;
    await page.mouse.click(b.x + 0.5 * k, b.y + 6.6 * k, { button: "right" });
    await menu.locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${item}$`) }) }).click();
  };

  // the rows the element offers
  await d.el(box).click({ button: "right" });
  const rows = await menu.locator(".menu-label").allTextContents();
  const offered = "Add inside,Place a component inside,Show an import inside,Cut,Copy,Paste,Duplicate,Group,Lay out in a new frame,Convert to component,Bring forward,Send backward,Bring to front,Send to back,Delete";
  check(rows.join() === offered, `the menu offers ${rows.join()}`);
  await page.keyboard.press("Escape");
  await eventually(async () => (await menu.count()) === 0, "Escape to close the menu");

  // a submenu opens under the pointer, and adds where the menu opened
  const canvas = await page.locator(".screen:not([hidden]) .artboard").boundingBox();
  const k = (await d.el(box).boundingBox()).width / 16;
  const sub = (row, item) =>
    menu
      .locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${row}$`) }) })
      .hover()
      .then(() => menu.nth(1).locator(".menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${item}$`) }) }).click());
  const text = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height * 0.4 };
  await page.mouse.click(text.x, text.y, { button: "right" });
  await sub("Add", "Text");
  await eventually(() => top().some((e) => e.tag === "span"), "a text on the page");
  const textId = top().find((e) => e.tag === "span").id;
  const added = await d.el(textId).boundingBox();
  check(Math.abs(added.x - text.x) <= 1 * k && Math.abs(added.y - text.y) <= 1 * k, "the text did not land where the menu opened");
  await d.menu(page.locator(`.screen:not([hidden]) .sidebar.left .list-row[data-id="${textId}"]`), "Delete");
  // gone from the canvas too, where the next right click lands
  await eventually(async () => (await d.el(textId).count()) === 0, "the text to go");

  // inside the box, by the keys: down to the first row's submenu, right to open it, Enter
  const b = await d.el(box).boundingBox();
  await page.mouse.click(b.x + 12 * k, b.y + 5 * k, { button: "right" });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const inner = () => hmi.page(pageId).children.find((e) => e.id === box).children.find((c) => c.tag === "div");
  await eventually(inner, "a frame inside the box");
  check(Number(inner().props.x) === 12 && Number(inner().props.y) === 5, `the frame sits at ${inner().props.x}, ${inner().props.y} in the box, not where the menu opened`);

  // the layers tree adds into the frame its row is
  const row = page.locator(`.screen:not([hidden]) .sidebar.left .list-row[data-id="${box}"]`);
  await row.click({ button: "right" });
  await sub("Add inside", "Text");
  const child = () => hmi.page(pageId).children.find((e) => e.id === box).children.find((c) => c.tag === "span" && c.props.name === "Text");
  await eventually(child, "a text inside the box");
  // gone again, so it covers none of the box the steps below right click
  const childId = child().id;
  await d.menu(page.locator(`.screen:not([hidden]) .sidebar.left .list-row[data-id="${childId}"]`), "Delete");
  await eventually(async () => (await d.el(childId).count()) === 0, "the text inside to go");

  // the layers' empty space adds to the page itself, whatever is picked
  await d.select("Box");
  // below every page's band, which a tall list of them reaches once scrolled to its end
  const pane = row.locator("xpath=ancestor::div[contains(@class,'pane-body')][1]");
  // after the frame the pick scrolls its row into sight in
  await pane.evaluate((el) => new Promise((done) => requestAnimationFrame(() => done((el.scrollTop = el.scrollHeight)))));
  const layers = await pane.boundingBox();
  await page.mouse.click(layers.x + 20, layers.y + layers.height - 10, { button: "right" });
  await sub("Add", "Text");
  await eventually(() => top().some((e) => e.tag === "span"), "a text at the page's top level");
  const rootText = top().find((e) => e.tag === "span").id;
  await d.menu(page.locator(`.screen:not([hidden]) .sidebar.left .list-row[data-id="${rootText}"]`), "Delete");
  await eventually(async () => (await d.el(rootText).count()) === 0, "the top level text to go");

  await hmi.addComponent("Beacon");
  // the menu offers what this screen knows of, so it must have heard of it
  await d.pageRow("Beacon").waitFor();
  await page.mouse.click(text.x, text.y, { button: "right" });
  await sub("Place a component", "Beacon");
  await eventually(() => top().some((e) => e.tag === "use" && e.component === "Beacon"), "a Beacon on the page");
  const beacon = top().find((e) => e.tag === "use").id;
  await d.menu(d.el(beacon), "Delete");
  await eventually(() => !top().some((e) => e.id === beacon), "the beacon to go");

  // the keys walk it from Add inside down to Copy, past Show an import while it has nothing to show
  await d.el(box).click({ button: "right" });
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? "");
  check((await focused()).startsWith("Add inside"), `the menu opened on ${await focused()}`);
  for (let i = 0; i < 6 && !(await focused()).startsWith("Copy"); i++) await page.keyboard.press("ArrowDown");
  check((await focused()).startsWith("Copy"), `the keys walked to ${await focused()}, never to Copy`);
  await page.keyboard.press("Enter");
  // a right click on the canvas, away from every element, pastes there
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

  await d.menu(page.locator(`.screen:not([hidden]) .sidebar.left .list-row[data-id="${badge}"]`), "Select parent");
  await eventually(async () => (await page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id")) === box, "the box to be picked");

  // a field's label copies its value and resets it to the default
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await d.select("Box");
  const fill = page.locator(".screen:not([hidden]) .sidebar.right .field", { has: page.locator("label", { hasText: /^Fill$/ }) }).locator("label");
  await d.menu(fill, "Copy the value");
  check((await page.evaluate(() => navigator.clipboard.readText())) === "#2a2f35", "the fill did not reach the clipboard");
  await d.menu(fill, "Reset to default");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === box)?.props.background === undefined, "the fill to go back to its default");

  await onBox("Delete");
  await eventually(() => !top().some((e) => e.id === box), "the box to go");
}
