// A user copies a panel with a label in it and pastes it, duplicates the copy, cuts it into
// another frame, and pastes on a second page. A field keeps Ctrl C for its own text.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Clip");
  const panel = await hmi.addElement(pageId, "div", { name: "Panel", x: "44", y: "44", w: "220", h: "132", background: "#2a2f35" });
  await hmi.addElement(pageId, "span", { name: "Label", x: "11", y: "11", w: "176", h: "44", text: '"Hi"' }, panel);
  const holder = await hmi.addElement(pageId, "div", { name: "Holder", x: "440", y: "44", w: "440", h: "352", background: "#1e2125" });
  await d.openPage("Clip");
  const roots = () => hmi.page(pageId).children;
  const empty = () => page.locator(".artboard").click({ position: { x: 5, y: 5 } });
  // low in the frame, clear of the label inside it
  const press = async (id) => {
    const b = await d.box(id);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.9);
  };

  await press(panel);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await eventually(() => roots().length === 3, "the paste beside the panel");
  const pasted = roots()[1];
  check(pasted.props.name === "Panel" && pasted.children[0]?.props.text === '"Hi"', "the paste is not a whole copy of the panel");
  check(pasted.id !== panel && pasted.children[0].id !== roots()[0].children[0].id, "the paste reused an id");

  await eventually(async () => (await page.locator(".artboard .ring").count()) === 1 && pasted.id === (await page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row.selected").getAttribute("data-id")), "the paste to be selected");
  await page.keyboard.press("Control+d");
  await eventually(() => roots().length === 4, "the duplicate");
  const dup = roots()[2];
  check(dup.props.x === "54" && dup.props.y === "54", `the duplicate sits at ${dup.props.x}, ${dup.props.y}`);

  await eventually(async () => dup.id === (await page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row.selected").getAttribute("data-id")), "the duplicate to be selected");
  await page.keyboard.press("Control+x");
  await eventually(() => roots().length === 3, "the cut");
  await press(holder);
  await page.keyboard.press("Control+v");
  await eventually(() => roots().find((e) => e.id === holder)?.children.length === 1, "the paste into the holder");

  await empty();
  await press(panel);
  await d.field("Name").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Escape");
  await empty();
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(300);
  check(roots().length === 3, "pasting a field's text added an element");

  await press(panel);
  await page.keyboard.press("Control+c");
  const other = await hmi.addPage("Clip two");
  await d.openPage("Clip two");
  await page.keyboard.press("Control+v");
  await eventually(() => hmi.page(other)?.children[0]?.props.name === "Panel", "the paste on the second page");
}
