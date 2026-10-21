// On a phone a menu or a field's editor is a sheet along the bottom over a dimmed screen: a
// long press opens the menu with no row picked, a tap on the dimmed screen closes it, a tap on
// a row runs it, a colour opens its picker across the sheet, and a drag of the grip down closes.
// A desktop's menu still floats at the pointer.

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.addPage("Sheets");
  await page.locator(".tab", { hasText: "Design" }).click();
  const row = (p) => p.locator(".screen:not([hidden]) .pages .list-row", { has: p.locator(".list-label", { hasText: /^Sheets$/ }) });
  await row(page).click({ button: "right" });
  await page.locator(".popover.menu").waitFor();
  check((await page.locator(".sheet").count()) === 0, "a desktop's menu is a sheet");
  await page.keyboard.press("Escape");

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const screen = await phone.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  await screen.locator(".tab", { hasText: "Design" }).tap();
  const cdp = await phone.newCDPSession(screen);
  const finger = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  // the page's row is in the drawer, so it slides out first
  const drawer = async () => {
    if ((await screen.locator(".app.drawer-open").count()) === 0) await screen.locator(".topbar .bar-btn").first().tap();
    await row(screen).waitFor();
  };
  const longPress = () =>
    row(screen).evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch", clientX: r.x + 20, clientY: r.y + 10 }));
    });
  const sheet = screen.locator(".sheet:not(.dock)");
  const resting = async () => {
    let last = null;
    await eventually(async () => {
      const b = await sheet.boundingBox();
      const same = b && last && b.y === last.y;
      last = b;
      return same;
    }, "the sheet to come to rest");
    return last;
  };

  // the menu comes up the bottom, full width and as tall as its rows, nothing picked
  await drawer();
  await longPress();
  await sheet.locator(".popover.menu").waitFor();
  const menu = await resting();
  check(menu.x === 0 && menu.width === 390 && Math.round(menu.y + menu.height) === 844 && menu.height < 844 / 2, `the menu sheet is ${JSON.stringify(menu)}`);
  check(await screen.evaluate(() => !document.activeElement?.classList.contains("menu-item")), "a phone's menu opens with a row picked");
  await screen.locator(".sheet-scrim").tap({ position: { x: 100, y: 100 } });
  await eventually(async () => (await sheet.count()) === 0, "a tap on the dimmed screen to close the menu");

  // a row runs as a tap
  const pages = hmi.state.pages.length;
  await drawer();
  await longPress();
  await resting();
  await sheet.locator(".menu-item", { hasText: "Duplicate" }).tap();
  await eventually(() => hmi.state.pages.length === pages + 1, "the page duplicated from the sheet");
  check((await sheet.count()) === 0, "the menu stays after its row ran");

  // a colour's picker spans the sheet, in the inspector's sheet raised by the right toggle
  await drawer();
  await row(screen).tap();
  await screen.locator(".topbar .bar-btn").last().tap();
  const lead = screen.locator(".screen:not([hidden]) .sidebar.right .lead").first();
  await lead.scrollIntoViewIfNeeded();
  await lead.tap();
  await sheet.locator(".colour-picker").waitFor();
  const picker = await sheet.locator(".colour-picker").boundingBox();
  check(picker.width > 350, `the picker is ${picker.width} px wide in the sheet`);
  await screen.locator(".sheet-scrim").tap({ position: { x: 100, y: 100 } });
  await eventually(async () => (await sheet.count()) === 0, "the picker closed");

  // dragged down by its grip, it closes. Last, since a tap just after a quick drag stops a fling.
  await drawer();
  await longPress();
  await resting();
  const grip = await sheet.locator(".sheet-grip").boundingBox();
  await finger("touchStart", 195, grip.y + 10);
  for (const dy of [40, 120, 220]) await finger("touchMove", 195, grip.y + 10 + dy);
  await finger("touchEnd");
  await eventually(async () => (await sheet.count()) === 0, "the menu to close when dragged down");
  await phone.close();
}
