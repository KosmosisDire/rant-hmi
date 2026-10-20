// A designer makes a dial from the editor: adds a drawing, adds a circle and a line from the
// inspector, turns the line by Speed and gives the circle a tap. The page shows the needle at
// Speed's angle, a shape cannot be dragged out of its drawing, and a tap on it runs.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Dial");
  await d.openPage("Dial");
  await page.locator('.screen:not([hidden]) button[title="Add a drawing"]').click();
  await eventually(() => hmi.page(pageId).children.length === 1, "a drawing");
  const drawing = () => hmi.page(pageId).children[0];
  check(drawing().tag === "svg", `a drawing was added as ${drawing().tag}`);
  const addShape = async (kind) => {
    const before = drawing().children.length;
    await page.locator(".screen:not([hidden]) .sidebar.right .ghost", { hasText: "Add shape" }).click();
    await page.locator(".popover .menu-item", { hasText: new RegExp(`^${kind}$`) }).click();
    await eventually(() => drawing().children.length === before + 1, `a ${kind} in the drawing`);
    return drawing().children.at(-1).id;
  };
  const circle = await addShape("circle");
  // a shape picked adds the next one beside it, in the same drawing
  await page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: /^Circle$/ }) }).click();
  const line = await addShape("line");
  const layer = (name) => page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
  await layer("Line").click();
  await d.setField("Transform", "`rotate(${Speed * 90} 88 88)`");
  await eventually(() => drawing().children.find((s) => s.id === line)?.props.transform === "`rotate(${Speed * 90} 88 88)`", "the line's transform");

  // the ring sits on the shape as drawn
  await layer("Circle").click();
  const [ring, shape] = [await page.locator(".ring").first().boundingBox(), await d.el(circle).boundingBox()];
  check(Math.abs(ring.x - shape.x) < 2 && Math.abs(ring.width - shape.width) < 2, `the ring is at ${ring.x}, the circle at ${shape.x}`);
  check((await page.locator(".ring .handle").count()) === 0, "a shape shows grips it cannot use");

  // a drag on a shape moves nothing, and its layer cannot leave the drawing
  const before = JSON.stringify(drawing());
  await d.gesture(shape.x + 6, shape.y + shape.height / 2, 60, 30);
  await page.waitForTimeout(200);
  check(JSON.stringify(drawing()) === before, "a drag changed a shape");
  // onto the drawing's top edge means beside it, on the page, where no shape may go
  const [from, to] = [await layer("Circle").boundingBox(), await layer("Drawing").boundingBox()];
  await d.gesture(from.x + 40, from.y + from.height / 2, 0, to.y + 3 - (from.y + from.height / 2));
  await page.waitForTimeout(200);
  check(JSON.stringify(drawing()) === before, "a shape was dragged out of its drawing");

  await layer("Circle").click();
  await d.addEvent("tap");
  await d.code("tap").click();
  await page.keyboard.type("Speed = 1;");
  await page.keyboard.press("Control+Enter");
  await eventually(() => drawing().children.find((s) => s.id === circle)?.handlers[0]?.code === "Speed = 1;", "the circle's tap");

  await hmi.set("Speed", 0.5);
  await d.tab("Run");
  const run = (id) => page.locator(`.run-layer:not([hidden]) [data-id="${id}"]`);
  await eventually(async () => (await run(line).getAttribute("transform")) === "rotate(45 88 88)", "the needle at Speed's angle");
  await run(circle).click({ position: { x: 10, y: 50 } });
  await eventually(() => hmi.state.values.Speed?.value === 1, "a tap on the circle to set Speed");
  await eventually(async () => (await run(line).getAttribute("transform")) === "rotate(90 88 88)", "the needle to follow");
}
