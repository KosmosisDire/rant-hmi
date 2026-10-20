// A user scrolls the wheel over the page to look closer: it zooms about the pointer, so the
// spot under it stays put. A click on the percent shows the page at its true size.

export default async function ({ page, d, check }) {
  await d.tab("Design");
  await page.locator(".pages .list-row").first().click();
  const zoom = () => page.locator(".zoom .mono").textContent();
  const sheet = () => page.locator(".artboard .page").boundingBox();

  const before = await sheet();
  const [px, py] = [before.x + before.width * 0.3, before.y + before.height * 0.6];
  const start = await zoom();
  await page.mouse.move(px, py);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(100);
  const after = await sheet();
  check((await zoom()) !== start, "the wheel did not zoom");
  check(after.width > before.width, "scrolling up did not zoom in");
  const u = (px - after.x) / after.width;
  const v = (py - after.y) / after.height;
  check(Math.abs(u - 0.3) < 0.01 && Math.abs(v - 0.6) < 0.01, `the spot under the pointer moved to ${u.toFixed(3)}, ${v.toFixed(3)}`);

  await page.locator('button[title="Show at 100%"]').click();
  check((await zoom()) === "100%", "the percent did not show the page at its true size");
  check(Math.abs((await sheet()).width - 1408) < 1, "the page is not drawn at its true size");
}
