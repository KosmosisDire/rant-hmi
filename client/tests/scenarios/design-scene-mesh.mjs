// A mesh part draws a Rant Mesh lit: a big one the worker keeps, its normals worked out from its
// triangles, coloured along the ramp and cut to a range, and a small one that came on the page,
// in its own colours and normals, in one colour, or by a field.

export default async function ({ hmi, d, check, eventually }) {
  await hmi.import("Cell.GroundD", "Cell/Ground");
  await hmi.import("Cell.PartD", "Cell/Part");
  await d.addPage("Scene mesh");
  const pageId = hmi.state.pages.find((p) => p.name === "Scene mesh").id;
  // seen from above, the 4 by 4 m ground filling most of it
  const scene = await hmi.addElement(pageId, "scene", { name: "top", x: "4", y: "4", w: "40", h: "30", yaw: "-PI / 2", pitch: "1.5", distance: "6", background: "#000000" }, null);
  const ground = await hmi.addElement(pageId, "mesh", { name: "ground", mesh: "Cell.GroundD" }, scene);
  const el = d.el(scene);
  const says = (words) => eventually(async () => (await el.getAttribute("title"))?.includes(words), `the scene to say ${words}`);
  const quiet = async () => check(!(await el.getAttribute("title"))?.includes(": mesh:"), `the scene says ${await el.getAttribute("title")}`);
  const lit = "r + g + b > 60";

  await d.sees(el, { lit }, (s) => s.lit > 20000, "the ground drawn and lit");
  await quiet();

  // by height along the ramp, its hollows blue and its hills red
  await hmi.setProps(pageId, ground, { field: '"z"' });
  const ramp = { low: "b > r + 40 && b > g", high: "r > g + 60 && r > b + 60" };
  await d.sees(el, ramp, (s) => s.low > 2000 && s.high > 2000, "the ground along the ramp by height");
  const whole = (await d.count(el, { lit })).lit;
  // a range leaves out each triangle with a vertex below it, about half the ground
  await hmi.setProps(pageId, ground, { range: "[0, 0.3]" });
  await d.sees(el, { lit }, (s) => s.lit < 0.7 * whole && s.lit > 0.2 * whole, `only the hills of the ${whole} pixels, the hollows below the range`);
  await quiet();

  // a small box over it, in its own colours, its top orange
  await hmi.setProps(pageId, ground, { field: '""', range: "[]", color: '"#202020"' });
  const part = await hmi.addElement(pageId, "mesh", { name: "part", mesh: "Cell.PartD", pose: "{ position: vec(0, 0, 0.5) }" }, scene);
  const orange = "r > 160 && g > 80 && g < 170 && b < 80";
  await d.sees(el, { orange }, (s) => s.orange > 300, "the box's orange top");
  await quiet();
  await hmi.setProps(pageId, part, { color: '"#00ff00"' });
  await d.sees(el, { orange, green: "g > 120 && r < 90 && b < 90" }, (s) => s.orange < 20 && s.green > 300, "the box in green");
  // its top at the ramp's high end by its own vertices' z
  await hmi.setProps(pageId, part, { field: '"z"' });
  await d.sees(el, { high: ramp.high }, (s) => s.high > 300, "the box's top red by height");
  await quiet();

  await hmi.setProps(pageId, part, { mesh: "1" });
  await says("part: mesh: 1 is not a Mesh");
  await hmi.setProps(pageId, part, { mesh: "null" });
  await d.sees(el, { high: ramp.high }, (s) => s.high < 20, "no box once its mesh is null");
  await quiet();
}
