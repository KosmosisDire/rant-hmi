// A Toggle whose tap flips its two way input and sends change: bound to Running it stops and
// starts the line, bound one way it only shows, and reading the mesh inside is refused.

export default async function ({ page, hmi, d, check, eventually }) {
  const toggle = await hmi.addComponent("Toggle");
  await hmi.edit({ kind: "resize_page", page: toggle, width: 176, height: 88 });
  await hmi.edit({ kind: "set_input", page: toggle, name: "on", input: { name: "on", default: "false", bindable: true } });
  await hmi.edit({ kind: "set_event", page: toggle, name: "change", to: "change" });
  const track = await hmi.addElement(toggle, "div", { name: "Track", x: "0", y: "0", w: "176", h: "88", background: "on ? #2f6f4f : #3a4046", "border-radius": "44" });
  await hmi.addElement(toggle, "div", { name: "Knob", x: "on ? 99 : 11", y: "11", w: "66", h: "66", background: "#e4e6e8", "border-radius": "33" });
  await hmi.setHandler(toggle, track, "tap", 'on = !on;\nemit("change", on);');

  const pageId = await hmi.addPage("Toggles");
  const place = (name, x, on) => hmi.addElement(pageId, "use", { name, x: String(x), y: "44", w: "176", h: "88", on }, null, "Toggle");
  const bound = await place("Line", 44, "Running");
  const shown = await place("Display", 264, "false");
  await hmi.setHandler(pageId, bound, "change", 'notify(p ? "Started" : "Stopped");');

  await d.openPage("Toggles");
  await d.tab("Run");
  await hmi.set("Running", true);
  await eventually(() => hmi.state.values.Running?.value === true, "the line to run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const knobX = async (id) => (await inst(id).locator(".instance .el").nth(1).boundingBox()).x - (await inst(id).boundingBox()).x;
  await eventually(async () => (await knobX(bound)) > 50, "the knob to show the line running");

  await inst(bound).click();
  await eventually(() => hmi.state.values.Running?.value === false, "a tap to stop the line through the binding");
  await page.locator(".notice", { hasText: "Stopped" }).waitFor({ timeout: 4000 });
  await eventually(async () => (await knobX(bound)) < 20, "the knob to follow the line");
  await inst(bound).click();
  await eventually(() => hmi.state.values.Running?.value === true, "a second tap to start it again");
  await page.locator(".notice", { hasText: "Started" }).waitFor({ timeout: 4000 });

  await inst(shown).click();
  await page.waitForTimeout(300);
  check((await knobX(shown)) < 20, "a toggle bound one way moved");
  check(hmi.state.values.Running?.value === true, "a toggle bound one way wrote");

  await hmi.setHandler(toggle, track, "tap", "Speed = 1;");
  await inst(shown).click();
  await page.locator(".notice.fault", { hasText: "Speed names no input" }).waitFor({ timeout: 4000 });
}
