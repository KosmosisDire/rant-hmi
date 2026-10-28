// A user moves about the editor, then steps back and forward with the browser's own buttons,
// which the top bar leaves to it: switching tabs, opening pages and a component each make a
// step, a reload keeps the place and its history, and a new move drops what lay forward.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.addPage("Hist one");
  await hmi.addPage("Hist two");
  await hmi.addComponent("HistPart");
  check((await page.locator('.topbar button[title^="Back"], .topbar button[title^="Forward"]').count()) === 0, "the top bar has back and forward of its own");
  const where = async () => {
    const tab = (await page.locator(".tab.on span:not(.count)").textContent()).trim();
    const open = page.locator(".screen:not([hidden]) :is(.page-row.open, .card.selected) .list-label");
    return tab === "Design" ? `Design ${(await open.count()) ? (await open.first().textContent()).trim() : ""}` : tab;
  };
  const at = async (want, what) => {
    let seen = "";
    await eventually(async () => (seen = await where()) === want, () => `${what}: at ${want}, not ${seen}`);
  };

  await d.openPage("Hist one");
  await d.openPage("Hist two");
  await page.locator(".screen:not([hidden]) .sidebar.left .card", { hasText: /^HistPart$/ }).click();
  await d.tab("Logic");
  await at("Logic", "the last move");

  await page.goBack();
  await at("Design HistPart", "back from Logic");
  await page.goBack();
  await at("Design Hist two", "back out of the component");
  await page.goBack();
  await at("Design Hist one", "back once more");
  await page.goForward();
  await at("Design Hist two", "forward");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await at("Design Hist two", "the place after a reload");
  await page.goBack();
  await at("Design Hist one", "back after a reload");
  await page.goForward();
  await at("Design Hist two", "forward after a reload");

  await page.goBack();
  await at("Design Hist one", "back before a new move");
  await d.tab("Data");
  await at("Data", "a new move");
  await page.goForward();
  await page.waitForTimeout(300);
  check((await where()) === "Data", `forward after a new move went to ${await where()}`);
}
