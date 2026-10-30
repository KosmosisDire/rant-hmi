// A grid part draws a Rant Grid: a big flat map the worker keeps as a picture, coloured along the
// ramp by its first field or another, cut to a range, and small voxels that came on the page as
// a cube a cell.

export default async function ({ hmi, d, check, eventually }) {
  await hmi.import("Cell.MapD", "Cell/Map");
  await hmi.import("Cell.VoxelsD", "Cell/Voxels");
  await d.addPage("Scene grid");
  const pageId = hmi.state.pages.find((p) => p.name === "Scene grid").id;
  // seen from above, the 6 by 4 m room in view
  const scene = await hmi.addElement(pageId, "scene", { name: "top", x: "4", y: "4", w: "40", h: "30", yaw: "-PI / 2", pitch: "1.5", distance: "9", background: "#000000" }, null);
  const map = await hmi.addElement(pageId, "grid", { name: "map", grid: "Cell.MapD" }, scene);
  const el = d.el(scene);
  const says = (words) => eventually(async () => (await el.getAttribute("title"))?.includes(words), `the scene to say ${words}`);
  const quiet = async () => check(!(await el.getAttribute("title"))?.includes(": grid:"), `the scene says ${await el.getAttribute("title")}`);
  const lit = "r + g + b > 60";
  const ramp = { low: "b > r + 40 && b > g", high: "r > g + 60 && r > b + 60" };

  // its occupancy: the free floor at the ramp's low end, the walls and the post at its high end
  await d.sees(el, { ...ramp, lit }, (s) => s.low > 10000 && s.high > 800, "the map's floor and walls");
  await quiet();
  const whole = (await d.count(el, { lit })).lit;
  // the unknown corners, -1, below the range
  await hmi.setProps(pageId, map, { range: "[0, 100]" });
  await d.sees(el, { lit }, (s) => s.lit < 0.98 * whole && s.lit > 0.8 * whole, `the map but its corners, of ${whole} pixels`);
  // only the walls and the post
  await hmi.setProps(pageId, map, { range: "[50, 100]" });
  await d.sees(el, ramp, (s) => s.low < 50 && s.high > 800, "only the walls and the post");
  await quiet();

  // by clearance, low by the walls and high in the middle
  await hmi.setProps(pageId, map, { field: '"clearance"', range: "[]" });
  await d.sees(el, ramp, (s) => s.low > 1000 && s.high > 1000, "the map by clearance");
  await quiet();
  await hmi.setProps(pageId, map, { field: '"nope"' });
  await says("map: field: the grid has no field nope");

  // voxels seen nearer, the free cells left out: a ball at the ramp's high end
  await hmi.setProps(pageId, map, { grid: "null", field: '""' });
  await hmi.setProps(pageId, scene, { distance: "4" });
  const ball = await hmi.addElement(pageId, "grid", { name: "ball", grid: "Cell.VoxelsD", range: "[50, 100]" }, scene);
  await d.sees(el, ramp, (s) => s.high > 300 && s.low < 50, "the ball of voxels and no map");
  await quiet();
  // with its free cells, a block of them at the low end round it
  await hmi.setProps(pageId, ball, { range: "[]" });
  await d.sees(el, ramp, (s) => s.low > 300, "the block of free voxels");

  await hmi.setProps(pageId, ball, { grid: "1" });
  await says("ball: grid: 1 is not a Grid");
}
