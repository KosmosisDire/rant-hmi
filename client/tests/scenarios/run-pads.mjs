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
  for (const [name, start] of Object.entries(vars)) hmi.setVariable(`Hmi.${name}`, start);
  const pageId = await hmi.addPage("Gamepad Run");
  const stick = await hmi.addElement(pageId, "div", { name: "Stick", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(pageId, stick, "buttondown", "Hmi.padsDown = Hmi.padsDown + 1;", { button: "south" });
  await hmi.setHandler(pageId, stick, "buttonup", 'Hmi.padsUps = Hmi.padsUps + p.button + (p.lost ? "!" : "") + " ";', {});
  await hmi.setHandler(pageId, stick, "axes", "Hmi.padsLx = p.lx; Hmi.padsLy = p.ly; Hmi.padsFrames = Hmi.padsFrames + 1; if (p.lost) Hmi.padsLost = Hmi.padsLost + 1;", { while: "Hmi.padsArmed" });
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
  await eventually(() => value("Hmi.padsDown") === 1, "south to go down");
  await pads("press", 0, SOUTH, 0);
  await eventually(() => value("Hmi.padsUps") === "south ", () => `south to come up, not "${value("Hmi.padsUps")}"`);
  await pads("press", 0, SOUTH);
  await eventually(() => value("Hmi.padsDown") === 2, "south to go down again");
  await pads("disconnect", 0);
  await eventually(() => value("Hmi.padsUps") === "south south! ", () => `south to come up lost with its pad, not "${value("Hmi.padsUps")}"`);

  await pads("connect", 0);
  await pads("move", 0, 0, 0.05);
  await screen.waitForTimeout(300);
  check(value("Hmi.padsFrames") === 0, `a stick inside its deadband to say nothing, not ${value("Hmi.padsFrames")} frames`);
  await pads("move", 0, 0, 0.55);
  await eventually(() => Math.abs(value("Hmi.padsLx") - 0.5) < 1e-9, () => `the stick half way past its deadband, not ${value("Hmi.padsLx")}`);
  await screen.waitForTimeout(300);
  check(value("Hmi.padsFrames") === 1, `a still stick to say it once, not ${value("Hmi.padsFrames")} times`);
  await screen.evaluate(() => {
    window.__pads.move(0, 0, 0);
    window.__pads.move(0, 1, -0.55);
  });
  await eventually(() => Math.abs(value("Hmi.padsLy") - 0.5) < 1e-9 && value("Hmi.padsLx") === 0, () => `the stick pushed up, not ${value("Hmi.padsLx")}, ${value("Hmi.padsLy")}`);
  await pads("move", 0, 1, 0);
  await eventually(() => value("Hmi.padsLy") === 0 && value("Hmi.padsLost") === 0, "the stick at rest");

  // disarmed mid push, the stream comes to rest lost and says no more
  await pads("move", 0, 1, -0.55);
  await eventually(() => value("Hmi.padsLy") > 0.4, "the stick up again");
  hmi.set("Hmi.padsArmed", false);
  await eventually(() => value("Hmi.padsLost") === 1 && value("Hmi.padsLy") === 0, () => `the stream to come to rest lost, not ${value("Hmi.padsLost")} lost at ${value("Hmi.padsLy")}`);
  const frames = value("Hmi.padsFrames");
  await pads("move", 0, 1, -0.9);
  await screen.waitForTimeout(300);
  check(value("Hmi.padsFrames") === frames, "a stream not heard to say nothing");

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
