// The objects and the mesh share the Objects tab's left sidebar, each scrolling apart. A user
// folds either away by its head to give the other the whole sidebar, and a reload keeps what
// was folded.

export default async function ({ page, d, check, eventually }) {
  await d.openObject("Hmi");
  const left = page.locator(".screen:not([hidden]) .sidebar.left");
  const head = (title) => left.locator(".pane-head", { has: page.locator(".fold", { hasText: new RegExp(`^${title}$`) }) });
  const list = left.locator(".objects-list");
  const filter = left.locator(".mesh-filter");
  const box = async (locator) => locator.boundingBox();

  // both open, the objects keep to their share and the mesh has the rest
  const side = await box(left);
  check((await box(list)).height <= side.height * 0.4 + 1, "the objects take more than their share");
  check(await filter.isVisible(), "the mesh is hidden");

  // the objects folded, the mesh rises under their head
  await head("Objects").locator(".fold").click();
  await eventually(async () => !(await list.isVisible()), "the objects to fold away");
  const [objects, mesh] = [await box(head("Objects")), await box(head("Mesh"))];
  check(Math.abs(mesh.y - (objects.y + objects.height)) < 2, `the mesh head sits ${mesh.y - objects.y - objects.height} px under the objects head`);
  check((await head("Objects").locator(".fold").getAttribute("aria-expanded")) === "false", "the folded head says it is open");

  // a reload keeps the fold
  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.tab("Objects");
  await filter.waitFor();
  check(!(await list.isVisible()), "a reload opened the objects");

  // the mesh folded, the objects have the sidebar
  await head("Objects").locator(".fold").click();
  await head("Mesh").locator(".fold").click();
  await eventually(async () => !(await filter.isVisible()) && (await list.isVisible()), "the mesh to fold away and the objects to show");
  check((await list.getAttribute("class")).includes("tall"), "the objects keep to their share with the mesh folded");
  await head("Mesh").locator(".fold").click();
  await filter.waitFor();
}
