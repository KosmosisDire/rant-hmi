// An operator's gamepad on a running page, the browser's pads faked: south heard once per press,
// a button held ends with its buttonup when let go or when its pad goes, sticks inside their
// deadband say nothing, past it they say how far once per change with y up, and come to rest
// with zeros. A stream whose while turns false comes to rest lost. A page that may not read pads
// says so, with the https address that can.

/** The browser's pads, driven by the scenario through `__pads`. */
function fakePads() {
  const pads = [null, null, null, null];
  const button = (value) => ({ pressed: value > 0.5, touched: value > 0, value });
  window.__pads = {
    connect: (i) => (pads[i] = { index: i, id: "Fake pad", connected: true, mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => button(0)) }),
    disconnect: (i) => (pads[i] = null),
    press: (i, b, value = 1) => (pads[i].buttons[b] = button(value)),
    move: (i, axis, value) => (pads[i].axes[axis] = value),
  };
  navigator.getGamepads = () => [...pads];
}

const SOUTH = 0;

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const vars = { padsArmed: true, padsDown: 0, padsUps: "", padsLx: 0, padsLy: 0, padsFrames: 0, padsLost: 0 };
  for (const [name, start] of Object.entries(vars)) hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  const pageId = await hmi.addPage("Gamepad Run");
  const stick = await hmi.addElement(pageId, "div", { name: "Stick", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(pageId, stick, "buttondown", "padsDown = padsDown + 1;", { button: "south" });
  await hmi.setHandler(pageId, stick, "buttonup", 'padsUps = padsUps + p.button + (p.lost ? "!" : "") + " ";', {});
  await hmi.setHandler(pageId, stick, "axes", "padsLx = p.lx; padsLy = p.ly; padsFrames = padsFrames + 1; if (p.lost) padsLost = padsLost + 1;", { while: "padsArmed" });
  const value = (name) => hmi.state.values[name]?.value;

  const context = await page.context().browser().newContext();
  await context.addInitScript(fakePads);
  const screen = await context.newPage();
  await screen.goto(sys.url);
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .page-row", { hasText: /^Gamepad Run/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  await screen.locator(`.run-layer:not([hidden]) .el[data-id="${stick}"]`).waitFor();
  const pads = (call, ...args) => screen.evaluate(([call, args]) => window.__pads[call](...args), [call, args]);

  await pads("connect", 0);
  await pads("press", 0, SOUTH);
  await eventually(() => value("padsDown") === 1, "south to go down");
  await pads("press", 0, SOUTH, 0);
  await eventually(() => value("padsUps") === "south ", () => `south to come up, not "${value("padsUps")}"`);
  await pads("press", 0, SOUTH);
  await eventually(() => value("padsDown") === 2, "south to go down again");
  await pads("disconnect", 0);
  await eventually(() => value("padsUps") === "south south! ", () => `south to come up lost with its pad, not "${value("padsUps")}"`);

  await pads("connect", 0);
  await pads("move", 0, 0, 0.05);
  await screen.waitForTimeout(300);
  check(value("padsFrames") === 0, `a stick inside its deadband to say nothing, not ${value("padsFrames")} frames`);
  await pads("move", 0, 0, 0.55);
  await eventually(() => Math.abs(value("padsLx") - 0.5) < 1e-9, () => `the stick half way past its deadband, not ${value("padsLx")}`);
  await screen.waitForTimeout(300);
  check(value("padsFrames") === 1, `a still stick to say it once, not ${value("padsFrames")} times`);
  await screen.evaluate(() => {
    window.__pads.move(0, 0, 0);
    window.__pads.move(0, 1, -0.55);
  });
  await eventually(() => Math.abs(value("padsLy") - 0.5) < 1e-9 && value("padsLx") === 0, () => `the stick pushed up, not ${value("padsLx")}, ${value("padsLy")}`);
  await pads("move", 0, 1, 0);
  await eventually(() => value("padsLy") === 0 && value("padsLost") === 0, "the stick at rest");

  // disarmed mid push, the stream comes to rest lost and says no more
  await pads("move", 0, 1, -0.55);
  await eventually(() => value("padsLy") > 0.4, "the stick up again");
  hmi.set("padsArmed", false);
  await eventually(() => value("padsLost") === 1 && value("padsLy") === 0, () => `the stream to come to rest lost, not ${value("padsLost")} lost at ${value("padsLy")}`);
  const frames = value("padsFrames");
  await pads("move", 0, 1, -0.9);
  await screen.waitForTimeout(300);
  check(value("padsFrames") === frames, "a stream not heard to say nothing");

  // a page that may not read pads says so
  const plain = await page.context().browser().newContext();
  await plain.addInitScript(() => Object.defineProperty(Navigator.prototype, "getGamepads", { value: undefined }));
  const other = await plain.newPage();
  await other.goto(sys.url);
  await other.locator(".tab", { hasText: "Design" }).click();
  await other.locator(".screen:not([hidden]) .page-row", { hasText: /^Gamepad Run/ }).click();
  await other.locator(".tab", { hasText: "Run" }).click();
  const notice = other.locator(".notice .notice-text", { hasText: "Gamepads need a secure page" });
  await notice.waitFor();
  check((await notice.textContent()).includes(`https://${new URL(sys.url).host}/`), `the notice to give the https address, not "${await notice.textContent()}"`);
}
