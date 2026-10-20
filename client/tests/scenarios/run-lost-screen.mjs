// An operator holds a jog button on a second screen, and that screen goes away mid press, as a
// tablet does when its wifi drops. The jog's release still runs, so the line never keeps
// jogging for a screen that is gone.

export default async function ({ page, hmi, sys, d, eventually }) {
  const pageId = await hmi.addPage("Jog");
  const jog = await hmi.addElement(pageId, "div", { name: "Jog", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.setHandler(pageId, jog, "press", "Speed = 2;");
  await hmi.setHandler(pageId, jog, "release", "Speed = 0.25;");
  await hmi.set("Speed", 0.25);
  await d.openPage("Jog");
  await page.locator(".pages .list-row.selected").waitFor();

  const other = await page.context().browser().newContext({ viewport: { width: 1200, height: 800 } });
  const tablet = await other.newPage();
  await tablet.goto(sys.url);
  await tablet.locator(".tab", { hasText: "Run" }).click();
  await tablet.locator(".pages .list-row").first().waitFor({ state: "attached" });
  await tablet.evaluate((id) => localStorage.setItem("rant-hmi.page", id), pageId);
  await tablet.reload();
  const button = tablet.locator(`.run-layer:not([hidden]) .el[data-id="${jog}"]`);
  const b = await button.boundingBox();
  await tablet.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await tablet.mouse.down();
  await eventually(() => hmi.state.values.Speed?.value === 2, "the jog to run while held");

  await other.close();
  await eventually(() => hmi.state.values.Speed?.value === 0.25, "the jog to stop when its screen went away");
}
