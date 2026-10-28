// A new user opens an object on the Objects tab: its mesh members sit under their section's
// title, one short row each, and nothing from another screen's styles bends them.

export default async function ({ page, d, check, eventually }) {
  await d.openObject("Line");
  const rows = page.locator(".object-sheet .members").first().locator(".member-row");
  await eventually(async () => (await rows.count()) >= 3, "Line's mesh members");
  const title = await page.locator(".object-sheet .members-head").first().boundingBox();
  const list = await page.locator(".object-sheet .members-rows").first().boundingBox();
  check(list.y >= title.y + title.height, "the rows cover their title");
  for (const box of await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
    check(box < 40, `a row is ${box} px tall`);
  }
}
