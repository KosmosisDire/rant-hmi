// A user moves about the editor, then steps back and forward: switching tabs, opening pages and
// a component each make a step, the browser's back undoes one, the top bar's arrows do the same
// both ways and dim at either end, and a reload keeps the place and its history.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.addPage("Hist one");
  await hmi.addPage("Hist two");
  await hmi.addComponent("HistPart");
  const back = page.locator('.topbar button[title^="Back"]');
  const forward = page.locator('.topbar button[title^="Forward"]');
  const where = async () => {
    const tab = (await page.locator(".tab.on span:not(.count)").textContent()).trim();
    const open = page.locator(".screen:not([hidden]) .pages :is(.list-row, .card).selected .list-label");
    return tab === "Design" ? `Design ${(await open.count()) ? (await open.first().textContent()).trim() : ""}` : tab;
  };
  const at = async (want, what) => {
    let seen = "";
    await eventually(async () => (seen = await where()) === want, () => `${what}: at ${want}, not ${seen}`);
  };
  check(await back.isDisabled(), "back is offered before any move");

  await d.openPage("Hist one");
  await d.openPage("Hist two");
  await page.locator(".screen:not([hidden]) .sidebar.left .card", { hasText: /^HistPart$/ }).click();
  await d.tab("Logic");
  await at("Logic", "the last move");
  check(await forward.isDisabled(), "forward is offered at the newest place");

  await page.goBack();
  await at("Design HistPart", "back from Logic");
  await page.goBack();
  await at("Design Hist two", "back out of the component");
  await back.click();
  await at("Design Hist one", "the top bar's back");
  await forward.click();
  await at("Design Hist two", "the top bar's forward");

  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await at("Design Hist two", "the place after a reload");
  await back.click();
  await at("Design Hist one", "back after a reload");
  await forward.click();
  await at("Design Hist two", "forward after a reload");
  // a new move from here drops what lay forward
  await d.tab("Data");
  await at("Data", "a new move");
  check(await forward.isDisabled(), "forward is still offered after a new move");
}
