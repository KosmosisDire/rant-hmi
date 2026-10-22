// An operator drags, scrolls and zooms on a running page. A drag's dx and dy count as the
// element's own x and y, so a puck moved by them follows the pointer, in a turned and scaled
// frame and in a diagram too. A wheel scrolls what a viewport shows the other way, across with
// Shift, and zooms it with Ctrl; an element with no scroll zooms by any wheel. Moves that come
// while a slow handler runs add up, and a turn an inner element does not hear is the outer's.

export default async function ({ page, hmi, d, check, eventually }) {
  const vars = { wvPuckX: 4, wvPuckY: 30, wvTurnX: 2, wvTurnY: 2, wvDotX: 10, wvScrollX: 0, wvScrollY: 0, wvInner: false, wvInnerHits: 0, wvZoom: 1, wvZoomAt: 0, wvMapZoom: 1 };
  for (const [name, start] of Object.entries(vars)) hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  const pageId = await hmi.addPage("Wheel View");
  const puck = await hmi.addElement(pageId, "div", { name: "Puck", x: "wvPuckX", y: "wvPuckY", w: "6", h: "6", background: "#4a8fd6" });
  await hmi.setHandler(pageId, puck, "drag", "await sleep(120);\nwvPuckX = wvPuckX + p.dx;\nwvPuckY = wvPuckY + p.dy;");
  const turned = await hmi.addElement(pageId, "div", { name: "Turned", x: "60", y: "30", w: "20", h: "20", rotate: "90", scale: "1.5", background: "#2a2f35" });
  const puck2 = await hmi.addElement(pageId, "div", { name: "Puck2", x: "wvTurnX", y: "wvTurnY", w: "4", h: "4", background: "#e5484d" }, turned);
  await hmi.setHandler(pageId, puck2, "drag", "wvTurnX = wvTurnX + p.dx;\nwvTurnY = wvTurnY + p.dy;");
  const plot = await hmi.addElement(pageId, "svg", { name: "Plot", x: "4", y: "50", w: "20", h: "20", viewbox: '"0 0 50 50"', background: "#2a2f35" });
  const dot = await hmi.addElement(pageId, "circle", { name: "Dot", cx: "wvDotX", cy: "25", r: "4", fill: '"#30a46c"' }, plot);
  await hmi.setHandler(pageId, dot, "drag", "wvDotX = wvDotX + p.dx;");
  const view = await hmi.addElement(pageId, "div", { name: "Viewport", x: "30", y: "4", w: "30", h: "20", overflow: '"hidden"', background: "#2a2f35" });
  const content = await hmi.addElement(pageId, "div", { name: "Content", x: "wvScrollX", y: "wvScrollY", w: "200", h: "200", background: "#30363d" }, view);
  await hmi.setHandler(pageId, view, "scroll", "await sleep(150);\nwvScrollX = wvScrollX + p.dx;\nwvScrollY = wvScrollY + p.dy;");
  await hmi.setHandler(pageId, view, "zoom", "wvZoom = wvZoom * p.factor;\nwvZoomAt = p.x;");
  await hmi.setHandler(pageId, content, "scroll", "wvInnerHits = wvInnerHits + 1;", { while: "wvInner" });
  const map = await hmi.addElement(pageId, "div", { name: "Map", x: "90", y: "4", w: "20", h: "20", background: "#2a2f35" });
  await hmi.setHandler(pageId, map, "zoom", "wvMapZoom = wvMapZoom * p.factor;");
  const value = (name) => hmi.state.values[name]?.value;

  await d.openPage("Wheel View");
  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const box = (id) => el(id).boundingBox();
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  const dragBy = async (id, dx, dy) => {
    const b = await box(id);
    const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
  };
  const follows = async (id, dx, dy, what) => {
    const from = await box(id);
    await dragBy(id, dx, dy);
    let now;
    await eventually(async () => {
      now = await box(id);
      return near(now.x - from.x, dx) && near(now.y - from.y, dy);
    }, () => `${what} to follow the pointer by ${dx}, ${dy}, not ${now.x - from.x}, ${now.y - from.y}`);
  };

  await el(puck).waitFor();
  await follows(puck, 120, 60, "a puck whose slow handler gathers its drags");
  await follows(puck2, 60, 30, "a puck in a turned and scaled frame");
  await follows(dot, 80, 0, "a dot in a diagram");

  // the inner element does not hear, so the viewport scrolls, five turns through one slow run
  const v = await box(view);
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  const start = await box(content);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(30);
  }
  let now;
  await eventually(async () => near((now = await box(content)).y - start.y, -500), () => `a wheel turned down 500 px to move what shows up as far, not ${now.y - start.y}`);
  check(near(now.x, start.x), "a wheel turned down to move nothing across");
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Shift");
  await eventually(async () => near((now = await box(content)).x - start.x, -100), () => `a turn with Shift to scroll across, not ${now.x - start.x}`);

  hmi.set("wvInner", true);
  await eventually(() => value("wvInner") === true, "the inner element to hear");
  const before = value("wvScrollY");
  await page.mouse.wheel(0, 100);
  await eventually(() => value("wvInnerHits") === 1, "the inner element to take the turn");
  await page.waitForTimeout(300);
  check(value("wvScrollY") === before, `a turn the inner element took to scroll nothing around it, not ${value("wvScrollY")} from ${before}`);

  // Ctrl makes it a zoom, which the inner element does not take
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await eventually(() => Math.abs(value("wvZoom") - Math.exp(-0.2)) < 1e-6, () => `a notch with Ctrl to zoom out to ${Math.exp(-0.2)}, not ${value("wvZoom")}`);
  check(Math.abs(value("wvZoomAt") - 0.5) < 0.02, `the zoom to say where, not ${value("wvZoomAt")}`);

  const m = await box(map);
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.wheel(0, -100);
  await eventually(() => Math.abs(value("wvMapZoom") - Math.exp(0.2)) < 1e-6, () => `a plain wheel on what only zooms to zoom in, not ${value("wvMapZoom")}`);
}
