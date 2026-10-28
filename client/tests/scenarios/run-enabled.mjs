// A designer makes a panel enabled only while the line is armed, from its Enabled field. Not
// armed, Design and Run draw it dimmed, and a tap on its button, a key, and a tap on the
// instance inside it run nothing. Armed, all three run. A press or a key held as the panel turns
// off again ends there, so the system never keeps holding it.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  for (const [name, start] of [["Hmi.enArmed", false], ["Hmi.enTaps", 0], ["Hmi.enKeys", ""], ["Hmi.enHits", 0], ["Hmi.enHeld", false]]) hmi.setVariable(name, start);
  const gate = await hmi.addComponent("EnGate");
  await hmi.edit({ kind: "resize_page", page: gate, width: 10, height: 6 });
  await hmi.edit({ kind: "set_event", page: gate, name: "hit", to: "hit" });
  const face = await hmi.addElement(gate, "div", { name: "face", x: "0", y: "0", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(gate, face, "tap", 'emit("hit");');

  const pageId = await hmi.addPage("Enabling");
  const panel = await hmi.addElement(pageId, "div", { name: "Panel", x: "4", y: "4", w: "40", h: "10", background: "#1e2125" });
  const start = await hmi.addElement(pageId, "div", { name: "Start", x: "2", y: "2", w: "10", h: "6", background: "#4a8fd6" }, panel);
  await hmi.setHandler(pageId, start, "tap", "Hmi.enTaps = Hmi.enTaps + 1;");
  await hmi.setHandler(pageId, start, "keydown", 'Hmi.enKeys = Hmi.enKeys + "down,";', { key: "s" });
  await hmi.setHandler(pageId, start, "keyup", 'Hmi.enKeys = Hmi.enKeys + (p.lost ? "lost," : "up,");', { key: "s" });
  const door = await hmi.addElement(pageId, "use", { name: "Door", x: "14", y: "2", w: "10", h: "6" }, panel, "EnGate");
  await hmi.setHandler(pageId, door, "hit", "Hmi.enHits = Hmi.enHits + 1;");
  const jog = await hmi.addElement(pageId, "div", { name: "Jog", x: "26", y: "2", w: "10", h: "6", background: "#3fa66b" }, panel);
  await hmi.setHandler(pageId, jog, "press", "Hmi.enHeld = true;");
  await hmi.setHandler(pageId, jog, "release", "Hmi.enHeld = false;");
  const value = (name) => hmi.state.values[name]?.value;

  await d.openPage("Enabling");
  await d.select("Panel");
  await d.setField("Enabled", "Hmi.enArmed");
  await eventually(() => props(hmi, pageId, panel).enabled === "Hmi.enArmed", "the panel enabled only while armed");
  const opacity = (l) => l.evaluate((e) => getComputedStyle(e).opacity);
  await eventually(async () => (await opacity(d.el(panel))) === "0.4", "Design to draw it dimmed");

  await d.tab("Run");
  const run = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await run(start).count()) === 1, "the page running");
  check((await opacity(run(panel))) === "0.4", "Run draws it whole while not enabled");
  await run(start).click();
  await run(door).click();
  await page.keyboard.press("s");
  await page.waitForTimeout(400);
  check(value("Hmi.enTaps") === 0 && value("Hmi.enHits") === 0 && value("Hmi.enKeys") === "", `taps ${value("Hmi.enTaps")}, hits ${value("Hmi.enHits")} and keys "${value("Hmi.enKeys")}" while not enabled`);

  hmi.set("Hmi.enArmed", true);
  await eventually(async () => (await opacity(run(panel))) === "1", "the panel to draw whole once armed");
  await run(start).click();
  await run(door).click();
  await page.keyboard.press("s");
  await eventually(() => value("Hmi.enTaps") === 1 && value("Hmi.enHits") === 1 && value("Hmi.enKeys") === "down,up,", () => `taps ${value("Hmi.enTaps")}, hits ${value("Hmi.enHits")} and keys "${value("Hmi.enKeys")}" once enabled`);

  // a key and a press held as the panel turns off end there, as a covered page's do
  await page.keyboard.down("s");
  const b = await run(jog).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await eventually(() => value("Hmi.enKeys") === "down,up,down," && value("Hmi.enHeld") === true, "the key and the jog held");
  hmi.set("Hmi.enArmed", false);
  await eventually(() => value("Hmi.enKeys") === "down,up,down,lost," && value("Hmi.enHeld") === false, () => `the key and the jog to end, not "${value("Hmi.enKeys")}" and ${value("Hmi.enHeld")}`);
  await page.keyboard.up("s");
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(value("Hmi.enKeys") === "down,up,down,lost," && value("Hmi.enTaps") === 1, `a let go after ran more: "${value("Hmi.enKeys")}"`);
}
