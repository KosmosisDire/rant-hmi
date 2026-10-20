// A new user opens the Data tab: the mesh imports table sits under its title, one short row per
// import, and nothing from another screen's styles bends it.

export default async function ({ page, d, check, eventually }) {
  await d.tab("Data");
  const rows = page.locator(".detail table.grid").first().locator("tbody tr");
  await eventually(async () => (await rows.count()) >= 4, "the demo's imports");
  const title = await page.locator(".detail .detail-head").first().boundingBox();
  const table = await page.locator(".detail table.grid").first().boundingBox();
  check(table.y >= title.y + title.height, "the table covers its title");
  for (const box of await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
    check(box < 40, `a row is ${box} px tall`);
  }
}
