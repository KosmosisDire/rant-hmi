// A user imports a camera that sends MJPEG video frames: its frames show on the Data tab as
// they come, and an image showing it on a page paints them too.

export default async function ({ page, hmi, d, eventually }) {
  await d.tab("Data");
  const row = await d.meshRow("Cell/Inspection");
  if ((await row.locator(".row-add").count()) > 0) await row.locator(".row-add").click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Inspection"), "Inspection imported");
  const preview = page.locator(".screen:not([hidden]) tr.row", { hasText: "Inspection" }).locator("canvas");
  await eventually(async () => (await preview.count()) === 1 && (await preview.evaluate((c) => c.width)) === 160, "the frames on the Data tab");

  await d.addPage("Inspection view");
  const image = await d.add("image", { Name: "inspection", x: "44", y: "44", w: "320", h: "240", Source: "Inspection" });
  const view = d.el(image).locator("canvas");
  await eventually(async () => (await view.count()) === 1 && (await view.evaluate((c) => c.width)) === 160, "the frames on the page");
}
