// Design's sidebar is one tree: a Components and a Pages folder, each a row with its + on it. A
// press folds a folder away, the browser keeps the choice over a reload, and a second press
// brings it back.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Folds");
  await hmi.addElement(pageId, "div", { name: "Folded box", x: "44", y: "44", w: "88", h: "88" });
  await hmi.addComponent("Foldpart");
  await d.openPage("Folds");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const folder = (kind) => left.locator(`.list-row[data-folder-kind="${kind}"][data-folder=""]`);
  const layer = (await d.layers()).locator(".list-row", { hasText: "Folded box" });
  const pageRow = left.locator(".page-row", { has: page.getByText("Folds", { exact: true }) });
  const part = left.locator(".page-row", { has: page.getByText("Foldpart", { exact: true }) });
  await layer.waitFor();
  check((await left.locator(".pane-head").count()) === 0, "the tree has heads above it");

  await folder("pages").click();
  await eventually(async () => !(await layer.isVisible()) && !(await pageRow.isVisible()), "the pages and their layers to fold away");
  check(await left.locator('button[title="Add a page"]').isVisible(), "the page + went with what the folder holds");
  await folder("components").click();
  await eventually(async () => !(await part.isVisible()), "the components to fold away");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await folder("pages").waitFor();
  check(!(await pageRow.isVisible()) && !(await part.isVisible()), "a reload opened the folders");

  await folder("pages").click();
  await folder("components").click();
  await pageRow.waitFor();
  await part.waitFor();
}
