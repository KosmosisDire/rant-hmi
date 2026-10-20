// A user folds the Design sidebar's panes away by their heads: the body goes, the head and
// its + stay, the browser keeps the choice over a reload, and a second press brings it back.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Folds");
  await hmi.addElement(pageId, "div", { name: "Folded box", x: "44", y: "44", w: "88", h: "88" });
  await d.openPage("Folds");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const head = (word) => left.locator("button.fold", { hasText: word });
  const layer = left.locator(".list-row", { hasText: "Folded box" });
  const pageRow = left.locator(".pages .list-row", { hasText: "Folds" });
  await layer.waitFor();

  await head("Layers").click();
  await eventually(async () => !(await layer.isVisible()), "the layers to fold away");
  check((await head("Layers").getAttribute("aria-expanded")) === "false", "the Layers head does not say it is folded");
  check(await left.locator('button[title="Add an element"]').isVisible(), "the + went with the body");
  await head("Pages").click();
  await eventually(async () => !(await pageRow.isVisible()), "the pages to fold away");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await head("Layers").waitFor();
  check(!(await layer.isVisible()) && !(await pageRow.isVisible()), "a reload unfolded the panes");

  await head("Layers").click();
  await head("Pages").click();
  await layer.waitFor();
  await pageRow.waitFor();
}
