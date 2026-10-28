// A user folds the Design sidebar's panes away by their heads: the body goes, the head and
// its + stay, the browser keeps the choice over a reload, and a second press brings it back.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Folds");
  await hmi.addElement(pageId, "div", { name: "Folded box", x: "44", y: "44", w: "88", h: "88" });
  await d.openPage("Folds");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const head = (word) => left.locator("button.fold", { hasText: word });
  const layer = (await d.layers()).locator(".list-row", { hasText: "Folded box" });
  const pageRow = left.locator(".page-row", { has: page.getByText("Folds", { exact: true }) });
  const cards = left.locator(".pages.cards");
  await layer.waitFor();

  await head("Layers").click();
  await eventually(async () => !(await layer.isVisible()) && !(await pageRow.isVisible()), "the layers and their pages to fold away");
  check((await head("Layers").getAttribute("aria-expanded")) === "false", "the Layers head does not say it is folded");
  check(await left.locator('button[title="Add an element"]').isVisible(), "the element + went with the body");
  check(await left.locator('button[title="Add a page"]').isVisible(), "the page + went with the body");
  await head("Components").click();
  await eventually(async () => !(await cards.isVisible()), "the components to fold away");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await head("Layers").waitFor();
  check(!(await layer.isVisible()) && !(await pageRow.isVisible()) && !(await cards.isVisible()), "a reload unfolded the panes");

  await head("Layers").click();
  await head("Components").click();
  await pageRow.waitFor();
  await layer.waitFor();
  await cards.waitFor();
}
