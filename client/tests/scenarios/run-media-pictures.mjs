// Media shows a camera with no video of its own as pictures, so it reads all of the camera,
// though the page reads its width too, as an overlay sized to the picture does. A source that
// picks a camera by a condition reads the condition and either camera.

import { keepSent, told } from "../links.mjs";

// a system with no transcoder, so no camera has video of its own
export const video = false;

export default async function ({ page, hmi, sys, check, eventually }) {
  await hmi.import("Cam", "Cell/Camera");
  await hmi.import("Inspection", "Cell/Inspection");
  await hmi.import("Conveyor", "Line1/Conveyor");
  const id = await hmi.addPage("Pictures");
  const cam = await hmi.addElement(id, "media", { name: "cam", x: "2", y: "2", w: "32", h: "24", src: "Cam" });
  const size = await hmi.addElement(id, "span", { name: "size", x: "2", y: "28", w: "20", h: "4", text: "String(Cam.width)" });
  await hmi.addElement(id, "media", { name: "pick", x: "40", y: "2", w: "32", h: "24", src: "Conveyor.running ? Cam : Inspection" });
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: id });
  await started;

  const context = await page.context().browser().newContext();
  await context.addInitScript(keepSent);
  try {
    const p = await context.newPage();
    await p.goto(`${sys.url}/run`);
    const reads = ["Cam", "Cam.width", "Conveyor.running", "Inspection"];
    await eventually(async () => JSON.stringify(await told(p)) === JSON.stringify(reads), async () => `the page to read ${reads}, not ${await told(p)}`);
    const el = (eid) => p.locator(`.run-layer .el[data-id="${eid}"]`);
    await eventually(async () => (await el(cam).locator("canvas").count()) === 1 && (await el(cam).locator("canvas").evaluate((c) => c.width)) === 160, "the camera's picture beside its width");
    check(/^\d+$/.test(((await el(size).textContent()) ?? "").trim()), `the width reads ${await el(size).textContent()}`);
  } finally {
    await context.close();
  }
}
