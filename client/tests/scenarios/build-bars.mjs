// A designer builds the views of numbers between limits in the editor alone: a Bar that fills
// from zero toward its value, Bars that holds a Bar per number of a list with its label and
// reading, and Joints that holds Bars of a JointState's angles in degrees, each named by its
// JointNames or its place. Each lays itself out in whatever box it gets, its look inputs that
// start at the theme's tokens.

export default async function ({ page, hmi, d, check, eventually }) {
  // zero's place and the value's, each as a share of the track
  const zero = "clamp(-min / (max - min), 0, 1)";
  const at = "clamp((value - min) / (max - min), 0, 1)";
  await d.addComponent("Bar", 24, 2);
  await d.sizing("Fill");
  await d.addInput("value", "0.6", { type: "number" });
  await d.addInput("min", "0");
  await d.addInput("max", "1");
  await d.addInput("colour", "$accent");
  await d.addInput("trackColour", "$panel3");
  await d.addInput("radius", "$radiusPill");
  await d.add("frame", { Name: "track", x: "0", y: "0", w: "100%", h: "100%", Fill: "trackColour", Radius: "radius" });
  await d.add("frame", { Name: "level", x: `Math.min(${zero}, ${at}) * 100%`, y: "0", w: `Math.abs(${at} - ${zero}) * 100%`, h: "100%", Fill: "colour", Radius: "radius" });

  await d.addComponent("Bars", 36, 12);
  await d.sizing("Fill");
  await d.addInput("values", "[0.3, 0.7, 0.5]", { type: "number[]" });
  await d.addInput("labels", "[]");
  await d.addInput("min", "0");
  await d.addInput("max", "1");
  await d.addInput("unit", '""');
  await d.addInput("digits", "2");
  await d.addInput("colour", "$accent");
  await d.addInput("trackColour", "$panel3");
  await d.addInput("labelColour", "$dim");
  await d.addInput("textColour", "$text");
  await d.addInput("textSize", "1.4");
  await d.addInput("fill", "$panel");
  await d.addInput("radius", "$radius");
  await d.add("frame", { Name: "card", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "radius" });
  await d.layOut("Top to bottom", undefined, "0");
  await d.setField("Padding", "1.5");
  await d.add("frame", { Name: "row", w: "fill", h: "fill", Fill: "", Radius: "" });
  await d.setField("Repeat", "values");
  await d.layOut("Left to right", "Center left", "1");
  await d.add("text", { Name: "label", w: "8", h: "hug", Text: "labels[index] ?? String(index + 1)", Colour: "labelColour", Size: "textSize" });
  await d.select("row");
  await d.place("Bar", { w: "fill", h: "1", value: "item", min: "min", max: "max", colour: "colour", trackColour: "trackColour" });
  await d.select("row");
  await d.add("text", { Name: "reading", w: "7", h: "hug", Text: 'item.toFixed(digits) + (unit ? " " + unit : "")', Colour: "textColour", Size: "textSize", Align: '"right"' });

  await d.addComponent("Joints", 36, 18);
  await d.sizing("Fill");
  await d.addInput("state", "{ position: [0, 0.6, -0.4, 1.2, 0, -0.8], velocity: [], effort: [] }", { type: "JointState" });
  await d.addInput("names", "[]");
  await d.addInput("min", "-180");
  await d.addInput("max", "180");
  await d.addInput("digits", "1");
  await d.addInput("colour", "$accent");
  await d.addInput("fill", "$panel");
  await d.place("Bars", {
    x: "0",
    y: "0",
    w: "100%",
    h: "100%",
    values: "state.position.map(degrees)",
    labels: 'names.length ? names : state.position.map((_, i) => "Joint " + (i + 1))',
    min: "min",
    max: "max",
    unit: '"°"',
    digits: "digits",
    colour: "colour",
    fill: "fill",
  });

  await d.addPage("Levels");
  const bar = await d.place("Bar", { x: "4", y: "4", w: "24", h: "2", value: "Line.Speed", max: "2" });
  const signed = await d.place("Bar", { x: "4", y: "8", w: "24", h: "2", value: "Line.Speed - 1.5", min: "-1", max: "1" });
  const bars = await d.place("Bars", { x: "32", y: "4", w: "36", h: "12", values: "[0.25, Line.Speed / 2, 1]", labels: '["A", "B", "C"]' });
  const joints = await d.place("Joints", { x: "4", y: "20", w: "40", h: "20", state: "Robot.Joints" });

  await hmi.set("Line.Speed", 1);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  // where each bar's level sits along its track in an instance, as shares of it
  const level = (id) =>
    inst(id)
      .locator('[data-name="track"]')
      .evaluateAll((es) =>
        es.map((e) => {
          const [t, l] = [e.getBoundingClientRect(), e.querySelector('[data-name="level"]').getBoundingClientRect()];
          return [(l.x - t.x) / t.width, l.width / t.width].map((v) => Math.round(v * 100) / 100);
        }),
      );
  const near = (got, want) => got.length === want.length && got.every((g, i) => g.every((v, j) => Math.abs(v - want[i][j]) <= 0.01));
  await eventually(async () => near(await level(bar), [[0, 0.5]]), "the bar half full at Speed 1 of 2");
  // from zero in the middle back to -0.5, a quarter of the track left of the middle
  await eventually(async () => near(await level(signed), [[0.25, 0.25]]), "the signed bar to grow left from the middle");

  const words = (id, name) => inst(id).locator(`.el[data-name="${name}"]`).allTextContents();
  await eventually(async () => (await words(bars, "reading")).join() === "0.25,0.50,1.00", "the bars' readings");
  check((await words(bars, "label")).join() === "A,B,C", `the bars are labelled ${await words(bars, "label")}`);
  const filled = await level(bars);
  check(near(filled, [[0, 0.25], [0, 0.5], [0, 1]]), `the bars fill ${JSON.stringify(filled)}`);

  // a joint a row, named by its place, its angle in degrees as the robot moves
  await eventually(async () => (await words(joints, "label")).join() === "Joint 1,Joint 2,Joint 3,Joint 4,Joint 5,Joint 6", "a row a joint");
  const angles = (await words(joints, "reading")).map((w) => [w.endsWith(" °"), parseFloat(w)]);
  check(angles.every(([unit, a]) => unit && Math.abs(a) <= 57.3), `the joints read ${JSON.stringify(angles)}, not degrees of the demo's swing of a radian`);
}
