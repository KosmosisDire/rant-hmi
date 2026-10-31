// Rant Math in what a screen draws: a call by name on math, and values from the HMI's own vectors,
// and a name of it offered after the dot. A failed call says why, as JavaScript does.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Math");
  const text = (name, y, source) => hmi.addElement(pageId, "span", { name, x: "4", y: String(y), w: "40", h: "4", text: source });
  const length = await text("Length", 4, "math.double3Length(vec(3, 4, 0))");
  const pose = await text("Pose", 10, "math.poseApply({ position: vec(1, 2, 3), orientation: { x: 0, y: 0, z: 0, w: 1 } }, vec(1, 0, 0)).x");
  const unity = await text("Unity", 16, "math.axesPointTo(math.axesOf('Unity'), vec(1, 0, 0)).z");
  const missed = await text("Missed", 22, "math.planeRaycast({ position: vec(0, 0, 0), normal: vec(0, 0, 1) }, { origin: vec(0, 0, 5), direction: vec(0, 0, 1) }) === null");
  const shape = await text("Shape", 28, "math.shapeDistance(math.shapeFromPolyline([vec(0, 0, 0), vec(2, 0, 0)]), vec(1, 3, 0))");
  await d.openPage("Math");
  const shows = (id, want) => eventually(async () => (await d.el(id).textContent()).trim() === want, async () => `${want}, not ${await d.el(id).textContent()}`);
  await shows(length, "5");
  await shows(pose, "2");
  await shows(unity, "1");
  await shows(missed, "true");
  await shows(shape, "3");

  // a name of it, offered after the dot with the rest of the language's
  await d.el(length).click();
  const field = d.field("Text");
  await field.click();
  await field.fill("");
  await page.keyboard.type("math.poseIn");
  const names = () => page.locator(".suggest .suggest-name").allTextContents();
  await eventually(async () => (await names()).includes("poseInverse"), async () => `poseInverse among ${await names()}`);
  await page.keyboard.press("Escape");
  check(await d.el(length).count() === 1, "the page stays");
}
