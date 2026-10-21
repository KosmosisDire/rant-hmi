// A user adds an accent token, uses it on a page and inside a component, switches the editor
// to light and sees the light value, then renames the token: pages and components follow. A
// token may be worked out from another, its light value left as the dark one, a number counts
// in units, and tokens that read each other in a ring say they cannot be worked out.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const field = (label) => right.locator(".field", { has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) }).locator("input");
  const set = async (label, text) => {
    await field(label).fill(text);
    await field(label).press("Enter");
  };
  await page.locator("button", { hasText: "Add a token" }).click();
  await right.locator(".head-title", { hasText: "$color" }).waitFor();
  await set("Name", "accent");
  await right.locator(".head-title", { hasText: "$accent" }).waitFor();
  await set("Dark", "#ff8800");
  await set("Light", "#0088ff");
  await page.locator(".data-detail tr", { hasText: "$accent" }).waitFor();

  const pageId = await hmi.addPage("Themed");
  const frame = await hmi.addElement(pageId, "div", { name: "Box", x: "44", y: "44", w: "176", h: "88", background: "$accent" });
  const badge = await hmi.addComponent("Badge");
  await hmi.addElement(badge, "div", { name: "Dot", x: "0", y: "0", w: "88", h: "88", background: "$accent" });
  const inst = await hmi.addElement(pageId, "use", { name: "Badge", x: "264", y: "44", w: "88", h: "88" }, null, "Badge");

  await d.openPage("Themed");
  const colour = (loc) => loc.evaluate((e) => getComputedStyle(e).backgroundColor);
  const dot = d.el(inst).locator(".instance .el");
  await eventually(async () => (await colour(d.el(frame))) === "rgb(255, 136, 0)", "the page to read the dark value");
  check((await colour(dot)) === "rgb(255, 136, 0)", "a component cannot read the theme");

  await page.locator('button[title="Switch the theme"]').click();
  await eventually(async () => (await colour(d.el(frame))) === "rgb(0, 136, 255)", "the light value in light mode");
  await page.locator('button[title="Switch the theme"]').click();

  await d.el(frame).click();
  const fill = d.field("Fill");
  await fill.click();
  await fill.fill("$");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).includes("$accent"), "completion to offer the token");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await d.tab("Data");
  await page.locator(".data-detail tr", { hasText: "$accent" }).click();
  await set("Name", "brand");
  await eventually(() => hmi.page(pageId).children.find((e) => e.id === frame)?.props.background === "$brand", "the page to follow the rename");
  await eventually(() => hmi.page(badge).children[0].props.background === "$brand", "the component to follow the rename");

  // worked out from another, the light value the dark one's own working out
  await page.locator("button", { hasText: "Add a token" }).click();
  await right.locator(".head-title", { hasText: "$color" }).waitFor();
  await set("Name", "brandSoft");
  await right.locator(".head-title", { hasText: "$brandSoft" }).waitFor();
  await set("Dark", "$brand.alpha(0.5)");
  await set("Light", "");
  await eventually(() => hmi.state.tokens.some((t) => t.name === "brandSoft" && t.dark === "$brand.alpha(0.5)" && t.light === ""), "the token worked out from $brand");
  hmi.send({ type: "set_token", name: "pad", token: { name: "pad", dark: "1.5", light: "" } });
  const soft = await hmi.addElement(pageId, "div", { name: "Soft", x: "4", y: "16", w: "8", h: "8", background: "$brandSoft", "border-radius": "$pad" });
  await d.openPage("Themed");
  await eventually(async () => (await colour(d.el(soft))) === "rgba(255, 136, 0, 0.5)", "the soft colour in dark");
  check((await d.el(soft).evaluate((e) => getComputedStyle(e).borderTopLeftRadius)) === "15px", "a number token does not count in units");
  await page.locator('button[title="Switch the theme"]').click();
  await eventually(async () => (await colour(d.el(soft))) === "rgba(0, 136, 255, 0.5)", "the soft colour worked out from the light $brand");
  await page.locator('button[title="Switch the theme"]').click();
  hmi.send({ type: "set_token", name: "ringA", token: { name: "ringA", dark: "$ringB", light: "" } });
  hmi.send({ type: "set_token", name: "ringB", token: { name: "ringB", dark: "$ringA", light: "" } });
  await d.tab("Data");
  await page.locator(".data-detail tr", { hasText: "$ringA" }).getByText("cannot be worked out").first().waitFor();

  // a page's fill reads the theme too, so the ground follows light and dark
  await page.locator("button", { hasText: "Add a token" }).click();
  await right.locator(".head-title", { hasText: "$color" }).waitFor();
  await set("Name", "ground");
  await right.locator(".head-title", { hasText: "$ground" }).waitFor();
  await set("Dark", "#101418");
  await set("Light", "#f4f4f4");
  await d.openPage("Themed");
  await page.keyboard.press("Escape");
  await d.setField("Fill", "$ground");
  await eventually(() => hmi.page(pageId).fill === "$ground", "the page's fill");
  const ground = () =>
    page.evaluate(() => {
      const c = document.querySelector(".artboard-grid");
      const [sheet, host] = [document.querySelector(".artboard .page").getBoundingClientRect(), c.getBoundingClientRect()];
      const at = (v) => Math.round((v + 3) * devicePixelRatio);
      return [...c.getContext("2d").getImageData(at(sheet.left - host.left), at(sheet.top - host.top), 1, 1).data.slice(0, 3)].join();
    });
  await eventually(async () => (await ground()) === "16,20,24", "the artboard to draw the dark fill");
  await page.locator('button[title="Switch the theme"]').click();
  await eventually(async () => (await ground()) === "244,244,244", "the artboard to draw the light fill");
  await page.locator('button[title="Switch the theme"]').click();
  await d.tab("Run");
  const run = page.locator(".run-layer:not([hidden]) .page");
  await eventually(async () => (await colour(run)) === "rgb(16, 20, 24)", "the running page to show its fill");
}
