// A user browses the mesh: an entity that holds others is one row, picked by a press and opened
// by its caret, with what it holds beneath it, never a folder of its own beside it.

export default async function ({ page, d, check, eventually }) {
  await d.tab("Objects");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  await left.locator(".list-row.branch", { hasText: /^Cell\/$/ }).click();
  const camera = left.locator('.list-row[title="Cell/Camera"]');
  const exposure = left.locator('.list-row[title="Cell/Camera/Exposure"]');
  await camera.waitFor();
  check((await left.locator(".list-row.branch", { hasText: /^Camera\/$/ }).count()) === 0, "the camera has a folder of its own");
  check((await exposure.count()) === 0, "what the camera holds shows before it is opened");

  await camera.locator(".open-caret").click();
  await exposure.waitFor();
  check(!(await camera.getAttribute("class")).includes("selected"), "the caret picked the camera");
  const [outer, inner] = [await camera.locator(".list-label").boundingBox(), await exposure.locator(".list-label").boundingBox()];
  check(inner.x > outer.x && inner.y > outer.y, "what it holds sits under it, further in");

  await camera.locator(".list-label").click();
  await eventually(async () => (await camera.getAttribute("class")).includes("selected"), "a press on the row to pick the camera");
  check((await exposure.count()) === 1, "picking the camera closed it");
  await camera.locator(".open-caret").click();
  await eventually(async () => (await exposure.count()) === 0, "the caret to close it");
}
