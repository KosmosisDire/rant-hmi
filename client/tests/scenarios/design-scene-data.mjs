// Points take Rant's standard types as they come: a PointCloud in its own colours or along the
// ramp by a field, cut to a range, a LaserScan's returns and a Path as a line. The GPU reads them
// from their bytes, big or small, and a field the value lacks says so on the scene.

export default async function ({ hmi, d, check, eventually }) {
  await hmi.import("Cell.CloudD", "Cell/Cloud");
  await hmi.import("Cell.LidarD", "Cell/Lidar");
  await hmi.import("Cell.PlanD", "Cell/Plan");
  await hmi.import("Cell.PartD", "Cell/Part");
  await d.addPage("Scene data");
  const pageId = hmi.state.pages.find((p) => p.name === "Scene data").id;
  // seen from above, x to the right, the 4 by 2 m floor and the 6 by 4 m room in view
  const scene = await hmi.addElement(pageId, "scene", { name: "top", x: "4", y: "4", w: "40", h: "30", yaw: "-PI / 2", pitch: "1.5", distance: "9", background: "#000000" }, null);
  const dots = await hmi.addElement(pageId, "points", { name: "cloud", points: "Cell.CloudD", size: "0.03" }, scene);
  const el = d.el(scene);
  const says = (words) => eventually(async () => (await el.getAttribute("title"))?.includes(words), `the scene to say ${words}`);
  const quiet = async () => check(!(await el.getAttribute("title"))?.includes("cloud:"), `the scene says ${await el.getAttribute("title")}`);

  const sees = (tests, ok, what) => d.sees(el, tests, ok, what);

  // its own rgb: a grey floor and an orange part
  const own = { grey: "Math.abs(r - 120) < 25 && Math.abs(g - 120) < 25 && Math.abs(b - 120) < 25", orange: "r > 180 && g > 100 && g < 180 && b < 90" };
  await sees(own, (s) => s.grey > 2000 && s.orange > 50, "the cloud in its own colours");
  await quiet();

  // by height along the ramp: the floor at the low end, blue, the part at the high end, red
  await hmi.setProps(pageId, dots, { field: '"z"' });
  const ramp = { low: "b > 150 && r < 120 && g < 130", high: "r > 150 && g < 70 && b < 40", grey: own.grey };
  await sees(ramp, (s) => s.low > 2000 && s.high > 50 && s.grey < 100, "the cloud along the ramp by height");

  // a range leaves the floor out, as below it
  await hmi.setProps(pageId, dots, { range: "[0.1, 0.5]" });
  await sees({ low: ramp.low, lit: "r + g + b > 150" }, (s) => s.low < 50 && s.lit > 50, "only the part, the floor below the range");
  await quiet();

  // a field the cloud has not
  await hmi.setProps(pageId, dots, { field: '"nope"', range: "[]" });
  await says("cloud: field: the cloud has no number field nope");

  // a lidar's returns on the room's walls, 3 m to either side, and on the post
  await hmi.setProps(pageId, dots, { points: "Cell.LidarD", field: '""', range: "[]", size: "0.08", color: '"#ffff00"' });
  const b = await el.boundingBox();
  // where x falls across the scene, which sees 2 tan(PI / 8) of its distance up its height
  const across = (x) => 0.5 + x / (2 * 9 * Math.tan(Math.PI / 8) * (b.width / b.height));
  const yellow = ([r, g, bl]) => r > 80 && g > 80 && bl < 60 && Math.abs(r - g) < 40;
  await d.shows(el, across(3), 0.5, yellow, "the right wall's returns");
  await d.shows(el, across(-3), 0.5, yellow, "the left wall's returns");
  await d.shows(el, across(0.5), 0.3, (c) => !yellow(c), "nothing inside the room but the post");
  await quiet();
  // by intensity the post, 255, is at the ramp's high end and the walls, 100, below it
  await hmi.setProps(pageId, dots, { field: '"intensity"', range: "[0, 255]" });
  await sees({ high: ramp.high, wall: "g > 180 && b > 90 && r < 140" }, (s) => s.high > 0 && s.wall > 200, "the walls and the post by intensity");

  // a path as one line through its poses, round an ellipse 3 m across
  await hmi.setProps(pageId, dots, { points: "Cell.PlanD", field: '""', range: "[]", joined: "true", color: '"#00ff00"' });
  await sees({ green: "g > 150 && r < 100 && b < 100" }, (s) => s.green > 100, "the path drawn round its ellipse");
  await quiet();
  // its far half by y left out, with no line across from one end of the rest to the other
  const lit = "r + g + b > 150";
  let ring = 0;
  await hmi.setProps(pageId, dots, { field: '"y"' });
  await sees({ lit }, (s) => (ring = s.lit) > 100, "the path along the ramp by y");
  await hmi.setProps(pageId, dots, { range: "[0, 1]" });
  await sees({ lit }, (s) => s.lit > 0.3 * ring && s.lit < 0.7 * ring, `half the path, of ${ring} pixels`);

  // a small cloud, the box's vertices, as the page sent it: its own colours, then one each with a
  // size each, on the eight corners 0.4 m apart
  await hmi.setProps(pageId, dots, { points: "Cell.PartD.vertices", field: '""', range: "[]", joined: "false", color: null, size: "0.2" });
  await sees({ orange: own.orange }, (s) => s.orange > 60, "the box's corners in their own colours");
  await quiet();
  await hmi.setProps(pageId, dots, { color: "Array.from({ length: 24 }, () => '#ff00ff')", size: "Array.from({ length: 24 }, () => 0.2)" });
  let big = 0;
  await sees({ magenta: "r > 200 && b > 200 && g < 80" }, (s) => (big = s.magenta) > 100, "the corners in magenta");
  await hmi.setProps(pageId, dots, { size: "Array.from({ length: 24 }, () => 0.1)" });
  await sees({ magenta: "r > 200 && b > 200 && g < 80" }, (s) => s.magenta > 20 && s.magenta < 0.5 * big, `smaller corners, of ${big} pixels`);
  await quiet();
}
