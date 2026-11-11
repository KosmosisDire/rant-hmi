// An operator taps and drags parts of a scene. A tap on a box that handles taps runs its handler
// and not the scene's, a tap on one that does not runs the scene's, a drag moves a box along the
// ground by its ray while the scene's own drag stays still, a drag on nothing runs the scene's,
// and a tap on a dot names the dot.

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Picking");
  for (const [name, start] of [["tapped", "none"], ["dragX", -1], ["turns", 0]]) {
    await hmi.edit({ kind: "set_state", page: pageId, id: null, name, var: { name, start, per: "screen" } });
  }
  await hmi.addElement(pageId, "span", { name: "said", x: "2", y: "44", w: "60", h: "3", text: 'tapped + " " + dragX.toFixed(2) + " " + turns' });
  // state of the whole HMI, so a handler that sets it runs on the system
  await hmi.edit({ kind: "set_state", page: pageId, id: null, name: "far", var: { name: "far", start: "none", per: "hmi" } });
  await hmi.addElement(pageId, "span", { name: "far", x: "2", y: "48", w: "60", h: "3", text: "far" });
  // seen from above, 97 px a metre, x to the right and y up
  const scene = await hmi.addElement(pageId, "scene", { name: "yard", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "5" });
  await hmi.setHandler(pageId, scene, "tap", 'tapped = "scene";');
  await hmi.setHandler(pageId, scene, "drag", "turns = turns + 1;");
  const red = await hmi.addElement(pageId, "box", { name: "red", size: "vec(0.5, 0.5, 0.5)", color: '"#ff0000"', pose: "{ position: vec(dragX, 0, 0) }" }, scene);
  await hmi.setHandler(pageId, red, "tap", 'tapped = "red " + p.ray.at(0).z.toFixed(0);');
  // where the ray meets the ground
  await hmi.setHandler(pageId, red, "drag", "const t = -p.ray.origin.z / p.ray.direction.z;\ndragX = p.ray.origin.x + p.ray.direction.x * t;");
  await hmi.addElement(pageId, "box", { name: "blue", size: "vec(0.5, 0.5, 0.5)", color: '"#0000ff"', pose: "{ position: vec(1, 0, 0) }" }, scene);
  const yellow = await hmi.addElement(pageId, "box", { name: "yellow", size: "vec(0.5, 0.5, 0.5)", color: '"#ffff00"', pose: "{ position: vec(0, 1, 0) }" }, scene);
  await hmi.setHandler(pageId, yellow, "tap", 'far = "ray " + p.ray.at(0).z.toFixed(0);');
  const dots = await hmi.addElement(pageId, "points", { name: "dots", points: "[vec(-0.5, -1.2, 0), vec(0, -1.2, 0), vec(0.5, -1.2, 0)]", size: "0.3", color: '"#00ff00"' }, scene);
  await hmi.setHandler(pageId, dots, "tap", 'tapped = "dot " + p.index;');

  await d.openPage("Picking");
  await d.tab("Run");
  const layer = page.locator(".run-layer:not([hidden])");
  const el = layer.locator(`.el[data-id="${scene}"]`);
  const said = layer.locator('.el[data-name="said"]');
  await d.shows(el, 0.339, 0.5, ([r, g, b]) => r > 150 && g < 60 && b < 60, "the red box drawn");
  const box = await el.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const says = (want, what) => eventually(async () => (await said.textContent()) === want, async () => `${what}, it says ${await said.textContent()}`);

  // the camera is 5 m up, so a ray starts there
  await page.mouse.click(...at(0.339, 0.5));
  await says("red 5 -1.00 0", "the red box's tap to run, not the scene's");
  // a press begins a drag, which the blue box and the dots leave to the scene
  await page.mouse.click(...at(0.661, 0.5));
  await says("scene -1.00 1", "a tap on the blue box, which takes none, to be the scene's");
  await page.mouse.click(...at(0.5, 0.79));
  await says("dot 1 -1.00 2", "the tap on the middle dot to name it");
  // the system's handler reads the ray as a Ray too
  await page.mouse.click(...at(0.5, 0.21));
  const far = layer.locator('.el[data-name="far"]');
  await eventually(async () => (await far.textContent()) === "ray 5", async () => `the system's handler to read the ray, it says ${await far.textContent()}`);

  // dragged a metre to the right, the box follows the pointer on the ground
  await d.gesture(...at(0.339, 0.5), box.width * 0.161, 0);
  await eventually(async () => {
    const [, x, turns] = (await said.textContent()).split(" ").slice(-3);
    return Math.abs(Number(x)) < 0.08 && turns === "3";
  }, async () => `the red box dragged to 0 and the scene still, it says ${await said.textContent()}`);
  await d.shows(el, 0.5, 0.5, ([r, g, b]) => r > 150 && g < 60 && b < 60, "the red box drawn where it was dragged");
  await d.gesture(...at(0.8, 0.2), 40, 20);
  await eventually(async () => Number((await said.textContent()).split(" ").at(-1)) > 3, "a drag on nothing to be the scene's");
}
