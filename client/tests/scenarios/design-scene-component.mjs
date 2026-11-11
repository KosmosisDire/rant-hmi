// A designer makes Marker3D, a 3D component of a block in the colour its instance gives, and
// places it twice in a scene: each draws at its own pose in its own colour, a 3D component holding
// two of them draws both, and an operator sees one whose pose is unknown draw nothing while the
// rest still do.

export default async function ({ page, hmi, d, eventually }) {
  if (!hmi.object("Sensor")) await hmi.addObject("Sensor", "Nowhere");
  if (!hmi.state.imports.some((i) => i.alias === "Sensor.Present")) {
    hmi.send({ type: "import", object: "Sensor", import: { alias: "Present", entity: "Present", kind: "variable", intent: "read" } });
    await hmi.next((m) => m.type === "objects" && hmi.state.imports.some((i) => i.alias === "Sensor.Present"));
  }
  const beacon = await hmi.addComponent("Marker3D", "3d");
  await hmi.edit({ kind: "set_input", page: beacon, name: "colour", input: { name: "colour", default: '"#ffffff"', bindable: false, type: "" } });
  await hmi.addElement(beacon, "box", { name: "block", size: "vec(0.5, 0.5, 0.5)", color: "colour" });

  const pageId = await hmi.addPage("Markers");
  // seen from above
  const scene = await hmi.addElement(pageId, "scene", { name: "yard", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "5" });
  const place = (name, x, colour) => hmi.addElement(pageId, "use", { name, pose: `{ position: vec(${x}, 0, 0) }`, colour }, scene, "Marker3D");
  const red = await place("red", -1, '"#ff0000"');
  await place("blue", 1, '"#0000ff"');
  await d.openPage("Markers");
  const el = d.el(scene);
  const tests = { red: "r > 150 && g < 60 && b < 60", blue: "b > 150 && r < 60 && g < 60", green: "g > 150 && r < 60 && b < 60" };
  let one = 0;
  await d.sees(el, tests, (s) => s.red > 300 && Math.abs(s.blue - s.red) < 0.1 * s.red && (one = s.red), "both markers drawn, each in its colour and as big");
  // each at its own pose: the red one left of the blue one
  const [left, right] = [await d.colour(el, 0.3, 0.5), await d.colour(el, 0.7, 0.5)];
  if (!(left[0] > 150 && right[2] > 150)) throw new Error(`the red marker is not left of the blue one: ${left} and ${right}`);

  // a 3D component placed once draws the two Marker3Ds it holds, each at its pose in it
  const pair = await hmi.addComponent("MarkerPair", "3d");
  for (const [name, y] of [["near", 1], ["far", -1]]) await hmi.addElement(pair, "use", { name, pose: `{ position: vec(0, ${y}, 0) }`, colour: '"#00ff00"' }, null, "Marker3D");
  await hmi.addElement(pageId, "use", { name: "pair", pose: "{}" }, scene, "MarkerPair");
  await d.sees(el, tests, (s) => s.green > 1.8 * one && s.green < 2.2 * one, "the pair's two Marker3Ds drawn green");

  // while its pose is unknown it draws nothing, and the others still draw
  await hmi.setProps(pageId, red, { pose: "{ position: vec(-1, 0, Sensor.Present ? 0 : 0) }" });
  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${scene}"]`);
  await d.sees(run, tests, (s) => s.red === 0 && s.blue > 0.9 * one && s.green > 1.8 * one, "the red marker gone while its pose is unknown, the rest drawn");
}
