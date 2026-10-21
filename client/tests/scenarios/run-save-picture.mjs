// An operator saves what the camera shows: a right click on its picture in the run offers
// to save it, and the device gets a PNG of the frame. Elsewhere the browser keeps its menu.

export default async function ({ page, hmi, check, eventually }) {
  if (!hmi.state.imports.some((i) => i.alias === "Camera")) await hmi.import("Camera", "Cell/Camera");
  const pageId = await hmi.addPage("Snapshot");
  const shot = await hmi.addElement(pageId, "media", { name: "camera", x: "4", y: "4", w: "32", h: "24", src: "Camera", fit: '"meet"' });
  await page.locator(".tab", { hasText: "Design" }).click();
  await page.locator(".screen:not([hidden]) .pages .list-row", { hasText: "Snapshot" }).click();
  await page.locator(".tab", { hasText: "Run" }).click();
  const picture = page.locator(`.run-layer:not([hidden]) .el[data-id="${shot}"]`);
  // the transcoder probes a new camera for 3 s, and the first frame waits for a keyframe
  await eventually(async () => (await picture.locator("video").count()) === 1 && (await picture.locator("video").evaluate((v) => v.videoWidth)) === 160, "the camera's video", 20000);

  await picture.click({ button: "right" });
  const saved = page.waitForEvent("download");
  await page.locator(".popover.menu .menu-item", { hasText: "Save picture" }).click();
  const file = await saved;
  check(file.suggestedFilename() === "camera.png", `the picture saved as ${file.suggestedFilename()}`);
  const bytes = await (await file.createReadStream()).toArray();
  const head = Buffer.concat(bytes).subarray(0, 8).toString("hex");
  check(head === "89504e470d0a1a0a", `the file is not a PNG: ${head}`);

  await page.locator(".run-layer:not([hidden]) .run-page").click({ button: "right", position: { x: 600, y: 500 } });
  check((await page.locator(".popover.menu").count()) === 0, "a menu opened away from any picture");
}
