// A designer finds components as small cards, each a picture of it over its name, a long one
// cut short: a drag onto the canvas places one centred where it lands, by mouse and by a
// finger's sideways drag, a drag let go off the canvas or after Escape places nothing, and a
// click opens the component.

export default async function ({ page, hmi, sys, d, check, eventually }) {
  const tile = await hmi.addComponent("Tile");
  await hmi.addElement(tile, "div", { name: "face", x: "0", y: "0", w: "88", h: "44", background: "#c62828" });
  const target = await hmi.addPage("Cards");
  await d.openPage("Cards");
  const card = page.locator(".screen:not([hidden]) .sidebar.left .card", { hasText: /^Tile$/ });
  await card.locator(".card-thumb .el").first().waitFor();
  // other scenarios' components come first, so the list may need a scroll to reach it
  await card.scrollIntoViewIfNeeded();
  check((await card.textContent()).trim() === "Tile", `the card says ${await card.textContent()}, not only its name`);

  // a long name ends in an ellipsis, so its card stays as narrow as the rest
  await hmi.addComponent("ConveyorSpeedReadoutPanel");
  const long = page.locator(".screen:not([hidden]) .sidebar.left .card", { hasText: /^ConveyorSpeedReadoutPanel$/ });
  await long.waitFor();
  const [cut, wide] = await long.locator(".list-label").evaluate((l) => [l.scrollWidth > l.clientWidth, l.closest(".card").offsetWidth]);
  check(cut && wide === (await card.evaluate((c) => c.offsetWidth)), "a long name widens its card instead of ending in an ellipsis");

  const placed = () => hmi.page(target).children.filter((e) => e.component === "Tile");
  const { width: w, height: h } = hmi.page(tile);
  const sheet = await page.locator(".screen:not([hidden]) .artboard .page-layer > .page").boundingBox();
  const k = sheet.width / hmi.page(target).width;
  const on = (x, y) => ({ x: sheet.x + x * k, y: sheet.y + y * k });
  const from = await card.boundingBox();
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const drag = async (to, beforeUp) => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await beforeUp?.();
    await page.mouse.up();
  };

  await drag(on(440, 330));
  await eventually(() => placed().length === 1, "a Tile placed by a drag");
  const t = placed()[0];
  const [cx, cy] = [Number(t.props.x) + w / 2, Number(t.props.y) + h / 2];
  check(Math.abs(cx - 440) <= 11 && Math.abs(cy - 330) <= 11, `the Tile centres on ${cx}, ${cy}, not where it was let go`);
  check(t.props.w === String(w) && t.props.h === String(h), "the Tile is not at its size");

  await drag({ x: start.x, y: start.y + 160 });
  await drag(on(700, 500), () => page.keyboard.press("Escape"));
  await page.waitForTimeout(300);
  check(placed().length === 1, "a drag let go off the canvas or after Escape placed a Tile");
  check(!(await page.locator(".card-ghost").count()), "a drag left its picture behind");

  // a finger's sideways drag places one too
  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1600, height: 1000 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Cards/ }).click();
  const tsheet = await touch.locator(".screen:not([hidden]) .artboard .page-layer > .page").boundingBox();
  const tk = tsheet.width / hmi.page(target).width;
  const tcards = touch.locator(".screen:not([hidden]) .sidebar.left .card", { hasText: /^Tile$/ });
  await tcards.scrollIntoViewIfNeeded();
  const tcard = await tcards.boundingBox();
  const cdp = await touch.context().newCDPSession(touch);
  const finger = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const [fx, fy] = [tcard.x + tcard.width / 2, tcard.y + tcard.height / 2];
  await finger("touchStart", fx, fy);
  for (let i = 1; i <= 8; i++) await finger("touchMove", fx + ((tsheet.x + 900 * tk - fx) * i) / 8, fy + ((tsheet.y + 200 * tk - fy) * i) / 8);
  await finger("touchEnd");
  await eventually(() => placed().length === 2, "a Tile placed by a finger");
  await touch.context().close();

  await card.click();
  await eventually(async () => (await card.getAttribute("class")).includes("selected"), "a click to open the component");
  check((await page.locator(".screen:not([hidden]) .sidebar.right .head-title").textContent()).includes("Tile"), "the inspector does not show the component");
}
