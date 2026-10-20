// A designer shows a camera with what a detector found, in the editor alone: imports the
// camera and its detections from the mesh tree, adds an image of the camera, and a drawing
// over it in the picture's pixels with a rectangle repeated for each box. Running, each
// rectangle sits on the part the camera sees.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  for (const name of ["Camera", "Detections"]) {
    const row = page.locator(".screen:not([hidden]) .sidebar.left .list-row", { has: page.locator(".list-label", { hasText: new RegExp(`^${name}$`) }) });
    if ((await row.locator(".row-add").count()) > 0) await row.locator(".row-add").click();
    await eventually(() => hmi.state.imports.some((i) => i.alias === name), `${name} imported`);
  }

  await d.addPage("Camera view");
  const box = { x: "44", y: "44", w: "480", h: "360" };
  const image = await d.add("image", { Name: "camera", ...box, Source: "Camera" });
  await d.add("drawing", { Name: "overlay", ...box, "View box": "`0 0 ${Camera.width} ${Camera.height}`", Fit: '"meet"' });
  await d.addShape("rect", {
    Name: "found",
    x: "item.min.x",
    y: "item.min.y",
    Width: "item.max.x - item.min.x",
    Height: "item.max.y - item.min.y",
    Fill: '"none"',
    Stroke: "#4a8fd6",
    Thickness: "2",
  });
  await d.setField("Repeat", "Detections.boxes");
  await d.css('vector-effect: "non-scaling-stroke"');

  await d.tab("Run");
  const view = page.locator(`.run-layer:not([hidden]) .el[data-id="${image}"] canvas`);
  await eventually(async () => (await view.evaluate((c) => c.width)) === 160, "the camera's frames on the page");
  const found = page.locator('.run-layer:not([hidden]) [data-name="found"]');
  await eventually(async () => (await found.count()) === 1, "a rectangle for the one box");

  // the canvas's pixel under the rectangle's middle is the part's orange
  const colour = await page.evaluate(() => {
    const canvas = document.querySelector(".run-layer:not([hidden]) canvas");
    const rect = document.querySelector('.run-layer:not([hidden]) [data-name="found"]').getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    // the canvas's picture is drawn to fit its box whole, as the drawing's view box is
    const k = Math.min(c.width / canvas.width, c.height / canvas.height);
    const [left, top] = [c.left + (c.width - canvas.width * k) / 2, c.top + (c.height - canvas.height * k) / 2];
    const [x, y] = [(rect.left + rect.width / 2 - left) / k, (rect.top + rect.height / 2 - top) / k];
    return [...canvas.getContext("2d").getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3)];
  });
  check(colour[0] > 200 && colour[1] > 110 && colour[1] < 170 && colour[2] < 80, `under the rectangle is ${colour}, not the part`);
}
