// A designer repeats a frame over a computed value that keeps the wide boxes of a mesh import,
// each copy as wide as its box. The copies follow the kept boxes, and the import read whole is a
// value too.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Finds", "Line1/LabelCam/Detections");
  hmi.send({ type: "set_computed", name: "wideFinds", computed: { name: "wideFinds", get: "Finds.boxes.filter((b) => b.max.x - b.min.x > 145)" } });
  hmi.send({ type: "set_computed", name: "allFinds", computed: { name: "allFinds", get: "Finds" } });
  await eventually(() => hmi.state.values.wideFinds?.value?.length === 2, () => `wideFinds to keep two boxes, not ${JSON.stringify(hmi.state.values.wideFinds)}`);
  await eventually(() => hmi.state.values.allFinds?.value?.boxes?.length === 3, () => `allFinds to read the import whole, not ${JSON.stringify(hmi.state.values.allFinds)}`);

  const pageId = await hmi.addPage("Finds");
  await d.openPage("Finds");
  await d.addRow("Frame");
  await eventually(() => hmi.page(pageId).children.length === 1, "a frame");
  const id = hmi.page(pageId).children[0].id;
  await d.setField("Repeat", "wideFinds");
  await d.setField("w", "item.max.x - item.min.x");
  await d.setField("x", "index * 400");
  await eventually(() => hmi.page(pageId).children[0].props.repeat === "wideFinds", "the repeat");

  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await run.count()) === 2, "a copy for each wide box");
  const [a, b] = [await run.nth(0).boundingBox(), await run.nth(1).boundingBox()];
  check(Math.abs(a.width / b.width - 346 / 150) < 0.05, `the copies are ${a.width} and ${b.width} wide, not as their boxes`);
}
