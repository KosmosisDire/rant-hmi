// A new scene comes with a view its page keeps for each screen and the handlers that move it, the scene's own
// to change: a left drag turns round what it looks at, the middle button or two fingers slide
// it, and a wheel or a pinch brings it nearer.

export default async function ({ page, hmi, sys, d, check, eventually }) {
  await d.addPage("Scene Camera");
  const scene = await d.add("scene", { x: "4", y: "4", w: "40", h: "30" });
  const pageId = hmi.state.pages.find((p) => p.name === "Scene Camera").id;
  const made = () => hmi.page(pageId).children.find((e) => e.id === scene);
  // sceneView, or with a number where another scene took that
  await eventually(() => made()?.props.yaw, "the scene to reach the test client");
  const viewed = made().props.yaw.split(".")[0];
  check(/^sceneView\d*$/.test(viewed) && made().props.target === `${viewed}.target`, `the scene to look by its view, not ${JSON.stringify(made().props)}`);
  await eventually(() => hmi.page(pageId).state.some((v) => v.name === viewed && v.per === "screen"), "the scene's view, its page's state kept for each screen");
  const handlers = made().handlers.map((h) => `${h.event} ${JSON.stringify(h.filter)}`).join(", ");
  check(handlers === 'drag {"button":"any"}, scroll {"from":"fingers"}, zoom {}', `the scene's handlers are ${handlers}`);
  const text = await hmi.addElement(pageId, "span", { name: "Shown", x: "50", y: "4", w: "60", h: "4", text: `JSON.stringify(${viewed})` });

  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const view = async () => JSON.parse(await el(text).textContent());
  await eventually(async () => (await el(text).textContent()).startsWith("{"), "the view shown");
  const b = await el(scene).boundingBox();
  const units = (px) => px / (b.width / 40);
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  const drag = async (button, dx, dy) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up({ button });
  };
  const near = (a, b) => Math.abs(a - b) < 1e-3;

  // a left drag across turns it round, down raises it
  const start = await view();
  await drag("left", 40, 30);
  const yaw = start.yaw - (units(40) / 40) * 2 * Math.PI;
  const pitch = start.pitch + (units(30) / 30) * Math.PI;
  await eventually(async () => near((await view()).yaw, yaw) && near((await view()).pitch, pitch), async () => `a left drag to turn to ${yaw}, ${pitch}, not ${JSON.stringify(await view())}`);
  check(JSON.stringify((await view()).target) === JSON.stringify(start.target), "a left drag slid the view");

  // the middle button slides what it looks at along the screen, and leaves it turned as it was
  await drag("middle", 40, 0);
  await eventually(async () => (await view()).target.x !== start.target.x, "a middle drag to slide the view");
  const slid = await view();
  check(near(slid.yaw, yaw) && near(slid.target.z, start.target.z), `a middle drag across to keep the turn and height, ${JSON.stringify(slid)}`);

  // a wheel turned down takes it further away
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 100);
  await eventually(async () => (await view()).distance > slid.distance, "a wheel down to take the view further away");

  // two fingers slide it, and spread bring it nearer, on a touch screen with its own view
  const touch = await (await page.context().browser().newContext({ hasTouch: true, viewport: { width: 1280, height: 800 } })).newPage();
  await touch.goto(sys.url);
  await touch.locator(".statusbar", { hasText: "System" }).waitFor();
  await touch.locator(".tab", { hasText: "Design" }).click();
  await touch.locator(".screen:not([hidden]) .page-row", { hasText: /^Scene Camera/ }).click();
  await touch.locator(".tab", { hasText: "Run" }).click();
  const at = (id) => touch.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await at(text).textContent()).startsWith("{"), "the view shown on the touch screen");
  const own = async () => JSON.parse(await at(text).textContent());
  const first = await own();
  check(near(first.yaw, start.yaw), `a new screen to start with its own view, not ${JSON.stringify(first)}`);
  const t = await at(scene).boundingBox();
  const cdp = await touch.context().newCDPSession(touch);
  const fingers = (type, ...points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([fx, fy]) => ({ x: fx, y: fy })) });
  const [cx, cy] = [t.x + t.width / 2, t.y + t.height / 2];
  await fingers("touchStart", [cx - 20, cy], [cx + 20, cy]);
  await fingers("touchMove", [cx - 20, cy + 30], [cx + 20, cy + 30]);
  await fingers("touchEnd");
  await eventually(async () => (await own()).target.z !== first.target.z, async () => `two fingers drawn down to slide the view, not ${JSON.stringify(await own())}`);
  const before = (await own()).distance;
  await fingers("touchStart", [cx - 20, cy], [cx + 20, cy]);
  await fingers("touchMove", [cx - 40, cy], [cx + 40, cy]);
  await fingers("touchEnd");
  await eventually(async () => near((await own()).distance, before / 2), async () => `fingers spread twice as far to halve the distance, not ${(await own()).distance}`);
}
