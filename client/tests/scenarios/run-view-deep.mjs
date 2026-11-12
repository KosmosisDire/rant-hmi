// A handler on a page shown two views deep runs, as one a view deep does: a tap, and a drag on a
// scene that turns its camera.

export default async function ({ page, hmi, sys, check, eventually }) {
  const leaf = await hmi.addPage("Deep leaf");
  await hmi.edit({ kind: "set_state", page: leaf, id: null, name: "count", var: { name: "count", start: 0, per: "screen" } });
  await hmi.addElement(leaf, "span", { name: "Count", x: "1", y: "1", w: "20", h: "4", text: '"Count " + count' });
  const bump = await hmi.addElement(leaf, "div", { name: "Bump", x: "1", y: "6", w: "10", h: "4", background: "$accent" });
  await hmi.setHandler(leaf, bump, "tap", "count = count + 1;");
  const scene = await hmi.addElement(leaf, "scene", { name: "Deep scene", x: "20", y: "1", w: "30", h: "20", yaw: "count / 10" });
  await hmi.setHandler(leaf, scene, "drag", "count = count + 100;", {}, { button: "any" });
  // a part with no handler of its own under the pointer leaves the drag to the scene
  const block = await hmi.addComponent("DeepBlock", "3d");
  await hmi.addElement(block, "box", { name: "block", size: "vec(3, 3, 3)" });
  await hmi.addElement(leaf, "use", { name: "Block", pose: "{}" }, scene, "DeepBlock");
  const middle = await hmi.addPage("Deep middle");
  await hmi.addElement(middle, "view", { name: "Inner", x: "0", y: "0", w: "60", h: "30", page: "Pages.DeepLeaf" });
  const top = await hmi.addPage("Deep top");
  await hmi.addElement(top, "view", { name: "Outer", x: "0", y: "0", w: "80", h: "40", page: "Pages.DeepMiddle" });

  await page.goto(`${sys.url}/run/${top}`);
  const count = page.locator('.run-layer:not([hidden]) [data-name="Count"]');
  await count.getByText("Count 0").waitFor({ timeout: 4000 });
  await page.locator('.run-layer:not([hidden]) [data-name="Bump"]').click();
  await eventually(async () => (await count.textContent()) === "Count 1", "a tap two views deep to count");
  const b = await page.locator('.run-layer:not([hidden]) [data-name="Deep scene"]').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(b.x + b.width / 2 + i * 10, b.y + b.height / 2);
  await page.mouse.up();
  let seen = "";
  await eventually(async () => Number((seen = await count.textContent()).slice(6)) > 100, () => `a drag on a scene two views deep to run, it shows ${seen}`);
  check(true, "");
}
