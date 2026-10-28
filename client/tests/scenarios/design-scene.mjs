// A designer adds a 3D scene, which starts with a floor and its axes, and a box in it whose pose
// follows a value, seen by a camera the scene's properties aim. three.js loads only once a scene
// shows. A value a part or the camera cannot use gives way to its default and says why on the
// scene, a picked part rings its scene, and the run draws it as the editor does.

export default async function ({ page, hmi, d, check, eventually }) {
  const loaded = () => page.evaluate(() => performance.getEntriesByType("resource").some((r) => /\/assets\/scene-[^/]*\.js$/.test(r.name)));
  await d.addPage("Scene");
  // the board draws the pages beside this one too, which may hold a scene of their own
  const holds = (els) => els.some((e) => e.tag === "scene" || holds(e.children));
  const drawn = await page.locator(".artboard .page-layer").evaluateAll((ls) => ls.map((l) => l.dataset.page));
  check(!(await loaded()) || drawn.some((id) => holds(hmi.page(id)?.children ?? [])), "three.js loaded before any scene showed");
  const scene = await d.add("scene", { Name: "cell", x: "4", y: "4", w: "40", h: "30", Target: "vec(10, 0, 0.5)" });
  await eventually(loaded, "three.js to load once a scene shows");
  const pageId = hmi.state.pages.find((p) => p.name === "Scene").id;
  const held = () => hmi.page(pageId).children.find((e) => e.id === scene).children;
  check(held().map((e) => e.tag).join() === "grid,axes", `a new scene holds ${held().map((e) => e.tag).join()}, not a grid and axes`);

  // the box sits where the value puts it, in the middle of the view where the camera aims
  const box = await d.addPart("box", { Pose: "{ position: vec(Line.Speed * 10, 0, 0.5) }", Colour: '"#ff0000"' });
  const red = ([r, g, b]) => r > 120 && g < 60 && b < 60;
  hmi.set("Line.Speed", 1);
  await d.shows(d.el(scene), 0.5, 0.5, red, "the box in the middle with Speed 1");
  hmi.set("Line.Speed", 0);
  await d.shows(d.el(scene), 0.5, 0.5, (c) => !red(c), "the box out of the middle with Speed 0");
  const kept = held().find((e) => e.id === box);
  check(kept?.tag === "box" && kept.props.color === '"#ff0000"', "the box was not kept in the scene");

  // a picked part has no box of its own, so its scene is ringed
  const ring = await page.locator(".artboard .ring").boundingBox();
  const own = await d.el(scene).boundingBox();
  check(!!ring && !!own && Math.abs(ring.x - own.x) <= 2 && Math.abs(ring.width - own.width) <= 2, `the picked box rings ${JSON.stringify(ring)}, not its scene ${JSON.stringify(own)}`);

  // a size that is no vector says why on the scene, and the box draws at its default size
  hmi.set("Line.Speed", 1);
  await d.setField("Size", "2");
  await eventually(async () => (await d.el(scene).getAttribute("title"))?.includes("Box: size: 2 is not a 3D vector"), "the scene to say the box's size is no vector");
  await d.shows(d.el(scene), 0.5, 0.5, red, "the box still drawn with its default size");
  // a target that will not read aims at the origin, its default, and no longer at the box
  await d.select("cell");
  await d.setField("Target", "nowhere");
  await eventually(async () => (await d.el(scene).getAttribute("title"))?.includes("target: nowhere"), "the scene to say its target will not read");
  await d.shows(d.el(scene), 0.5, 0.5, (c) => !red(c), "the camera to aim at the origin");
  await d.setField("Target", "vec(10, 0, 0.5)");

  // the run draws it as the editor does
  await d.tab("Run");
  await d.shows(page.locator(`.run-layer:not([hidden]) .el[data-id="${scene}"]`), 0.5, 0.5, red, "the run to draw the box in the middle");
}
