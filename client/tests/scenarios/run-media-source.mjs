// A designer gives media its camera by an expression: one on the page shows Camera or LabelCam
// as Running says, and a component made in the editor shows the camera its input gives. Each
// plays the camera's video, follows the expression, and the screen gets none of its pictures.

import { countBig } from "../links.mjs";

export default async function ({ page, hmi, d, sys, check, eventually }) {
  check(sys.transcoder, "rant-transcoder is not built: build transcoder-rant or set HMI_TRANSCODER");
  for (const [alias, entity] of [["Camera", "Cell/Camera"], ["LabelCam", "Line1/LabelCam"]]) {
    if (!hmi.state.imports.some((i) => i.alias === alias)) await hmi.import(alias, entity);
  }
  hmi.set("Running", true);

  await d.addComponent("Feed", 32, 24);
  await d.addInput("camera", "null");
  await d.add("media", { Name: "view", x: "0", y: "0", w: "32", h: "24", Source: "camera" });

  await d.addPage("Camera pick");
  const picked = await d.add("media", { Name: "picked", x: "4", y: "4", w: "32", h: "24", Source: "Running ? Camera : LabelCam" });
  await d.deselect();
  const feed = await d.place("Feed", { x: "40", y: "4", camera: "Camera" });
  const pageId = hmi.state.pages.find((p) => p.name === "Camera pick").id;

  await d.tab("Run");
  const video = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"] video`);
  const width = async (id) => ((await video(id).count()) === 1 ? video(id).evaluate((v) => v.videoWidth) : 0);
  // the transcoder probes a new camera for 3 s, and the first frame waits for a keyframe
  await eventually(async () => (await width(picked)) === 160, "Camera's video, as Running is true", 20000);
  await eventually(async () => (await width(feed)) === 160, "Camera's video through the component's input", 20000);
  hmi.set("Running", false);
  await eventually(async () => (await width(picked)) === 960, "LabelCam's video once Running is false", 20000);

  // an operator on the page plays both cameras, which never needs their pictures
  const context = await page.context().browser().newContext();
  await context.addInitScript(countBig);
  try {
    const started = hmi.next((m) => m.type === "project");
    hmi.send({ type: "set_start", page: pageId });
    await started;
    const screen = await context.newPage();
    await screen.goto(`${sys.url}/run`);
    await eventually(async () => (await screen.locator(".run-layer video").count()) === 2, "both videos on the operator's screen", 10000);
    await screen.waitForTimeout(1000);
    const before = await screen.evaluate(() => window.__big ?? 0);
    await screen.waitForTimeout(1500);
    const pictures = (await screen.evaluate(() => window.__big ?? 0)) - before;
    check(pictures === 0, `the screen playing the cameras got ${pictures} of their pictures`);
  } finally {
    await context.close();
  }
}
