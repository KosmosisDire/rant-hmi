// A user keeps pages, components and objects in folders, each kept as folders of the project's
// own: a folder made from a folder's menu and named there, a page dragged onto it and another
// moved by its menu, the folder renamed with them in it and removed, what it held going up. An
// object goes into a folder of the objects in the Objects tab. Names stay as they were.

export default async function ({ page, hmi, d, check, eventually }) {
  const one = await hmi.addPage("Filed one");
  const two = await hmi.addPage("Filed two");
  await d.openPage("Filed one");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const folder = (kind, path) => left.locator(`.list-row[data-folder-kind="${kind}"][data-folder="${path}"]`);
  const row = (name) => left.locator(".page-row", { has: page.getByText(name, { exact: true }) });
  const folderOf = (id) => hmi.page(id).folder;
  const menu = async (target, ...items) => {
    await target.click({ button: "right" });
    for (const item of items) await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${item}$`) }) }).last().click();
  };

  // a folder made from the Pages folder's menu, its name typed in its row
  await menu(folder("pages", ""), "New folder");
  const naming = left.locator(`.list-row[data-folder-kind="pages"] input`);
  await naming.fill("Cell");
  await naming.press("Enter");
  await folder("pages", "Cell").waitFor();

  // a page dragged onto it goes in, and another by its menu
  const from = await row("Filed one").locator(".list-label").boundingBox();
  const to = await folder("pages", "Cell").boundingBox();
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + from.height / 2 + 20, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await eventually(() => folderOf(one) === "Cell", "the dragged page to go into Cell");
  await menu(row("Filed two"), "Move to", "Cell");
  await eventually(() => folderOf(two) === "Cell", "the page moved by its menu to go into Cell");
  check(hmi.page(one).name === "Filed one" && hmi.page(one).id === one, "a move changed the page's name or id");
  const inside = await row("Filed one").locator(".list-label").boundingBox();
  check(inside.x > (await folder("pages", "Cell").locator(".list-label").boundingBox()).x, "the page does not sit inside its folder");

  // renamed with them in it, then removed with them going up
  await menu(folder("pages", "Cell"), "Rename");
  const rename = folder("pages", "Cell").locator("input");
  await rename.fill("Line");
  await rename.press("Enter");
  await eventually(() => folderOf(one) === "Line" && folderOf(two) === "Line", "the pages to follow their folder's rename");
  await menu(folder("pages", "Line"), "Remove the folder");
  await eventually(() => folderOf(one) === "" && folderOf(two) === "", "what the folder held to go up as it went");
  await eventually(async () => (await folder("pages", "Line").count()) === 0, "the folder's row to go");

  // an object in the Objects tab
  if (!hmi.object("Filed")) await hmi.addObject("Filed");
  await d.tab("Objects");
  const objects = page.locator(".screen:not([hidden]) .sidebar.left");
  await objects.locator(`.list-row[data-folder-kind="objects"][data-folder=""]`).click({ button: "right" });
  await page.locator(".popover.menu .menu-item", { hasText: "New folder" }).click();
  const named = objects.locator(`.list-row[data-folder-kind="objects"] input`);
  await named.fill("Machines");
  await named.press("Enter");
  await objects.locator(`.list-row[data-folder-kind="objects"][data-folder="Machines"]`).waitFor();
  await menu(objects.locator('.list-row[data-object="Filed"]'), "Move to", "Machines");
  await eventually(() => hmi.object("Filed").folder === "Machines", "the object to go into Machines");
  await menu(objects.locator('.list-row[data-object="Filed"]'), "Move to", "The top");
  await eventually(() => hmi.object("Filed").folder === "", "the object to come back to the top");
  await objects.locator(`.list-row[data-folder-kind="objects"][data-folder="Machines"]`).click({ button: "right" });
  await page.locator(".popover.menu .menu-item", { hasText: "Remove the folder" }).click();
}
