// A designer builds the views that show a reading in the editor alone: a Readout of a number or
// of text, a Lamp for true or false, a Swatch for a colour and a Pose, each laid out in whatever
// box it gets with its look inputs that start at the theme's tokens. A Swatch holds a Readout for
// its words, and a Pose a Readout per number, so they share its look.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Readout", 20, 8);
  await d.sizing("Fill");
  await d.addInput("label", '"Value"');
  await d.addInput("value", "0", { type: "number string enum" });
  await d.addInput("unit", '""');
  await d.addInput("digits", "1");
  await d.addInput("fill", "$panel");
  await d.addInput("labelColour", "$dim");
  await d.addInput("textColour", "$text");
  await d.addInput("textSize", "2.5");
  await d.addInput("radius", "$radius");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius" });
  await d.layOut("Top to bottom", "Center left", "0.2");
  await d.setField("Padding", "1.5");
  await d.add("text", { Name: "caption", w: "hug", h: "hug", Text: "label", Colour: "labelColour", Size: "1.3" });
  await d.select("card");
  await d.add("text", { Name: "reading", w: "hug", h: "hug", Text: '(typeof value === "number" ? value.toFixed(digits) : String(value)) + (unit ? " " + unit : "")', Colour: "textColour", Size: "textSize", Weight: "600" });

  await d.addComponent("Lamp", 12, 3);
  await d.sizing("Fill");
  await d.addInput("value", "true", { type: "bool" });
  await d.addInput("label", '"Lamp"');
  await d.addInput("onColour", "$green");
  await d.addInput("offColour", "$panel3");
  await d.addInput("textColour", "$text");
  await d.addInput("textSize", "1.5");
  await d.add("frame", { Name: "face", x: "0", y: "0", w: "100%", h: "100%", Fill: "", Radius: "" });
  await d.layOut("Left to right", "Center left", "1");
  await d.add("frame", { Name: "light", w: "2", h: "2", Fill: "value ? onColour : offColour", Radius: "$radiusPill" });
  await d.select("face");
  await d.add("text", { Name: "caption", w: "fill", h: "hug", Text: "label", Colour: "textColour", Size: "textSize" });

  // a Rant Color's channels, or colour text as code writes it
  await d.addComponent("Swatch", 20, 8);
  await d.sizing("Fill");
  await d.addInput("value", "{ r: 76, g: 141, b: 255, a: 255 }", { type: "Color string" });
  await d.addInput("label", '"Colour"');
  await d.addInput("fill", "$panel");
  await d.addInput("radius", "$radius");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius" });
  await d.layOut("Left to right", "Center left", "0");
  await d.add("frame", { Name: "chip", w: "4", h: "4", Fill: 'typeof value === "string" ? value : `rgba(${value.r}, ${value.g}, ${value.b}, ${value.a / 255})`', Radius: "$radiusSmall" });
  await page.locator('button[title="Edit the border"]').click();
  await d.set({ Width: "0.1", Colour: "$border2" });
  await page.keyboard.press("Escape");
  // the readout pads its own words, so only the chip keeps off the edge
  await d.css("margin-left: 1.5");
  await d.select("card");
  await d.place("Readout", { w: "fill", h: "fill", label: "label", value: 'typeof value === "string" ? value : "#" + [value.r, value.g, value.b].map((c) => c.toString(16).padStart(2, "0")).join("")', fill: '"transparent"' });

  // a Pose's position in metres and its orientation as roll, pitch and yaw in degrees
  await d.addComponent("Pose", 48, 18);
  await d.sizing("Fill");
  await d.addInput("value", "{ position: vec(0.4, 0, 0.3), orientation: fromEuler(0, 0, 0.5) }", { type: "Pose" });
  await d.addInput("digits", "2");
  await d.addInput("angleDigits", "1");
  await d.addInput("fill", "$panel");
  await d.add("frame", { Name: "rows", x: "0", y: "0", w: "100%", h: "100%", Fill: "", Radius: "" });
  await d.layOut("Top to bottom", undefined, "1");
  await d.add("frame", { Name: "position", w: "fill", h: "fill", Fill: "", Radius: "" });
  await d.layOut("Left to right", undefined, "1");
  await d.place("Readout", { w: "fill", h: "fill", Repeat: "[value.position.x, value.position.y, value.position.z]", label: '["X", "Y", "Z"][index]', value: "item", unit: '"m"', digits: "digits", fill: "fill" });
  await d.select("rows");
  await d.add("frame", { Name: "orientation", w: "fill", h: "fill", Fill: "", Radius: "" });
  await d.layOut("Left to right", undefined, "1");
  await d.place("Readout", { w: "fill", h: "fill", Repeat: "Object.values(value.orientation.euler()).map(degrees)", label: '["Roll", "Pitch", "Yaw"][index]', value: "item", unit: '"°"', digits: "angleDigits", fill: "fill" });

  await d.addPage("Readings");
  const readout = await d.place("Readout", { x: "4", y: "4", w: "20", h: "8", value: "Speed", unit: '"m/s"', digits: "2" });
  const long = await d.place("Readout", { x: "28", y: "4", w: "40", h: "12", label: '"Line speed"', value: "Speed", unit: '"m/s"', digits: "2" });
  const mode = await d.place("Readout", { x: "72", y: "4", w: "20", h: "8", label: '"Mode"', value: "Settings.mode" });
  const lamp = await d.place("Lamp", { x: "4", y: "16", w: "12", h: "3", value: "Running", label: '"Running"' });
  const swatch = await d.place("Swatch", { x: "4", y: "22", w: "20", h: "8", value: "{ r: 255, g: 0, b: 0, a: 255 }" });
  const pose = await d.place("Pose", { x: "28", y: "22", w: "48", h: "18", value: "{ position: vec(Speed, 0.5, 0.25), orientation: fromEuler(0, 0, PI / 2) }" });

  await hmi.set("Speed", 1);
  await hmi.set("Running", true);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const words = (id) => inst(id).locator('.el[data-name="reading"]').allTextContents();
  await eventually(async () => (await words(readout)).join() === "1.00 m/s", "the readout");
  // a bigger readout's card fills its box, its words in the middle of its height
  const [box, card, reading] = [await inst(long).boundingBox(), await inst(long).locator('.el[data-name="card"]').boundingBox(), await inst(long).locator('.el[data-name="reading"]').boundingBox()];
  check(Math.abs(card.width - box.width) < 1 && Math.abs(card.height - box.height) < 1, `the card is ${card.width} by ${card.height} in ${box.width} by ${box.height}`);
  check(reading.y > box.y + box.height * 0.3 && reading.y + reading.height < box.y + box.height * 0.85, "the reading does not sit in the middle of a taller card");
  await eventually(async () => (await words(mode)).join() === "Auto", "the readout of text to read Auto");

  // the lamp lights with the line and goes dark when it stops
  const light = () => inst(lamp).locator('.el[data-name="light"]').evaluate((e) => getComputedStyle(e).backgroundColor);
  await eventually(async () => (await light()) === "rgb(55, 136, 95)", "the lamp lit green");
  await hmi.set("Running", false);
  await eventually(async () => (await light()) === "rgb(40, 40, 40)", "the lamp dark");

  const chip = await inst(swatch).locator('.el[data-name="chip"]').evaluate((e) => getComputedStyle(e).backgroundColor);
  check(chip === "rgb(255, 0, 0)", `the swatch's chip is ${chip}`);
  check((await words(swatch)).join() === "#ff0000", `the swatch reads ${await words(swatch)}`);

  // three numbers a row, the yaw a quarter turn
  const want = ["1.00 m", "0.50 m", "0.25 m", "0.0 °", "0.0 °", "90.0 °"].join();
  await eventually(async () => (await words(pose)).join() === want, `the pose to read ${want}`);
  const cells = await inst(pose).locator('.el[data-name="card"]').evaluateAll((es) => es.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width)]));
  check(cells.length === 6 && cells[0][1] === cells[2][1] && cells[3][1] > cells[0][1] && cells[0][2] === cells[1][2] && cells[3][0] === cells[0][0], `the pose's readouts sit at ${JSON.stringify(cells)}, not three in each of two rows`);
}
