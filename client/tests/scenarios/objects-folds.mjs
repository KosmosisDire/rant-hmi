// The Objects tab's sidebar is one tree: Hmi and Theme, then an Objects and a Pages folder, each
// a row with a folder icon. A press closes or opens a folder, a reload keeps it so, and the
// Objects folder's + adds an object.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.openObject("Hmi");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const folder = (name) => left.locator(`.list-row[data-folder-kind="${name.toLowerCase()}"][data-folder=""]`);
  const objects = left.locator('.list-row[data-object="Line"]');
  check((await left.locator(".pane-head").count()) === 0, "the tree has a head above it");
  await objects.waitFor();
  const [hmiRow, line] = [await left.locator(`.list-row[data-object="Hmi"]`).boundingBox(), await objects.locator(".list-label").boundingBox()];
  check(line.x > hmiRow.x + 10, "an object does not sit inside its folder");

  await folder("Objects").click();
  await eventually(async () => (await objects.count()) === 0, "the Objects folder to close");
  await left.locator(".list-row[data-page]").first().waitFor();

  // a reload keeps the folder closed
  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.tab("Objects");
  await folder("Objects").waitFor();
  check((await objects.count()) === 0, "a reload opened the Objects folder");
  await folder("Objects").click();
  await objects.waitFor();

  // the folder's + adds an object
  const before = hmi.state.objects.length;
  await folder("Objects").hover();
  await folder("Objects").locator('button[title="Add an object"]').click();
  await eventually(() => hmi.state.objects.length === before + 1, "a new object");
  const made = hmi.state.objects.find((o) => o.name.startsWith("NewObject"));
  await hmi.send({ type: "set_object", name: made.name, object: null });
}
