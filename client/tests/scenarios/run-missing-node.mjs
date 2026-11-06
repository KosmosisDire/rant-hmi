// An operator sees a line whose sensor node is off the mesh: what reads the sensor bare shows
// the unknown look, what reads it with `??` shows its fallback, a tap that reads it with `??`
// or calls it with `?.()` still sets the line's speed, and a bare call stops its tap.

export default async function ({ page, hmi, sys, d, check, eventually }) {
  if (!hmi.object("Sensor")) await hmi.addObject("Sensor", "Nowhere");
  for (const [alias, kind, intent] of [["Present", "variable", "read"], ["Reset", "function", "write"]]) {
    if (hmi.state.imports.some((i) => i.alias === `Sensor.${alias}`)) continue;
    hmi.send({ type: "import", object: "Sensor", import: { alias, entity: alias, kind, intent } });
    await hmi.next((m) => m.type === "objects" && hmi.state.imports.some((i) => i.alias === `Sensor.${alias}`));
  }
  const pageId = await hmi.addPage("Missing sensor");
  const span = (name, y, text) => hmi.addElement(pageId, "span", { name, x: "4", y: String(y), w: "40", h: "4", text, color: "#e4e6e8" });
  const bare = await span("Bare", 4, "Sensor.Present ? 'part' : 'empty'");
  const given = await span("Given", 10, "(Sensor.Present ?? false) ? 'part' : 'empty'");
  const button = async (name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: String(x), y: "16", w: "16", h: "8", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const read = await button("Read", 4, "Line.Speed = (Sensor.Present ?? false) ? 1 : 2.5;");
  const skip = await button("Skip", 24, "await Sensor.Reset?.();\nLine.Speed = 3.5;");
  const call = await button("Call", 44, "await Sensor.Reset();\nLine.Speed = 9;");

  await d.openPage("Missing sensor");
  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await el(given).getByText("empty").waitFor();
  check(await el(bare).evaluate((e) => e.classList.contains("unknown")), "the bare read does not show the unknown look");
  check(!(await el(given).evaluate((e) => e.classList.contains("unknown"))), "the read with ?? shows the unknown look");

  const speed = () => hmi.state.values["Line.Speed"]?.value;
  await hmi.set("Line.Speed", 1);
  await eventually(() => speed() === 1, "the speed to start at 1");
  await el(read).click();
  await eventually(() => speed() === 2.5, "the tap to set the speed though the sensor is missing");
  await el(skip).click();
  await eventually(() => speed() === 3.5, "the tap to skip the call and set the speed");

  const stopped = async () => (await (await fetch(`${sys.url}/problems`)).json()).some((p) => p.level === "warn" && p.text.includes("stopped, since Sensor.Reset is unknown"));
  await el(call).click();
  await eventually(stopped, "the bare call to stop its tap as unknown");
  check(speed() === 3.5, `the bare call's tap set the speed to ${speed()}`);
}
