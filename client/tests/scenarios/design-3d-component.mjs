// A designer makes a 3D component from its own button, adds a box to it from the layers, and turns
// its board by dragging it. They place it in a scene from the scene's menu, set its pose in the
// inspector, which offers no CSS for it, then make a box in the scene a component of its own.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Design");
  const side = (sel) => page.locator(`.screen:not([hidden]) .sidebar.${sel}`);
  const item = (words) => page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: new RegExp(`^${words}$`) }) });
  const red = ([r, g, b]) => r > 150 && g < 60 && b < 60;
  await side("left").locator('button[title="Add a 3D component"]').click();
  await side("right").locator(".head-title", { hasText: "Component" }).waitFor();
  const name = d.field("Name");
  await name.fill("Lamp3D");
  await name.press("Enter");
  await eventually(() => hmi.state.pages.some((p) => p.name === "Lamp3D" && p.interface?.space === "3d"), "a 3D component named Lamp3D");
  const lantern = () => hmi.state.pages.find((p) => p.name === "Lamp3D");

  // the layers' + offers parts, which take a pose and no place on the page
  await d.addRow("box");
  await eventually(() => lantern().children[0]?.tag === "box", "a box in Lamp3D");
  const box = lantern().children[0];
  check(box.props.pose && box.props.x === undefined, `the box went in as ${JSON.stringify(box.props)}`);
  await page.keyboard.press("Escape");
  await hmi.setProps(lantern().id, box.id, { color: '"#ff0000"' });

  // its board is a scene with a floor, which a drag turns, neither picking nor panning
  const layer = page.locator(".artboard .page-layer.open");
  await d.sees(layer, { red: "r > 150 && g < 60 && b < 60" }, (s) => s.red > 50, "the red box on Lamp3D's board");
  const at = await layer.boundingBox();
  const shot = async () => (await layer.screenshot()).toString("base64");
  const first = await shot();
  await d.gesture(at.x + at.width * 0.25, at.y + at.height * 0.25, at.width * 0.2, 0);
  await eventually(async () => (await shot()) !== first, "a drag on the board to turn it");
  const after = await layer.boundingBox();
  check(after.x === at.x && after.y === at.y, `the drag moved the board from ${JSON.stringify(at)} to ${JSON.stringify(after)}`);

  // placed in a scene from the scene's menu, a part with a pose and inputs, and no CSS
  const pageId = await hmi.addPage("Lamp3Ds");
  const scene = await hmi.addElement(pageId, "scene", { name: "hall", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "5" });
  await d.openPage("Lamp3Ds");
  await d.el(scene).click({ button: "right" });
  await item("Place a component").hover();
  await item("Lamp3D").click();
  await eventually(() => hmi.page(pageId).children[0].children.some((c) => c.component === "Lamp3D"), "a Lamp3D in the hall");
  const placed = hmi.page(pageId).children[0].children.find((c) => c.component === "Lamp3D");
  check(placed.props.w === undefined && placed.props.x === undefined, `the Lamp3D went in as ${JSON.stringify(placed.props)}`);
  // picked as it is made
  await side("right").locator(".head-title", { hasText: "Lamp3D" }).waitFor();
  await d.setField("Pose", "{ position: vec(1, 0, 0) }");
  await eventually(() => hmi.page(pageId).children[0].children.find((c) => c.id === placed.id)?.props.pose === "{ position: vec(1, 0, 0) }", "the pose set");
  check((await side("right").locator(".section", { hasText: /^Look$/ }).count()) === 0, "the 3D instance offers CSS");
  await d.shows(d.el(scene), 0.661, 0.5, red, "the Lamp3D drawn where its pose puts it");

  // a box in the scene made a component stays where it was, now a 3D component's part
  await hmi.addElement(pageId, "box", { name: "barrel", size: "vec(0.5, 0.5, 0.5)", color: '"#00ff00"', pose: "{ position: vec(-1, 0, 0) }" }, scene);
  await d.select("barrel");
  await d.menu((await d.layers()).locator(".list-row[data-id]", { has: page.locator(".list-label", { hasText: /^barrel$/ }) }).first(), "Convert to component");
  await eventually(() => hmi.state.pages.find((p) => p.name === "Barrel")?.interface?.space === "3d", "Barrel made a 3D component");
  await eventually(() => hmi.page(pageId).children[0].children.some((c) => c.component === "Barrel"), "an instance of Barrel in the hall");
  check(hmi.state.pages.find((p) => p.name === "Barrel").children[0].props.pose === "{ position: vec(-1, 0, 0) }", "the box lost its pose");
  await d.shows(d.el(scene), 0.339, 0.5, ([r, g, b]) => g > 150 && r < 60 && b < 60, "the Barrel drawn where the box was");
}
