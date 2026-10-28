// A designer makes a dial from the editor: adds a diagram, adds a circle and a line from the
// inspector, turns the line by Speed and gives the circle a tap. The page shows the needle at
// Speed's angle, a drag moves a shape in its diagram but never out of it, and a tap runs.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Dial");
  await d.openPage("Dial");
  await d.addRow("Diagram");
  await eventually(() => hmi.page(pageId).children.length === 1, "a diagram");
  const diagram = () => hmi.page(pageId).children[0];
  check(diagram().tag === "svg", `a diagram was added as ${diagram().tag}`);
  const addShape = async (kind) => {
    const before = diagram().children.length;
    await page.locator(".screen:not([hidden]) .sidebar.right .ghost", { hasText: "Add shape" }).click();
    await page.locator(".popover .menu-item", { hasText: new RegExp(`^${kind}$`) }).click();
    await eventually(() => diagram().children.length === before + 1, `a ${kind} in the diagram`);
    return diagram().children.at(-1).id;
  };
  const circle = await addShape("circle");
  // a shape picked adds the next one beside it, in the same diagram
  await page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: /^Circle$/ }) }).click();
  const line = await addShape("line");
  const layer = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
  await layer("Line").click();
  await d.setField("Transform", "`rotate(${Line.Speed * 90} 88 88)`");
  await eventually(() => diagram().children.find((s) => s.id === line)?.props.transform === "`rotate(${Line.Speed * 90} 88 88)`", "the line's transform");

  // the ring sits on the shape as drawn
  await layer("Circle").click();
  const [ring, shape] = [await page.locator(".ring").first().boundingBox(), await d.el(circle).boundingBox()];
  check(Math.abs(ring.x - shape.x) < 2 && Math.abs(ring.width - shape.width) < 2, `the ring is at ${ring.x}, the circle at ${shape.x}`);
  check((await page.locator(".ring .handle").count()) === 8, "a plain circle shows no grips to scale it");

  // a drag on a shape moves it in its diagram's units
  const at = () => diagram().children.find((s) => s.id === circle).props;
  const [cx, cy] = [Number(at().cx), Number(at().cy)];
  const k = shape.width / (2 * Number(at().r));
  // pressed left of the middle, clear of the needle drawn over it
  await d.gesture(shape.x + shape.width * 0.2, shape.y + shape.height / 2, 60, 30);
  await eventually(() => Number(at().cx) !== cx, "the drag to move the circle");
  check(Math.abs(Number(at().cx) - cx - 60 / k) <= 1 && Math.abs(Number(at().cy) - cy - 30 / k) <= 1, `the circle moved to ${at().cx}, ${at().cy}`);
  // its layer cannot leave the diagram: onto the diagram's top edge means beside it, on the
  // page, where no shape may go
  const shapes = () => JSON.stringify(diagram().children.map((s) => s.id));
  const before = shapes();
  const [from, to] = [await layer("Circle").boundingBox(), await layer("Diagram").boundingBox()];
  await d.gesture(from.x + 40, from.y + from.height / 2, 0, to.y + 3 - (from.y + from.height / 2));
  await page.waitForTimeout(200);
  check(shapes() === before && hmi.page(pageId).children.length === 1, "a shape was dragged out of its diagram");

  await layer("Circle").click();
  await d.addEvent("tap");
  await d.code("tap").click();
  await page.keyboard.type("Line.Speed = 1;");
  await page.keyboard.press("Control+Enter");
  await eventually(() => diagram().children.find((s) => s.id === circle)?.handlers[0]?.code === "Line.Speed = 1;", "the circle's tap");

  await hmi.set("Line.Speed", 0.5);
  await d.tab("Run");
  const run = (id) => page.locator(`.run-layer:not([hidden]) [data-id="${id}"]`);
  await eventually(async () => (await run(line).getAttribute("transform")) === "rotate(45 88 88)", "the needle at Speed's angle");
  await run(circle).click({ position: { x: 10, y: 50 } });
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 1, "a tap on the circle to set Speed");
  await eventually(async () => (await run(line).getAttribute("transform")) === "rotate(90 88 88)", "the needle to follow");
}
