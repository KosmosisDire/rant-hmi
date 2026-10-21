// An operator sees where a camera goes while it is missing or not up yet: the media shows the
// same mark the editor does, never an empty box.

export default async function ({ page, hmi, d, check }) {
  const pageId = await hmi.addPage("Waiting camera");
  const media = await hmi.addElement(pageId, "media", { name: "Camera", x: "40", y: "40", w: "320", h: "240", src: "Nowhere" });
  await d.openPage("Waiting camera");
  await d.tab("Run");
  const drawn = page.locator(`.run-layer:not([hidden]) .el[data-id="${media}"]`);
  await drawn.locator(".el-picture-none").waitFor();
  check((await drawn.locator("svg").count()) === 1, "the mark shows no icon");
}
