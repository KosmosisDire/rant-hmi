// What a page draws reads the keys held and the gamepads there, as `keys` and `gamepads`: a key
// by what it types or where it sits while held, never one typed into a field, and each pad's
// buttons and sticks as they are, gone with the pad.

function fakePads() {
  const pads = [null, null, null, null];
  window.__pads = {
    connect: (i) => (pads[i] = { index: i, id: "Fake pad", connected: true, mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) }),
    disconnect: (i) => (pads[i] = null),
    press: (i, b) => (pads[i].buttons[b] = { pressed: true, touched: true, value: 1 }),
    move: (i, axis, value) => (pads[i].axes[axis] = value),
  };
  navigator.getGamepads = () => [...pads];
}

export default async function ({ page, hmi, sys, check, eventually }) {
  const pageId = await hmi.addPage("Held");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "60", h: "4", color: "#e4e6e8", text: '[keys.Space ? "space" : "-", keys.a && keys.KeyA ? "a" : "-", keys.A && keys.KeyA ? "A" : "-"].join(" ")' });
  const pad = await hmi.addElement(pageId, "span", { name: "Pad", x: "4", y: "10", w: "60", h: "4", color: "#e4e6e8", text: 'gamepads[0] ? `${gamepads[0].buttons.south} ${gamepads[0].lx} ${gamepads[0].ly} ${gamepads[0].name}` : "none"' });
  await hmi.addElement(pageId, "input", { name: "Note", x: "4", y: "16", w: "16", h: "4" });

  const context = await page.context().browser().newContext();
  await context.addInitScript(fakePads);
  const screen = await context.newPage();
  await screen.goto(sys.url);
  await screen.locator(".tab", { hasText: "Design" }).click();
  await screen.locator(".screen:not([hidden]) .page-row", { hasText: /^Held/ }).click();
  await screen.locator(".tab", { hasText: "Run" }).click();
  const text = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`).textContent();
  const reads = async (id, want) => {
    let now;
    await eventually(async () => (now = await text(id)) === want, () => `the page to read "${want}", not "${now}"`);
  };

  await reads(shown, "- - -");
  await screen.keyboard.down("Space");
  await reads(shown, "space - -");
  await screen.keyboard.down("a");
  await reads(shown, "space a -");
  await screen.keyboard.up("Space");
  await screen.keyboard.up("a");
  await reads(shown, "- - -");
  // held with Shift, a types A, and still sits at KeyA
  await screen.keyboard.down("Shift");
  await screen.keyboard.down("A");
  await reads(shown, "- - A");
  await screen.keyboard.up("Shift");
  await screen.keyboard.up("A");
  await reads(shown, "- - -");
  await screen.locator(`.run-layer:not([hidden]) .el[data-id] input`).click();
  await screen.keyboard.down("Space");
  await screen.waitForTimeout(200);
  check((await text(shown)) === "- - -", "a key typed into a field held by none");
  await screen.keyboard.up("Space");

  await reads(pad, "none");
  await screen.evaluate(() => window.__pads.connect(0));
  await reads(pad, "false 0 0 Fake pad");
  await screen.evaluate(() => {
    window.__pads.press(0, 0);
    window.__pads.move(0, 0, 0.5);
    window.__pads.move(0, 1, -0.25);
  });
  await reads(pad, "true 0.5 0.25 Fake pad");
  await screen.evaluate(() => window.__pads.disconnect(0));
  await reads(pad, "none");
}
