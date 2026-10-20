// A user widens a sidebar by dragging its edge. The width holds on every tab and after a
// reload, a sidebar never gets narrower than 160, and the middle keeps 320.

export default async function ({ page, d, check, eventually }) {
  const width = (side) => page.locator(`.screen:not([hidden]) .sidebar.${side}`).evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const drag = async (side, dx) => {
    const grip = page.locator(`.screen:not([hidden]) .edge[data-side="${side}"] .grip`);
    const b = await grip.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + 200, { steps: 6 });
    await page.mouse.up();
  };

  await d.tab("Data");
  const start = await width("left");
  await drag("left", 100);
  check((await width("left")) === start + 100, `the left sidebar is ${await width("left")} wide, not ${start + 100}`);
  await d.tab("Design");
  check((await width("left")) === start + 100, "the Design tab's left sidebar did not follow");

  const right = await width("right");
  await drag("right", -60);
  check((await width("right")) === right + 60, `the right sidebar is ${await width("right")} wide, not ${right + 60}`);

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.tab("Logic");
  check((await width("left")) === start + 100 && (await width("right")) === right + 60, "the widths did not last a reload");

  await drag("left", -1000);
  check((await width("left")) === 160, `a sidebar shrank to ${await width("left")}`);
  await drag("left", 2000);
  const middle = await page.locator(".screen:not([hidden]) .detail").evaluate((e) => Math.round(e.getBoundingClientRect().width));
  check(middle === 320, `the middle kept ${middle}, not 320`);
  await drag("left", start - (await width("left")));
  await drag("right", right - (await width("right")));
}
