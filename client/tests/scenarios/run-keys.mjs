// An operator's keys on a running page: a keydown for A heard only while armed, its keyup however
// the key ends, and a keyrepeat for R on its beat. Keys typed in a field go to the field, and a
// covered page hears none. A component's part hears keys too, and sends them on. An Escape a
// handler names stays the handler's, never closing the page over. A key held ends lost when its keydown's while turns false, the window
// loses focus, a page opens over it, or Run hides.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const [name, start] of [["keysArmed", false], ["keysDown", 0], ["keysEnds", ""], ["keysBeats", 0], ["keysNote", ""], ["keysLit", ""], ["keysEscapes", 0]]) {
    hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  }
  const pageId = await hmi.addPage("Keys");
  const jog = await hmi.addElement(pageId, "div", { name: "Jog", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  await hmi.addElement(pageId, "input", { name: "Note", value: "keysNote", x: "16", y: "4", w: "16", h: "4" });
  await hmi.setHandler(pageId, jog, "keydown", "keysDown = keysDown + 1;", { key: "a", while: "keysArmed" });
  await hmi.setHandler(pageId, jog, "keyup", 'keysEnds = keysEnds + (p.lost ? "lost " : "up ") + p.key + ",";', { key: "a" });
  await hmi.setHandler(pageId, jog, "keyrepeat", "keysBeats = keysBeats + 1;", { key: "r", every: "100" });
  const lamp = await hmi.addComponent("KeyLamp");
  await hmi.edit({ kind: "set_event", page: lamp, name: "lit", to: "lit" });
  const bulb = await hmi.addElement(lamp, "div", { name: "bulb", x: "0", y: "0", w: "10", h: "6", background: "#cf9a3a" });
  await hmi.setHandler(lamp, bulb, "keydown", 'emit("lit", p.key);', { key: "k" });
  const lit = await hmi.addElement(pageId, "use", { name: "Lamp", x: "4", y: "12", w: "10", h: "6" }, null, "KeyLamp");
  await hmi.setHandler(pageId, lit, "lit", "keysLit = keysLit + p;");
  const cover = await hmi.addPage("Keys Cover");
  await hmi.edit({ kind: "set_shows", page: cover, shows: "over" });
  const shade = await hmi.addElement(cover, "div", { name: "Shade", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(cover, shade, "keydown", "keysEscapes = keysEscapes + 1;", { key: "Escape" });
  const opener = await hmi.addElement(pageId, "div", { name: "Opener", x: "34", y: "4", w: "10", h: "6", background: "#4a8fd6" });
  await hmi.setHandler(pageId, opener, "tap", "open(Pages.KeysCover);");
  const value = (name) => hmi.state.values[name]?.value;

  await d.openPage("Keys");
  await d.tab("Run");
  await eventually(async () => (await page.locator(`.run-layer:not([hidden]) .el[data-id="${jog}"]`).count()) === 1, "the page running");

  // not armed, the keydown is not heard, and its keyup runs still, as an end always does
  await page.keyboard.press("a");
  await eventually(() => value("keysEnds") === "up a,", () => `the keyup to run, not "${value("keysEnds")}"`);
  check(value("keysDown") === 0, "the keydown to wait for arming");
  hmi.set("keysArmed", true);
  await eventually(() => value("keysArmed") === true, "the line armed");
  await page.keyboard.press("a");
  await eventually(() => value("keysDown") === 1 && value("keysEnds") === "up a,up a,", () => `a keydown and a keyup, not ${value("keysDown")} "${value("keysEnds")}"`);

  // disarmed while held, the key ends there, and letting it go after does nothing more
  await page.keyboard.down("a");
  await eventually(() => value("keysDown") === 2, "the second keydown");
  hmi.set("keysArmed", false);
  await eventually(() => value("keysEnds").endsWith("lost a,"), () => `the key to end as disarmed, not "${value("keysEnds")}"`);
  await page.keyboard.up("a");
  hmi.set("keysArmed", true);
  await eventually(() => value("keysArmed") === true, "the line armed again");

  // the window losing focus ends what is held
  await page.keyboard.down("a");
  await eventually(() => value("keysDown") === 3, "the third keydown");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await eventually(() => value("keysEnds").split(",").length === 5, () => `the key to end on blur, not "${value("keysEnds")}"`);
  await page.keyboard.up("a");

  // a repeat runs at once, then every 100 ms until the key ends
  await page.keyboard.down("r");
  await page.waitForTimeout(350);
  await page.keyboard.up("r");
  const beats = value("keysBeats");
  await page.waitForTimeout(250);
  check(beats >= 3 && beats <= 5 && value("keysBeats") === beats, `4 beats or so, then none, not ${beats} then ${value("keysBeats")}`);

  await page.keyboard.press("k");
  await eventually(() => value("keysLit") === "k", () => `the lamp's part to send its key, not "${value("keysLit")}"`);

  // typed in a field, a key is the field's
  await page.locator(".run-layer:not([hidden]) input").click();
  await page.keyboard.type("aaa");
  await page.waitForTimeout(250);
  check(value("keysDown") === 3, `keys typed in a field to stay there, not ${value("keysDown")} keydowns`);
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${jog}"]`).click();

  // a page opened over it ends what is held, and while covered it hears nothing
  await page.keyboard.down("a");
  await eventually(() => value("keysDown") === 4, "the fourth keydown");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${opener}"]`).click();
  await eventually(() => value("keysEnds").split(",").length === 6, () => `the key to end as a page covered it, not "${value("keysEnds")}"`);
  await page.keyboard.up("a");
  check((await page.locator(".run-layer[inert]").count()) === 1, "the covered page to be inert");
  await page.keyboard.press("a");
  await page.waitForTimeout(250);
  check(value("keysDown") === 4, "a covered page to hear no key");
  await page.keyboard.press("Escape");
  await eventually(() => value("keysEscapes") === 1, "the Escape handler to run");
  check((await page.locator(".run-layer[inert]").count()) === 1, "an Escape a handler names to leave the page over open");
  await page.locator(".run-backdrop").click({ position: { x: 5, y: 5 } });
  await eventually(async () => (await page.locator(".run-layer[inert]").count()) === 0, "the cover to close");

  // Run hidden behind another tab ends what is held
  await page.keyboard.down("a");
  await eventually(() => value("keysDown") === 5, "the fifth keydown");
  await d.tab("Design");
  await eventually(() => value("keysEnds").split(",").length === 7, () => `the key to end as Run hid, not "${value("keysEnds")}"`);
  check(value("keysEnds") === "up a,up a,lost a,lost a,lost a,lost a,", `the ends ${value("keysEnds")}`);
  await page.keyboard.up("a");
}
