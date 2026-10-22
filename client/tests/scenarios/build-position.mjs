// A designer builds a Position in the editor alone: a plane between two corners, y up as a
// physical frame is, with a marker per 2D point or pose of a list or of one value, a pose's
// heading drawn from it, and the reading under it. It lays itself out in whatever box it gets,
// its look inputs that start at the theme's tokens.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Position", 24, 26);
  await d.sizing("Fill");
  await d.addInput("value", "{ position: vec(0.3, 0.2), angle: 0.6 }");
  await d.addInput("min", "vec(-1, -1)");
  await d.addInput("max", "vec(1, 1)");
  await d.addInput("digits", "2");
  await d.addInput("colour", "$accent");
  await d.addInput("gridColour", "$border2");
  await d.addInput("textColour", "$text");
  await d.addInput("fill", "$panel");
  await d.addInput("radius", "$radius");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius" });
  await d.layOut("Top to bottom", undefined, "0.8");
  await d.setField("Padding", "1.5");
  // the view box turned over, so y counts up
  await d.add("diagram", { Name: "plane", w: "fill", h: "fill", "View box": "`${min.x} ${-max.y} ${max.x - min.x} ${max.y - min.y}`" });
  const thin = 'vector-effect: "non-scaling-stroke"';
  await d.addShape("rect", { Name: "area", x: "min.x", y: "-max.y", Width: "max.x - min.x", Height: "max.y - min.y", Fill: '"none"', Stroke: "gridColour", Thickness: "1" });
  await d.css(thin);
  await d.select("plane");
  await d.addShape("line", { Name: "xAxis", "From x": "min.x", "From y": "0", "To x": "max.x", "To y": "0", Stroke: "gridColour", Thickness: "1" });
  await d.css(thin);
  await d.select("plane");
  await d.addShape("line", { Name: "yAxis", "From x": "0", "From y": "-max.y", "To x": "0", "To y": "-min.y", Stroke: "gridColour", Thickness: "1" });
  await d.css(thin);
  await d.select("plane");
  // a pose's angle turns from +x toward +y, the other way round on the turned over view
  await d.addShape("g", { Name: "marker", Repeat: "Array.isArray(value) ? value : [value]", Transform: "`translate(${(item.position ?? item).x} ${-(item.position ?? item).y}) rotate(${-degrees(item.angle ?? 0)})`" });
  await d.addShape("line", { Name: "heading", "From x": "0", "From y": "0", "To x": "item.angle === undefined ? 0 : (max.x - min.x) * 0.1", "To y": "0", Stroke: "colour", Thickness: "2" });
  await d.css(thin);
  await d.select("marker");
  await d.addShape("circle", { Name: "dot", "Centre x": "0", "Centre y": "0", Radius: "(max.x - min.x) * 0.025", Fill: "colour" });
  await d.select("card");
  await d.add("text", {
    Name: "reading",
    w: "fill",
    h: "hug",
    Text: 'Array.isArray(value) ? value.length + " points" : "x " + (value.position ?? value).x.toFixed(digits) + ", y " + (value.position ?? value).y.toFixed(digits) + (value.angle === undefined ? "" : ", " + degrees(value.angle).toFixed(0) + "°")',
    Colour: "textColour",
    Size: "1.3",
  });

  await d.addPage("Plane");
  const one = await d.place("Position", { x: "4", y: "4", w: "24", h: "26", value: "{ position: vec(Speed - 0.5, 0.5), angle: PI / 2 }" });
  const many = await d.place("Position", { x: "32", y: "4", w: "24", h: "26", value: "[vec(-0.5, -0.5), vec(0.5, 0.5)]" });

  await hmi.set("Speed", 1);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  // each dot's middle as shares of the plane drawn, from its top left
  const dots = (id) =>
    inst(id).evaluate((el) => {
      const area = el.querySelector('[data-name="area"]').getBoundingClientRect();
      return [...el.querySelectorAll('[data-name="dot"]')].map((d) => d.getBoundingClientRect()).map((d) => [(d.x + d.width / 2 - area.x) / area.width, (d.y + d.height / 2 - area.y) / area.height].map((v) => Math.round(v * 100) / 100));
    });
  const near = (got, want) => got.length === want.length && got.every((g, i) => g.every((v, j) => Math.abs(v - want[i][j]) <= 0.01));
  await eventually(async () => near(await dots(one), [[0.75, 0.25]]), "the marker up and right of the middle at (0.5, 0.5)");
  // a quarter turn heads up the plane
  const [dot, heading] = [await inst(one).locator('[data-name="dot"]').boundingBox(), await inst(one).locator('[data-name="heading"]').boundingBox()];
  check(heading.y + heading.height <= dot.y + dot.height / 2 + 2 && heading.height > dot.height && heading.width < dot.width, `the heading is ${JSON.stringify(heading)} from the dot ${JSON.stringify(dot)}, not straight up`);
  const words = (id) => inst(id).locator('.el[data-name="reading"]').textContent();
  check((await words(one)) === "x 0.50, y 0.50, 90°", `the reading is ${await words(one)}`);

  // a list puts a marker per point in one plane, and a point without a heading draws none
  check(near(await dots(many), [[0.25, 0.75], [0.75, 0.25]]), `the markers sit at ${JSON.stringify(await dots(many))}`);
  const headings = await inst(many).locator('[data-name="heading"]').evaluateAll((es) => es.map((e) => e.getBoundingClientRect().width));
  check(headings.every((w) => w < 1), `points without a heading draw headings ${headings}`);
  check((await words(many)) === "2 points", `the list reads ${await words(many)}`);
}
