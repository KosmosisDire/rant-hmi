// Fingers on a running page's touch screen. Two fingers on what scrolls and zooms end the press
// the first began, a release with no tap and no more drag, and scroll by their middle and zoom
// by their spread. One finger scrolls a list once it moves a little, pressing no row it began
// on, but drags what drags. Safari's trackpad pinch zooms, and the browser pans nothing under
// what scrolls.

export default async function ({ page, hmi, sys, check, eventually }) {
  const vars = { pinPress: 0, pinRelease: 0, pinTaps: 0, pinPanX: 0, pinScrollX: 0, pinScrollY: 0, pinZoom: 1, pinListY: 0, pinRowPress: 0, pinRowRelease: 0, pinRowTaps: 0, pinKnobX: 0 };
  for (const [name, start] of Object.entries(vars)) hmi.setVariable(`Hmi.${name}`, start);
  const pageId = await hmi.addPage("Pinch View");
  const view = await hmi.addElement(pageId, "div", { name: "Pinchable", x: "10", y: "10", w: "40", h: "30", background: "#2a2f35" });
  const on = async (id, handlers) => {
    for (const [event, code] of Object.entries(handlers)) await hmi.setHandler(pageId, id, event, code);
  };
  await on(view, {
    press: "Hmi.pinPress = Hmi.pinPress + 1;",
    release: "Hmi.pinRelease = Hmi.pinRelease + 1;",
    tap: "Hmi.pinTaps = Hmi.pinTaps + 1;",
    drag: "Hmi.pinPanX = Hmi.pinPanX + p.dx;",
    scroll: "Hmi.pinScrollX = Hmi.pinScrollX + p.dx;\nHmi.pinScrollY = Hmi.pinScrollY + p.dy;",
    zoom: "Hmi.pinZoom = Hmi.pinZoom * p.factor;",
  });
  const list = await hmi.addElement(pageId, "div", { name: "List", x: "60", y: "10", w: "20", h: "30", background: "#2a2f35" });
  await on(list, { scroll: "Hmi.pinListY = Hmi.pinListY + p.dy;" });
  const row = await hmi.addElement(pageId, "div", { name: "Row", x: "2", y: "2", w: "16", h: "6", background: "#30363d" }, list);
  await on(row, { press: "Hmi.pinRowPress = Hmi.pinRowPress + 1;", release: "Hmi.pinRowRelease = Hmi.pinRowRelease + 1;", tap: "Hmi.pinRowTaps = Hmi.pinRowTaps + 1;" });
  const knob = await hmi.addElement(pageId, "div", { name: "Knob", x: "2", y: "20", w: "6", h: "6", background: "#4a8fd6" }, list);
  await on(knob, { drag: "Hmi.pinKnobX = Hmi.pinKnobX + p.dx;" });
  const value = (name) => hmi.state.values[name]?.value;
  const near = (a, b) => Math.abs(a - b) < 1e-3;

  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .page-row", { hasText: /^Pinch View/ }).click();
  await touch.locator(".tab", { hasText: "Run" }).click();
  const el = (id) => touch.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await el(view).waitFor();
  const cdp = await touch.context().newCDPSession(touch);
  const fingers = (type, ...points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y]) => ({ x, y })) });
  const v = await el(view).boundingBox();
  // screen px to the page's units, as the run draws it
  const units = (px) => px / (v.width / 40);

  // two fingers: the first presses, the second ends it, then they spread twice as far and move
  const [cx, cy] = [v.x + v.width / 2, v.y + v.height / 2];
  await fingers("touchStart", [cx - 20, cy]);
  await eventually(() => value("Hmi.pinPress") === 1, "the first finger to press");
  await fingers("touchStart", [cx - 20, cy], [cx + 20, cy]);
  await eventually(() => value("Hmi.pinRelease") === 1, "the second finger to end the press");
  await fingers("touchMove", [cx - 30, cy + 10], [cx + 50, cy + 10]);
  await fingers("touchEnd");
  await eventually(() => near(value("Hmi.pinZoom"), 2), () => `fingers spread twice as far to zoom twice as big, not ${value("Hmi.pinZoom")}`);
  await eventually(() => near(value("Hmi.pinScrollX"), units(10)) && near(value("Hmi.pinScrollY"), units(10)), () => `their middle moved 10 px each way to scroll ${units(10)}, not ${value("Hmi.pinScrollX")}, ${value("Hmi.pinScrollY")}`);
  check(value("Hmi.pinTaps") === 0 && value("Hmi.pinRelease") === 1 && value("Hmi.pinPanX") === 0, `the press to end once with no tap or drag, not ${value("Hmi.pinRelease")} releases, ${value("Hmi.pinTaps")} taps, ${value("Hmi.pinPanX")} dragged`);

  // one finger on the list off its row scrolls it once past a little, the move from where it went down
  const l = await el(list).boundingBox();
  check((await el(list).evaluate((e) => getComputedStyle(e).touchAction)) === "none", "the browser to pan nothing under what scrolls");
  const step = async (x, y, dx, dy) => {
    await fingers("touchStart", [x, y]);
    for (let i = 1; i <= 3; i++) await fingers("touchMove", [x + (dx * i) / 3, y + (dy * i) / 3]);
    await fingers("touchEnd");
  };
  await step(l.x + l.width / 2, l.y + l.height * 0.6, 0, -60);
  await eventually(() => near(value("Hmi.pinListY"), units(-60)), () => `a finger drawn up 60 px to scroll ${units(-60)}, not ${value("Hmi.pinListY")}`);
  const r = await el(row).boundingBox();
  await step(r.x + r.width / 2, r.y + r.height / 2, 0, -30);
  await eventually(() => near(value("Hmi.pinListY"), units(-90)), () => `a finger from the row to scroll the list too, not ${value("Hmi.pinListY")}`);
  await touch.waitForTimeout(300);
  check(value("Hmi.pinRowPress") === 0 && value("Hmi.pinRowRelease") === 0 && value("Hmi.pinRowTaps") === 0, `the row never pressed, not ${value("Hmi.pinRowPress")} presses, ${value("Hmi.pinRowRelease")} releases, ${value("Hmi.pinRowTaps")} taps`);
  const k = await el(knob).boundingBox();
  await step(k.x + k.width / 2, k.y + k.height / 2, 30, -30);
  await eventually(() => near(value("Hmi.pinKnobX"), units(30)), () => `the knob to drag ${units(30)}, not ${value("Hmi.pinKnobX")}`);
  check(near(value("Hmi.pinListY"), units(-90)), `a finger dragging the knob to scroll nothing, the list at ${value("Hmi.pinListY")}`);

  // Safari's pinch on a trackpad comes as gesture events
  await el(view).evaluate((e) => {
    const r = e.getBoundingClientRect();
    const send = (type, scale) => e.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    send("gesturestart", 1);
    send("gesturechange", 1.5);
  });
  await eventually(() => near(value("Hmi.pinZoom"), 3), () => `a trackpad's pinch to zoom 1.5 times more, not ${value("Hmi.pinZoom")}`);
}
