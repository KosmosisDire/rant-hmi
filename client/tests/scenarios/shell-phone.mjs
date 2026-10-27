// The editor on a phone: all four tabs fit the top bar and a tap opens each, buttons take a
// finger's room since the main pointer is touch, and the status bar fits. A desktop keeps the
// mouse's sizes.

export default async function ({ page, sys, check, eventually }) {
  const desk = await page.locator(".topbar .bar-btn").first().boundingBox();
  check(Math.round(desk.height) === 30, `a desktop's bar button is ${desk.height} px tall`);

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const screen = await phone.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  const wide = (selector) => screen.locator(selector).evaluate((e) => e.scrollWidth - e.clientWidth);
  check((await wide(".tabs")) === 0, "the tabs scroll on a phone");
  check((await wide(".statusbar")) === 0, "the status bar runs off a phone");
  for (const b of await screen.locator(".topbar .bar-btn").all()) {
    const box = await b.boundingBox();
    check(box.height >= 40 && box.x >= 0 && box.x + box.width <= 390, `a bar button is ${JSON.stringify(box)} on a phone`);
  }

  for (const tab of ["Logic", "Run", "Data", "Design"]) {
    const button = screen.locator(".tab", { hasText: tab });
    const box = await button.boundingBox();
    check(box.x >= 0 && box.x + box.width <= 390 && box.height >= 40, `the ${tab} tab is ${JSON.stringify(box)} on a phone`);
    await button.tap();
    await eventually(async () => (await screen.locator(".tab.on").textContent()).includes(tab), `the ${tab} tab on`);
  }
  await phone.close();
}
