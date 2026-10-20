// A user imports a camera that sends MJPEG video frames: its frames show on the Data tab as
// they come, media showing it plays the transcoder's H264, and media showing a frame an
// expression gives draws it as a picture.

export default async function ({ page, hmi, d, eventually }) {
  await d.tab("Data");
  const row = await d.meshRow("Cell/Inspection");
  if ((await row.locator(".row-add").count()) > 0) await row.locator(".row-add").click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Inspection"), "Inspection imported");
  const preview = page.locator(".screen:not([hidden]) tr.row", { hasText: "Inspection" }).locator("canvas");
  await eventually(async () => (await preview.count()) === 1 && (await preview.evaluate((c) => c.width)) === 160, "the frames on the Data tab");

  await d.addPage("Inspection view");
  const video = await d.add("media", { Name: "inspection", x: "44", y: "44", w: "320", h: "240", Source: "Inspection" });
  const player = d.el(video).locator("video");
  await eventually(async () => (await player.count()) === 1 && (await player.evaluate((v) => v.videoWidth)) === 160, "the H264 on the page", 20000);
  const frame = await d.add("media", { Name: "frame", x: "440", y: "44", w: "320", h: "240", Source: "({ ...Inspection })" });
  const view = d.el(frame).locator("canvas");
  await eventually(async () => (await view.count()) === 1 && (await view.evaluate((c) => c.width)) === 160, "the frame drawn as a picture");
}
