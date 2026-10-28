// A designer makes a view that pans and zooms a camera's picture, in the editor alone and with
// no widget made for it: a frame that clips, the picture in it placed and scaled by the screen's
// own variables, and the frame's drag, scroll and zoom handlers. Running, the picture follows a
// drag and the wheel, and Ctrl with the wheel or two fingers zoom it about the pointer or their
// middle, the spot under them staying put.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const i of hmi.state.imports.filter((x) => x.entity === "Cell/Camera" && x.alias !== "Cell.Camera")) await hmi.unimport(i.alias);
  if (!hmi.object("Cell")) await hmi.addObject("Cell", "Cell");
  await d.openObject("Cell");
  const row = await d.meshRow("Cell/Camera");
  if ((await row.locator(".row-add").count()) > 0) await row.locator(".row-add").click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Cell.Camera"), "Camera added");
  for (const [name, start] of [["Hmi.mapX", 0], ["Hmi.mapY", 0], ["Hmi.mapZoom", 1]]) hmi.setVariable(name, start, "screen");
  await eventually(() => hmi.state.variables.some((v) => v.name === "Hmi.mapZoom"), "the view's variables");

  await d.addPage("Map View");
  const view = await d.add("frame", { Name: "Viewport", x: "4", y: "4", w: "48", h: "36", Fill: "$panel", Overflow: '"hidden"' });
  const map = await d.add("media", { Name: "Map", x: "Hmi.mapX", y: "Hmi.mapY", w: "48", h: "36", Source: "Cell.Camera" });
  await d.css("scale: Hmi.mapZoom");
  await d.select("Viewport");
  await d.handler("drag", "Hmi.mapX = Hmi.mapX + p.dx;\nHmi.mapY = Hmi.mapY + p.dy;");
  await d.handler("scroll", "Hmi.mapX = Hmi.mapX + p.dx;\nHmi.mapY = Hmi.mapY + p.dy;");
  await d.handler("zoom", "// the spot under the pointer stays under it\nconst [cx, cy] = [p.x * 48, p.y * 36];\nconst k = clamp(Hmi.mapZoom * p.factor, 1, 8) / Hmi.mapZoom;\nHmi.mapX = cx - (cx - Hmi.mapX) * k;\nHmi.mapY = cy - (cy - Hmi.mapY) * k;\nHmi.mapZoom = Hmi.mapZoom * k;");

  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const box = (id) => el(id).boundingBox();
  const near = (a, b, by = 1.5) => Math.abs(a - b) <= by;
  await el(map).waitFor();
  const v = await box(view);
  const [cx, cy] = [v.x + v.width / 2, v.y + v.height / 2];
  // the spot of the picture under a point, as a share of it across and down
  const under = (m, x, y) => [(x - m.x) / m.width, (y - m.y) / m.height];
  const stays = async (spot, x, y, what) => {
    let m;
    await eventually(async () => {
      m = await box(map);
      return near(m.x + spot[0] * m.width, x) && near(m.y + spot[1] * m.height, y);
    }, () => `${what}: the spot to stay at ${x}, ${y}, not ${m.x + spot[0] * m.width}, ${m.y + spot[1] * m.height}`);
    return m;
  };

  // a drag carries it with the pointer
  const m0 = await box(map);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(cx + 10 * i, cy + 5 * i);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await stays(under(m0, cx, cy), cx + 60, cy + 30, "a drag");

  // the wheel turned down scrolls it up
  const m1 = await box(map);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 100);
  await stays(under(m1, cx, cy), cx, cy - 100, "the wheel");

  // Ctrl with the wheel zooms in about the pointer
  const [px, py] = [cx + 40, cy - 20];
  const m2 = await box(map);
  await page.mouse.move(px, py);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  const m3 = await stays(under(m2, px, py), px, py, "a zoom");
  check(near(m3.width / m2.width, Math.exp(0.2), 0.01), `a notch to zoom in ${Math.exp(0.2)} times, not ${m3.width / m2.width}`);

  // two fingers spread twice as far zoom it twice as big about their middle
  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1600, height: 1000 } })).newPage();
  await touch.goto(page.url());
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .page-row", { hasText: /^Map View/ }).click();
  await touch.locator(".tab", { hasText: "Run" }).click();
  const on = (id) => touch.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await on(map).waitFor();
  const t = await on(view).boundingBox();
  const [tx, ty] = [t.x + t.width / 2, t.y + t.height / 2];
  // its own view, as each screen keeps its own
  let before;
  await eventually(async () => near((before = await on(map).boundingBox()).width, t.width), "the second screen's view at its start");
  const cdp = await touch.context().newCDPSession(touch);
  const fingers = (type, ...points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y]) => ({ x, y })) });
  await fingers("touchStart", [tx - 30, ty]);
  await fingers("touchStart", [tx - 30, ty], [tx + 30, ty]);
  await fingers("touchMove", [tx - 60, ty], [tx + 60, ty]);
  await fingers("touchEnd");
  const spot = under(before, tx, ty);
  let after;
  await eventually(async () => {
    after = await on(map).boundingBox();
    return near(after.width, 2 * before.width) && near(after.x + spot[0] * after.width, tx) && near(after.y + spot[1] * after.height, ty);
  }, () => `a pinch to zoom twice as big about its middle, not ${after.width / before.width} times with the spot at ${after.x + spot[0] * after.width}, ${after.y + spot[1] * after.height}`);
}
