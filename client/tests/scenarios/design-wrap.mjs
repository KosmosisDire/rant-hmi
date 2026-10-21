// Shift A lays the picked elements out in a new frame as they stand: three spread across become
// a row in their order, their gap kept and each where it was drawn, the frame hugging them and
// picked. One undo takes it back. Three stacked down become a column, from the right click menu.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Wrapping");
  const across = [];
  for (const x of [24, 4, 14]) across.push(await hmi.addElement(pageId, "div", { name: `R${x}`, x: String(x), y: "10", w: "6", h: "4", background: "#4a8fd6" }));
  await d.openPage("Wrapping");
  const before = await Promise.all(across.map((id) => d.box(id)));
  const tops = () => hmi.page(pageId).children.map((e) => e.id);

  for (const [i, id] of across.entries()) await d.el(id).click({ modifiers: i ? ["Shift"] : [] });
  await page.keyboard.press("Shift+A");
  await eventually(() => tops().length === 1, () => `one frame to hold the three, the page holds ${tops()}`);
  const frame = hmi.page(pageId).children[0];
  check(frame.props.layout === '"right"' && frame.props.gap === "4" && frame.props.x === "4" && frame.props.y === "10" && frame.props.w === "hug", `the frame reads ${JSON.stringify(frame.props)}`);
  check(frame.children.map((e) => e.id).join() === [across[1], across[2], across[0]].join(), "the row is not in the order they stood");
  // the backend holds the frame before this screen draws it, so each part is measured once drawn in it
  for (const id of across) await d.el(frame.id).locator(`.el[data-id="${id}"]`).waitFor();
  for (const [i, id] of across.entries()) {
    const [was, now] = [before[i], await d.box(id)];
    check(Math.abs(was.x - now.x) < 1.5 && Math.abs(was.y - now.y) < 1.5, `${id} moved from ${was.x},${was.y} to ${now.x},${now.y}`);
  }
  await page.locator(`.screen:not([hidden]) .sidebar.left .list-row.selected[data-id="${frame.id}"]`).waitFor();

  await page.keyboard.press("Control+Z");
  await eventually(() => tops().length === 3, "one undo to take the frame back");

  const down = [];
  for (const y of [40, 32, 48]) down.push(await hmi.addElement(pageId, "div", { name: `C${y}`, x: "60", y: String(y), w: "8", h: "6", background: "#3fa66b" }));
  for (const [i, id] of down.entries()) await d.el(id).click({ modifiers: i ? ["Shift"] : [] });
  await d.menu(d.el(down[0]), "Lay out in a new frame");
  await eventually(() => tops().length === 4, () => `one frame to hold the column, the page holds ${tops()}`);
  const column = hmi.page(pageId).children.at(-1);
  check(column.props.layout === '"down"' && column.props.gap === "2" && column.props.y === "32", `the column reads ${JSON.stringify(column.props)}`);
  check(column.children.map((e) => e.id).join() === [down[1], down[0], down[2]].join(), "the column is not in the order they stood");
}
