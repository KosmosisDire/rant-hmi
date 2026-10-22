// A designer builds a Gauge and a Knob in the editor alone, each drawn from expressions: a
// gauge's arc is a circle's dash, a knob turns by the angle a drag makes around it. Their
// colours are inputs that start at the theme's tokens, and both keep their round shape. Bound
// to Speed, the gauge shows it and turning the knob sets it.

export default async function ({ page, hmi, d, check, eventually }) {
  const arc = (r, colour, width) => ({ "Centre x": "8", "Centre y": "8", Radius: String(r), Fill: '"none"', Stroke: colour, Thickness: String(width), Ends: '"round"', Transform: '"rotate(135 8 8)"' });

  await d.addComponent("Gauge", 16, 16);
  await d.addInput("value", "0");
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addInput("unit", '""');
  await d.addInput("digits", "1");
  // the share of its range past which the level shows the alarm colour
  await d.addInput("alarm", "0.8");
  await d.addInput("colour", "$accent");
  await d.addInput("alarmColour", "$red");
  await d.addInput("trackColour", "$panel3");
  await d.addInput("textColour", "$text");
  await d.add("diagram", { Name: "dial", x: "0", y: "0", w: "16", h: "16" });
  await d.addShape("circle", { Name: "track", ...arc(6.4, "trackColour", 1.1) });
  await d.css('pathlength: 100\nstroke-dasharray: "75 100"');
  await d.addShape("circle", { Name: "level", ...arc(6.4, "(value - min) / (max - min) > alarm ? alarmColour : colour", 1.1) });
  await d.css('pathlength: 100\nstroke-dasharray: `${Math.min(Math.max((value - min) / (max - min), 0), 1) * 75} 100`');
  await d.addShape("text", { Name: "reading", Text: "value.toFixed(digits)", x: "8", y: "8.4", Size: "2.7", Fill: "textColour" });
  await d.addShape("text", { Name: "units", Text: "unit", x: "8", y: "11.5", Size: "1.3", Fill: "$dim" });

  await d.addComponent("Knob", 12, 12);
  await d.addInput("value", "0", true);
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addInput("colour", "$accent");
  await d.addInput("trackColour", "$panel3");
  await d.addInput("face", "$panel2");
  await d.addInput("pointerColour", "$text");
  await d.addSends("change");
  await d.add("diagram", { Name: "dial", x: "0", y: "0", w: "12", h: "12" });
  await d.handler("drag", "const k = Math.min(Math.max((p.angle + 135) / 270, 0), 1);\nvalue = min + k * (max - min);\nemit(\"change\", value);");
  const ring = { "Centre x": "6", "Centre y": "6", Radius: "5.3", Fill: '"none"', Thickness: "0.5", Ends: '"round"', Transform: '"rotate(135 6 6)"' };
  await d.addShape("circle", { Name: "track", ...ring, Stroke: "trackColour" });
  await d.css('pathlength: 100\nstroke-dasharray: "75 100"');
  await d.addShape("circle", { Name: "level", ...ring, Stroke: "colour" });
  await d.css('pathlength: 100\nstroke-dasharray: `${(value - min) / (max - min) * 75} 100`');
  await d.addShape("circle", { Name: "face", "Centre x": "6", "Centre y": "6", Radius: "4.2", Fill: "root.pressed ? face.lighten(0.06) : face", Stroke: "$border2", Thickness: "0.2" });
  await d.addShape("line", { Name: "pointer", "From x": "6", "From y": "4.5", "To x": "6", "To y": "2.5", Stroke: "pointerColour", Thickness: "0.5", Transform: "`rotate(${-135 + (value - min) / (max - min) * 270} 6 6)`" });

  await d.addPage("Dials");
  const gauge = await d.place("Gauge", { x: "4", y: "4", w: "16", h: "16", value: "Speed", max: "2", unit: '"m/s"' });
  const knob = await d.place("Knob", { x: "24", y: "6", w: "12", h: "12", value: "Speed", max: "2" });

  await hmi.set("Speed", 1);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await inst(gauge).locator("text").first().textContent()) === "1.0", "the gauge to read 1.0");
  const dash = await inst(gauge).locator('[data-name="level"]').getAttribute("stroke-dasharray");
  check(dash === "37.5 100", `the gauge's arc is ${dash}`);

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
  // past its alarm share the gauge's level turns red
  const level = () => inst(gauge).locator('[data-name="level"]').evaluate((e) => getComputedStyle(e).stroke);
  check((await level()) === "rgb(210, 87, 75)", `the level past its alarm is ${await level()}`);
}
