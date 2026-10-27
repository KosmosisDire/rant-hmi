// What a press brings and which handlers take it, on a running page. A handler takes the left
// button unless its filter names another, a press brings its button, the keys held and the
// element's size, and a scroll or a zoom names what it came from, so fingers may slide what a
// wheel zooms.

export default async function ({ page, hmi, sys, check, eventually }) {
  const vars = { btLeft: 0, btMiddle: 0, btRight: 0, btTaps: 0, btTapped: "", fgScroll: 0, fgZoom: 1, fgFrom: "" };
  for (const [name, start] of Object.entries(vars)) hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  const pageId = await hmi.addPage("Pointer Buttons");
  const pad = await hmi.addElement(pageId, "div", { name: "Pad", x: "10", y: "10", w: "20", h: "10", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "drag", "btLeft = btLeft + p.dx;");
  await hmi.setHandler(pageId, pad, "drag", "btMiddle = btMiddle + p.dx;", undefined, { button: "middle" });
  await hmi.setHandler(pageId, pad, "press", "btRight = btRight + 1;", undefined, { button: "right" });
  await hmi.setHandler(pageId, pad, "tap", "btTaps = btTaps + 1;\nbtTapped = `${p.button} ${p.shift} ${p.w} ${p.h}`;");
  const view = await hmi.addElement(pageId, "div", { name: "View", x: "40", y: "10", w: "20", h: "20", background: "#30363d" });
  await hmi.setHandler(pageId, view, "scroll", "fgScroll = fgScroll + p.dy;", undefined, { from: "fingers" });
  await hmi.setHandler(pageId, view, "zoom", "fgZoom = fgZoom * p.factor;\nfgFrom = p.from;");
  const value = (name) => hmi.state.values[name]?.value;
  const near = (a, b) => Math.abs(a - b) < 1e-3;

  await page.locator(".tab", { hasText: "Design" }).click();
  await page.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Pointer Buttons/ }).click();
  await page.locator(".tab", { hasText: "Run" }).click();
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const b = await el(pad).boundingBox();
  const units = (px) => px / (b.width / 20);
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  const drag = async (button) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x + 30, y, { steps: 3 });
    await page.mouse.up({ button });
  };

  // a left drag goes to the handler with no filter, then taps as it lets go over the pad
  await drag("left");
  await eventually(() => near(value("btLeft"), units(30)) && value("btTaps") === 1, () => `a left drag of ${units(30)}, not ${value("btLeft")} with ${value("btTaps")} taps`);
  check(value("btMiddle") === 0, `a left drag to move the middle's handler ${value("btMiddle")}`);
  // the middle button goes only to the handler that names it, and taps nothing
  await drag("middle");
  await eventually(() => near(value("btMiddle"), units(30)), () => `a middle drag of ${units(30)}, not ${value("btMiddle")}`);
  check(near(value("btLeft"), units(30)) && value("btTaps") === 1, `a middle drag to reach the left's handlers, ${value("btLeft")} and ${value("btTaps")} taps`);
  await page.mouse.click(x, y, { button: "right" });
  await eventually(() => value("btRight") === 1, "a right press");
  check(value("btTaps") === 1, `a right click to tap, ${value("btTaps")} taps`);
  // a tap brings the button, the keys held and the pad's size in units
  await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  await page.keyboard.up("Shift");
  await eventually(() => value("btTapped") === "left true 20 10", () => `a tap with Shift to bring left true 20 10, not ${value("btTapped")}`);

  // a wheel goes to the zoom, as the scroll takes only fingers
  const v = await el(view).boundingBox();
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.mouse.wheel(0, 100);
  await eventually(() => value("fgZoom") < 1 && value("fgFrom") === "wheel", () => `a wheel to zoom, not ${value("fgZoom")} from ${value("fgFrom")}`);
  check(value("fgScroll") === 0, `a wheel to scroll ${value("fgScroll")}`);

  // two fingers moving together slide it, from fingers
  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Pointer Buttons/ }).click();
  await touch.locator(".tab", { hasText: "Run" }).click();
  const there = touch.locator(`.run-layer:not([hidden]) .el[data-id="${view}"]`);
  await there.waitFor();
  const t = await there.boundingBox();
  const cdp = await touch.context().newCDPSession(touch);
  const fingers = (type, ...points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([fx, fy]) => ({ x: fx, y: fy })) });
  const [cx, cy] = [t.x + t.width / 2, t.y + t.height / 2];
  await fingers("touchStart", [cx - 20, cy], [cx + 20, cy]);
  await fingers("touchMove", [cx - 20, cy + 20], [cx + 20, cy + 20]);
  await fingers("touchEnd");
  const touchUnits = (px) => px / (t.width / 20);
  await eventually(() => near(value("fgScroll"), touchUnits(20)), () => `two fingers to slide ${touchUnits(20)}, not ${value("fgScroll")}`);
}
