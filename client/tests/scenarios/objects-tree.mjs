// A user browses the mesh tree a Mesh section's + opens: an entity that holds others is one row,
// opened by its caret, with what it holds beneath it, never a folder of its own beside it.

export default async function ({ page, d, check, eventually }) {
  await d.openObject("Line");
  await page.locator('.screen:not([hidden]) .object-sheet button[title="Add from the mesh"]').click();
  const tree = page.locator(".popover.mesh-picker");
  await tree.locator(".list-row.folder", { hasText: /^Cell$/ }).click();
  const camera = tree.locator('.list-row[title="Cell/Camera"]');
  const exposure = tree.locator('.list-row[title="Cell/Camera/Exposure"]');
  await camera.waitFor();
  check((await tree.locator(".list-row.folder", { hasText: /^Camera$/ }).count()) === 0, "the camera has a folder of its own");
  check((await exposure.count()) === 0, "what the camera holds shows before it is opened");

  await camera.locator(".open-caret").click();
  await exposure.waitFor();
  check(await tree.isVisible(), "the caret picked the camera");
  const [outer, inner] = [await camera.locator(".list-label").boundingBox(), await exposure.locator(".list-label").boundingBox()];
  check(inner.x > outer.x && inner.y > outer.y, "what it holds sits under it, further in");
  await camera.locator(".open-caret").click();
  await eventually(async () => (await exposure.count()) === 0, "the caret to close it");
  await page.keyboard.press("Escape");
  await eventually(async () => !(await tree.isVisible()), "Escape to close the tree");
}
