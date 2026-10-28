// A touch screen holds what a finger holds. The browser's own menu never comes up anywhere,
// a long press on a button stays a press with no menu, letting go releases it and leaves no
// hover behind, a tap never flashes the browser's highlight, and in the editor a long press
// that opens the menu moves nothing.

export default async function ({ page, hmi, sys, check, eventually }) {
  const pageId = await hmi.addPage("Touch");
  const pad = await hmi.addElement(pageId, "div", { name: "pad", x: "4", y: "4", w: "24", h: "12", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "press", "Line.Speed = 1.25;");
  await hmi.setHandler(pageId, pad, "release", "Line.Speed = 0;");

  // no right click anywhere reaches the browser's own menu
  const kept = await page.evaluate(() =>
    [".topbar", ".screen:not([hidden]) .sidebar.left", "input", ".statusbar"].map((s) => {
      const el = document.querySelector(s);
      return !el || !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }),
  );
  check(kept.every(Boolean), `the browser's menu could open: ${kept}`);
  await page.keyboard.press("Escape");

  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .page-row", { hasText: /^Touch/ }).click();
  const cdp = await touch.context().newCDPSession(touch);
  const finger = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const longPress = (target) =>
    target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.dispatchEvent(new PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch", clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });

  // the editor: a long press mid drag opens the menu and puts the element back
  const drawn = touch.locator(`.artboard .page-layer.open .el[data-id="${pad}"]`);
  const at = await drawn.boundingBox();
  await finger("touchStart", at.x + 20, at.y + 20);
  await finger("touchMove", at.x + 60, at.y + 40);
  check(!(await longPress(drawn)), "a long press reached the browser's menu");
  await finger("touchEnd");
  await touch.locator(".popover.menu").waitFor();
  check(hmi.page(pageId).children[0].props.x === "4", `a long press moved the pad to ${hmi.page(pageId).children[0].props.x}`);
  await touch.keyboard.press("Escape");

  // the run: a long press is a press, held until the finger lifts
  await touch.locator(".tab", { hasText: "Run" }).click();
  const button = touch.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`);
  const b = await button.boundingBox();
  await finger("touchStart", b.x + b.width / 2, b.y + b.height / 2);
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 1.25, "the press to set Speed");
  check(!(await longPress(button)), "a long press reached the browser's menu");
  await touch.waitForTimeout(800);
  check((await touch.locator(".popover.menu").count()) === 0, "a long press opened a menu");
  check(hmi.state.values["Line.Speed"]?.value === 1.25, "the press let go before the finger lifted");
  await finger("touchEnd");
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 0, "lifting the finger to release");
  check((await button.evaluate((el) => getComputedStyle(el).filter)) === "none", "the button stayed lit as if hovered");
  const flash = await touch.evaluate(() => [...document.querySelectorAll("button, .el, .list-row")].map((el) => getComputedStyle(el).webkitTapHighlightColor).find((c) => c !== "rgba(0, 0, 0, 0)"));
  check(flash === undefined, `a tap flashes ${flash}`);
  await touch.close();
}
