// A press reads where it landed before anything changes the page: Firefox before 125 drops the
// rest of a touch when its pressed shape restyles and is measured within pointerdown, which left
// a tapped joystick's knob stuck. So no layout read may follow a change of the page while a
// pointerdown is heard, by a finger or a mouse, on a shape in a component whose instance hears
// press and release, with another element hearing outside.

export default async function ({ page, hmi, sys, check, eventually }) {
  for (const name of ["orderPress", "orderRelease", "orderOutside"]) hmi.send({ type: "set_variable", name, variable: { name, start: 0, per: "hmi" } });
  const stick = await hmi.addComponent("Stick");
  await hmi.edit({ kind: "resize_page", page: stick, width: 20, height: 20 });
  const pad = await hmi.addElement(stick, "svg", { name: "pad", x: "0", y: "0", w: "20", h: "20" });
  // the base turns while pressed, as a designer may bind, besides the pressed look's darkening
  const base = await hmi.addElement(stick, "circle", { name: "base", cx: "10", cy: "10", r: "9.5", fill: "#2a2f35", rotate: "base.pressed ? 5 : 0" }, pad);
  await hmi.setHandler(stick, base, "press", "// the pressed look");
  await hmi.addElement(stick, "circle", { name: "knob", cx: "10", cy: "10", r: "3", fill: 'base.pressed ? "#4a8fd6" : "#888888"', "pointer-events": '"none"' }, pad);

  const pageId = await hmi.addPage("Press order");
  const inst = await hmi.addElement(pageId, "use", { name: "Stick", x: "4", y: "4", w: "20", h: "20" }, null, "Stick");
  await hmi.setHandler(pageId, inst, "press", "orderPress = orderPress + 1;");
  await hmi.setHandler(pageId, inst, "release", "orderRelease = orderRelease + 1;");
  const other = await hmi.addElement(pageId, "div", { name: "Other", x: "30", y: "4", w: "10", h: "10", background: "#333333" });
  await hmi.setHandler(pageId, other, "outside", "orderOutside = orderOutside + 1;");

  const context = await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } });
  // each layout read while a pointerdown is heard takes the page's changes since it began
  await context.addInitScript(() => {
    window.__late = [];
    const seen = new MutationObserver(() => {});
    seen.observe(document, { attributes: true, childList: true, subtree: true, characterData: true });
    addEventListener("pointerdown", () => seen.takeRecords(), true);
    const guard = (name, read) =>
      function (...args) {
        const changed = window.event?.type === "pointerdown" ? seen.takeRecords() : [];
        if (changed.length) window.__late.push(`${name} after ${changed.map((m) => `${m.attributeName ?? m.type} of ${m.target.dataset?.name ?? m.target.nodeName}`).join(", ")}`);
        return read.apply(this, args);
      };
    for (const [proto, name] of [
      [Element.prototype, "getBoundingClientRect"],
      [SVGGraphicsElement.prototype, "getScreenCTM"],
      [SVGGraphicsElement.prototype, "getBBox"],
    ])
      proto[name] = guard(name, proto[name]);
    window.getComputedStyle = guard("getComputedStyle", window.getComputedStyle);
    for (const name of ["offsetWidth", "offsetHeight"]) {
      const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, { get: guard(name, d.get) });
    }
  });
  const screen = await context.newPage();
  await screen.goto(sys.url);
  await screen.locator(".statusbar", { hasText: "System" }).waitFor();
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .pages .list-row", { hasText: /^Press order/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  const drawn = screen.locator(`.run-layer:not([hidden]) .el[data-id="${inst}"] [data-name="base"]`);
  await drawn.waitFor();
  const b = await drawn.boundingBox();
  const [x, y] = [b.x + b.width * 0.7, b.y + b.height * 0.6];
  const cdp = await context.newCDPSession(screen);
  const finger = (type) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const shared = (name) => hmi.state.values[name]?.value;
  const outside = shared("orderOutside");

  for (let n = 1; n <= 2; n++) {
    await finger("touchStart");
    await screen.waitForTimeout(60);
    await finger("touchEnd");
    await eventually(() => shared("orderRelease") === n * 2 - 1, () => `finger tap ${n} to press and release, ${shared("orderPress")} and ${shared("orderRelease")}`);
    await screen.mouse.click(x, y);
    await eventually(() => shared("orderRelease") === n * 2, () => `click ${n} to press and release, ${shared("orderPress")} and ${shared("orderRelease")}`);
  }
  check(shared("orderPress") === 4, `four presses heard as ${shared("orderPress")}`);
  await eventually(() => shared("orderOutside") - outside === 4, () => `four presses outside Other, heard as ${shared("orderOutside") - outside}`);
  const late = await screen.evaluate(() => window.__late);
  check(late.length === 0, `the page was measured after it changed within a pointerdown:\n${late.join("\n")}`);
  await context.close();
}
