// A designer makes three boxes in a scene that an operator selects by a tap, each lit while it is
// the one picked, and a tap on nothing picks none. The boxes take only a tap, so a drag that
// starts on one still turns the scene.

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Picking boxes");
  await hmi.edit({ kind: "set_state", page: pageId, id: null, name: "picked", var: { name: "picked", start: "", per: "screen" } });
  await d.openPage("Picking boxes");
  await d.add("scene", { Name: "yard", x: "2", y: "2", w: "60", h: "40" });
  // its view starts from above, 97 px a metre, x to the right, as its own handlers turn it
  const view = { target: { x: 0, y: 0, z: 0 }, yaw: -Math.PI / 2, pitch: 1.5, distance: 5 };
  await hmi.edit({ kind: "set_state", page: pageId, id: null, name: "sceneView", var: { name: "sceneView", start: view, per: "screen" } });
  await d.handler("tap", 'picked = "";');
  for (const [name, x] of [["a", -1], ["b", 0], ["c", 1]]) {
    await d.select("yard");
    await d.addPart("box", { Name: name, Pose: `{ position: vec(${x}, 0, 0) }`, Size: "vec(0.5, 0.5, 0.5)", Colour: `picked === "${name}" ? "#ffcc00" : "#4060a0"` });
    await d.handler("tap", `picked = "${name}";`);
  }

  await d.tab("Run");
  const el = page.locator(".run-layer:not([hidden]) .el[data-name=\"yard\"]");
  const lit = ([r, g, b]) => r > 200 && g > 150 && b < 80;
  const dim = ([r, g, b]) => b > 120 && r < 110;
  const spots = { a: 0.5 - 97 / 600, b: 0.5, c: 0.5 + 97 / 600 };
  const shows = async (one, what) => {
    for (const [name, fx] of Object.entries(spots)) await d.shows(el, fx, 0.5, name === one ? lit : dim, `${what}: ${name} ${name === one ? "lit" : "dim"}`);
  };
  await shows(null, "none picked at first");
  const box = await el.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.click(...at(spots.a, 0.5));
  await shows("a", "a tap on a");
  await page.mouse.click(...at(spots.c, 0.5));
  await shows("c", "a tap on c");
  await page.mouse.click(...at(0.5, 0.15));
  await shows(null, "a tap on nothing");

  // a drag from b turns the scene about b, which moves a away from where it was
  await d.gesture(...at(spots.b, 0.5), 150, 0);
  await eventually(async () => dim(await d.colour(el, spots.a, 0.5)) === false, "a drag from b to turn the scene");
}
