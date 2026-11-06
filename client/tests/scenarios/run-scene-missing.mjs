// An operator sees a scene while a sensor node is off the mesh: a part whose colour reads the
// sensor draws as a faint grey ghost, one whose pose reads it draws nothing, the rest draw as
// ever, and the scene is not marked unknown as a whole. Each draws as itself once it reads.

export default async function ({ page, hmi, d, check, eventually }) {
  if (!hmi.object("Sensor")) await hmi.addObject("Sensor", "Nowhere");
  if (!hmi.state.imports.some((i) => i.alias === "Sensor.Present")) {
    hmi.send({ type: "import", object: "Sensor", import: { alias: "Present", entity: "Present", kind: "variable", intent: "read" } });
    await hmi.next((m) => m.type === "objects" && hmi.state.imports.some((i) => i.alias === "Sensor.Present"));
  }
  const pageId = await hmi.addPage("Scene missing");
  // seen from above
  const scene = await hmi.addElement(pageId, "scene", { name: "cell", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "4" });
  const box = (name, x, props) => hmi.addElement(pageId, "box", { name, size: "vec(0.6, 0.6, 0.6)", pose: `{ position: vec(${x}, 0, 0) }`, ...props }, scene);
  await box("known", 0, { color: '"#ff0000"' });
  const ghost = await box("ghost", -1, { color: 'Sensor.Present ? "#00ff00" : "#00ff00"' });
  const hidden = await box("hidden", 1, { color: '"#0000ff"', pose: "{ position: vec(1, 0, Sensor.Present ? 0 : 0) }" });

  await d.openPage("Scene missing");
  await d.tab("Run");
  const el = page.locator(`.run-layer:not([hidden]) .el[data-id="${scene}"]`);
  await d.shows(el, 0.5, 0.5, ([r, g, b]) => r > 120 && g < 60 && b < 60, "the known box drawn red in the middle");
  check(!(await el.evaluate((e) => e.classList.contains("unknown"))), "the whole scene shows the unknown look");
  const [br, bg, bb] = await d.colour(el, 0.02, 0.02);
  const tests = {
    green: "g > 120 && r < 80 && b < 80",
    blue: "b > 120 && r < 80 && g < 80",
    grey: `Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && Math.abs(r - ${br}) + Math.abs(g - ${bg}) + Math.abs(b - ${bb}) > 24`,
  };
  await eventually(async () => (await d.count(el, tests)).grey > 200, "the ghost drawn grey");
  const seen = await d.count(el, tests);
  check(seen.green === 0 && seen.blue === 0, `the ghost or the hidden box drew in its own colour: ${JSON.stringify(seen)}`);

  // known again, each draws as itself, the ghost no longer grey
  await hmi.setProps(pageId, ghost, { color: '"#00ff00"' });
  await hmi.setProps(pageId, hidden, { pose: "{ position: vec(1, 0, 0) }" });
  await eventually(async () => {
    const now = await d.count(el, tests);
    return now.green > 200 && now.blue > 200 && now.grey < 50;
  }, "the ghost and the hidden box to draw in their colours once known");
}
