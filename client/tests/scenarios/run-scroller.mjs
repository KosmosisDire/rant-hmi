// A frame whose overflow scrolls, on a running touch screen. A finger drawn over its rows scrolls
// it and presses none, not even the card that holds it, while one that stays presses and taps the
// row under it. What drags in it keeps its finger, and a wheel scrolls it too.

export default async function ({ page, hmi, sys, check, eventually }) {
  const vars = { scrPress: 0, scrRelease: 0, scrTaps: 0, scrTapped: -1, scrKnobX: 0, scrCardPress: 0 };
  for (const [name, start] of Object.entries(vars)) hmi.setVariable(`Hmi.${name}`, start);
  const pageId = await hmi.addPage("Scroll List");
  // a card that holds the list, as a dropdown's face does
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "10", y: "10", w: "24", h: "28", background: "#22262b" });
  await hmi.setHandler(pageId, card, "press", "Hmi.scrCardPress = Hmi.scrCardPress + 1;");
  const list = await hmi.addElement(pageId, "div", { name: "List", x: "2", y: "2", w: "20", h: "24", layout: '"down"', gap: "1", padding: "1", background: "#2a2f35", "overflow-y": '"auto"' }, card);
  const knob = await hmi.addElement(pageId, "div", { name: "Knob", w: "6", h: "4", background: "#4a8fd6" }, list);
  await hmi.setHandler(pageId, knob, "drag", "Hmi.scrKnobX = Hmi.scrKnobX + p.dx;");
  const row = await hmi.addElement(pageId, "div", { name: "Row", w: "fill", h: "5", repeat: "12", background: "#30363d" }, list);
  for (const [event, code] of Object.entries({ press: "Hmi.scrPress = Hmi.scrPress + 1;", release: "Hmi.scrRelease = Hmi.scrRelease + 1;", tap: "Hmi.scrTaps = Hmi.scrTaps + 1;\nHmi.scrTapped = index;" })) await hmi.setHandler(pageId, row, event, code);
  const value = (name) => hmi.state.values[name]?.value;

  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .page-row", { hasText: /^Scroll List/ }).click();
  await touch.locator(".tab", { hasText: "Run" }).click();
  const el = (id) => touch.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const rows = el(row);
  await rows.nth(11).waitFor({ state: "attached" });
  const cdp = await touch.context().newCDPSession(touch);
  const fingers = (type, ...points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y]) => ({ x, y })) });
  const drawn = async (x, y, dx, dy) => {
    await fingers("touchStart", [x, y]);
    for (let i = 1; i <= 6; i++) await fingers("touchMove", [x + (dx * i) / 6, y + (dy * i) / 6]);
    await fingers("touchEnd");
  };
  const top = () => el(list).evaluate((e) => e.scrollTop);
  const presses = () => `${value("Hmi.scrPress")} presses, ${value("Hmi.scrRelease")} releases, ${value("Hmi.scrTaps")} taps`;
  check((await rows.first().evaluate((e) => getComputedStyle(e).touchAction)) === "pan-x pan-y", "a row to let the browser scroll the list");
  check((await el(knob).evaluate((e) => getComputedStyle(e).touchAction)) === "none", "the knob to keep its finger");

  // the knob drags, and the list stays put
  const k = await el(knob).boundingBox();
  await drawn(k.x + k.width / 2, k.y + k.height / 2, 30, -30);
  const units = (px) => px / (k.width / 6);
  await eventually(() => Math.abs(value("Hmi.scrKnobX") - units(30)) < 1e-3, () => `the knob to drag ${units(30)}, not ${value("Hmi.scrKnobX")}`);
  check((await top()) === 0, `a finger dragging the knob to scroll nothing, the list at ${await top()}`);

  // a finger drawn up over the rows scrolls the list and presses none, the knob's finger having
  // pressed the card as it let go
  const cardWas = value("Hmi.scrCardPress");
  const r = await rows.nth(1).boundingBox();
  await drawn(r.x + r.width / 2, r.y + r.height / 2, 0, -120);
  await eventually(async () => (await top()) > 60, async () => `a finger drawn up 120 px to scroll the list, at ${await top()}`);
  await touch.waitForTimeout(300);
  check(value("Hmi.scrPress") === 0 && value("Hmi.scrRelease") === 0 && value("Hmi.scrTaps") === 0, `a scroll to press no row, not ${presses()}`);
  check(value("Hmi.scrCardPress") === cardWas, `a scroll to press no card, pressed ${value("Hmi.scrCardPress") - cardWas} times`);

  // a finger that stays presses once it has stayed a moment, then taps the row it let go on,
  // the first wholly in view however far the list went on scrolling
  const view = await el(list).boundingBox();
  const boxes = await rows.evaluateAll((es) => es.map((e) => e.getBoundingClientRect()).map((r) => ({ y: r.y, height: r.height })));
  const n = boxes.findIndex((r) => r.y >= view.y && r.y + r.height <= view.y + view.height);
  const shown = await rows.nth(n).boundingBox();
  const [x, y] = [shown.x + shown.width / 2, shown.y + shown.height / 2];
  await fingers("touchStart", [x, y]);
  await eventually(() => value("Hmi.scrPress") === 1, () => `a finger that stays to press, not ${presses()}`);
  await fingers("touchEnd");
  await eventually(() => value("Hmi.scrTaps") === 1 && value("Hmi.scrTapped") === n, () => `a tap on row ${n}, not ${presses()} on ${value("Hmi.scrTapped")}`);
  // a quick tap presses, lets go and taps at once
  await fingers("touchStart", [x, y]);
  await fingers("touchEnd");
  await eventually(() => value("Hmi.scrTaps") === 2, () => `a quick tap, not ${presses()}`);
  check(value("Hmi.scrPress") === 2 && value("Hmi.scrRelease") === 2, `each tap to press and let go once, not ${presses()}`);

  // a wheel scrolls it too
  const was = await top();
  await touch.mouse.move(x, y);
  await touch.mouse.wheel(0, -200);
  await eventually(async () => (await top()) < was, async () => `a wheel to scroll the list back from ${was}, at ${await top()}`);
}
