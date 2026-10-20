// A designer builds a Gauge, a Knob and a Readout in the editor alone, each drawn from
// expressions: a gauge's arc is a circle's dash, a knob turns by the angle a drag makes around
// it. Bound to Speed, the gauge and readout show it and turning the knob sets it.

export default async function ({ page, hmi, d, check, eventually }) {
  const arc = (r, colour, width) => ({ "Centre x": "88", "Centre y": "88", Radius: String(r), Fill: '"none"', Stroke: colour, Thickness: String(width), Ends: '"round"', Transform: '"rotate(135 88 88)"' });

  await d.addComponent("Gauge", 176, 176);
  await d.addInput("value", "0");
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addInput("unit", '""');
  await d.add("drawing", { Name: "dial", x: "0", y: "0", w: "176", h: "176" });
  await d.addShape("circle", { Name: "track", ...arc(70, "#3a4046", 12) });
  await d.css('pathlength: 100\nstroke-dasharray: "75 100"');
  await d.addShape("circle", { Name: "level", ...arc(70, 'value > max * 0.8 ? "#c62828" : "#4a8fd6"', 12) });
  await d.css('pathlength: 100\nstroke-dasharray: `${Math.min(Math.max((value - min) / (max - min), 0), 1) * 75} 100`');
  await d.addShape("text", { Name: "reading", Text: "value.toFixed(1)", x: "88", y: "92", Size: "30", Fill: "#e4e6e8" });
  await d.addShape("text", { Name: "units", Text: "unit", x: "88", y: "126", Size: "14", Fill: "#9aa0a6" });

  await d.addComponent("Knob", 132, 132);
  await d.addInput("value", "0", true);
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addSends("change");
  await d.add("drawing", { Name: "dial", x: "0", y: "0", w: "132", h: "132" });
  await d.handler("drag", "const k = Math.min(Math.max((p.angle + 135) / 270, 0), 1);\nvalue = min + k * (max - min);\nemit(\"change\", value);");
  const ring = { "Centre x": "66", "Centre y": "66", Radius: "58", Fill: '"none"', Thickness: "6", Ends: '"round"', Transform: '"rotate(135 66 66)"' };
  await d.addShape("circle", { Name: "track", ...ring, Stroke: "#3a4046" });
  await d.css('pathlength: 100\nstroke-dasharray: "75 100"');
  await d.addShape("circle", { Name: "level", ...ring, Stroke: "#4a8fd6" });
  await d.css('pathlength: 100\nstroke-dasharray: `${(value - min) / (max - min) * 75} 100`');
  await d.addShape("circle", { Name: "face", "Centre x": "66", "Centre y": "66", Radius: "46", Fill: 'root.pressed ? "#2f3540" : "#2a2f35"', Stroke: "#3a4046", Thickness: "2" });
  await d.addShape("line", { Name: "pointer", "From x": "66", "From y": "50", "To x": "66", "To y": "28", Stroke: "#e4e6e8", Thickness: "5", Transform: "`rotate(${-135 + (value - min) / (max - min) * 270} 66 66)`" });

  await d.addComponent("Readout", 220, 88);
  await d.addInput("label", '"Speed"');
  await d.addInput("value", "0");
  await d.addInput("unit", '""');
  await d.addInput("digits", "1");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "220", h: "88", Fill: "#1e2125", Radius: "8" });
  await d.add("text", { Name: "caption", x: "16", y: "10", w: "188", h: "22", Text: "label", Colour: "#9aa0a6", Size: "14" });
  await d.select("card");
  await d.add("text", { Name: "reading", x: "16", y: "34", w: "188", h: "44", Text: 'value.toFixed(digits) + " " + unit', Colour: "#e4e6e8", Size: "28", Weight: "600" });

  await d.addPage("Dials");
  const gauge = await d.place("Gauge", { x: "44", y: "44", w: "176", h: "176", value: "Speed", max: "2", unit: '"m/s"' });
  const knob = await d.place("Knob", { x: "264", y: "66", w: "132", h: "132", value: "Speed", max: "2" });
  const readout = await d.place("Readout", { x: "440", y: "88", w: "220", h: "88", value: "Speed", unit: '"m/s"', digits: "2" });

  await hmi.set("Speed", 1);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await inst(gauge).locator("text").first().textContent()) === "1.0", "the gauge to read 1.0");
  const dash = await inst(gauge).locator('[data-name="level"]').getAttribute("stroke-dasharray");
  check(dash === "37.5 100", `the gauge's arc is ${dash}`);
  await eventually(async () => (await inst(readout).locator('.el[data-name="reading"]').textContent()) === "1.00 m/s", "the readout");

  // a drag around the knob to its right turns it to a little past the middle
  const b = await inst(knob).boundingBox();
  const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(cx - 40, cy + 30);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 50, { steps: 5 });
  await page.mouse.move(cx + 50, cy, { steps: 5 });
  await page.mouse.up();
  // straight right is 90 degrees, so (90 + 135) / 270 of the way to 2
  await eventually(() => Math.abs((hmi.state.values.Speed?.value ?? 0) - (225 / 270) * 2) < 0.02, "the knob to set Speed");
  await eventually(async () => (await inst(gauge).locator("text").first().textContent()) === "1.7", "the gauge to follow the knob");
}
