// A designer builds a Gizmo in the editor alone: three handles along x, y and z where its value
// puts them, each lit while the pointer is over it, and a drag on one that moves the value along
// its axis to where the pointer's ray passes nearest. Bound to a page's pose, a drag on its x
// handle moves a box a metre along x.

export default async function ({ page, hmi, d, eventually }) {
  await d.add3DComponent("Gizmo");
  await d.addInput("value", "{ position: vec(0, 0, 0) }", { twoWay: true, type: "Pose" });
  await d.addInput("size", "0.6");
  await d.addSends("change");
  await d.addVariable("grab", "0");
  await d.add("anchor", { Name: "at", Pose: "{ position: value.position }" });
  const handle = async (axis, colour, size, along, direction) => {
    await d.addPart("box", { Name: axis, Pose: `{ position: ${along} }`, Size: size, Colour: `${axis}.hovered || ${axis}.pressed ? "#ffffff" : "${colour}"` });
    // where the pointer's ray passes nearest the line along the axis through the value
    const nearest = `p.ray.closestRay({ origin: value.position - ${direction} * 100, direction: ${direction} }).b`;
    await d.handler("press", `grab = ${nearest}.${axis} - value.position.${axis};`);
    await d.handler("drag", `const at = ${nearest};\nvalue = { ...value, position: { ...value.position, ${axis}: at.${axis} - grab } };\nemit("change", value);`);
  };
  await handle("x", "#e5484d", "vec(size, 0.06, 0.06)", "vec(size / 2, 0, 0)", "vec(1, 0, 0)");
  await handle("y", "#46a758", "vec(0.06, size, 0.06)", "vec(0, size / 2, 0)", "vec(0, 1, 0)");
  await handle("z", "#3e63dd", "vec(0.06, 0.06, size)", "vec(0, 0, size / 2)", "vec(0, 0, 1)");

  // a box where a pose the page keeps puts it, and a Gizmo bound to the pose
  const pageId = await hmi.addPage("Gizmos");
  await hmi.edit({ kind: "set_state", page: pageId, id: null, name: "target", var: { name: "target", start: { position: { x: 0, y: 0, z: 0 } }, per: "screen" } });
  await hmi.addElement(pageId, "span", { name: "said", x: "2", y: "44", w: "60", h: "3", text: "target.position.x.toFixed(1)" });
  // seen from above, 97 px a metre, x to the right
  const scene = await hmi.addElement(pageId, "scene", { name: "cell", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "5" });
  await hmi.addElement(pageId, "box", { name: "load", size: "vec(0.3, 0.3, 0.3)", color: '"#888888"', pose: "target" }, scene);
  await hmi.addElement(pageId, "use", { name: "mover", value: "target" }, scene, "Gizmo");

  await d.openPage("Gizmos");
  await d.tab("Run");
  const layer = page.locator(".run-layer:not([hidden])");
  const el = layer.locator(`.el[data-id="${scene}"]`);
  const said = layer.locator('.el[data-name="said"]');
  // its x handle 0.4 m along
  const grip = [0.5 + 40 / 600, 0.5];
  await d.shows(el, ...grip, ([r, g, b]) => r > 180 && g < 110 && b < 110, "the x handle drawn red");
  const box = await el.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(...grip));
  await d.shows(el, ...grip, ([r, g, b]) => r > 200 && g > 200 && b > 200, "the x handle lit with the pointer over it");
  await page.mouse.down();
  await page.mouse.move(...at(grip[0] + 97 / 600, grip[1]), { steps: 8 });
  await page.mouse.up();
  await eventually(async () => (await said.textContent()) === "1.0", async () => `the drag to move the pose a metre along x, it says ${await said.textContent()}`);
  // beside the handles, which stand on it now
  await d.shows(el, 0.5 + 89 / 600, 0.5 + 8 / 400, ([r, g, b]) => Math.abs(r - 136) < 30 && Math.abs(g - 136) < 30 && Math.abs(b - 136) < 30, "the box drawn where the pose moved");
}
