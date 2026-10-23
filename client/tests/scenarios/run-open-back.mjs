// Buttons that open each other's pages with await keep working: opening a page already open
// goes back to it, which closes the page the opener waits from, so that wait ends at once and
// never holds the button that started it.

export default async function ({ page, hmi, d, sys, eventually }) {
  const add = async (pageId, name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x, y: "44", w: "120", h: "88", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const home = await hmi.addPage("Home");
  const detail = await hmi.addPage("Detail");
  const extra = await hmi.addPage("Extra");
  const toDetail = await add(home, "To detail", "44", "await open(Pages.Detail);");
  const detailHome = await add(detail, "To home", "44", "await open(Pages.Home);");
  const detailExtra = await add(detail, "To extra", "200", "await open(Pages.Extra);");
  const extraDetail = await add(extra, "To detail", "44", "await open(Pages.Detail);");

  await d.openPage("Home");
  await d.menu(d.pageRow("Home"), "Make the start page");
  await d.pageRow("Home").locator(".tag", { hasText: "start" }).waitFor();

  await page.goto(`${sys.url}/run`);
  const showing = async () => {
    const layers = await page.locator(".run-layer").evaluateAll((els) => els.map((e) => [e.dataset.page, e.hidden]));
    return `${layers.find(([, hidden]) => !hidden)?.[0]}/${layers.length}`;
  };
  const tap = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`).click();
  await eventually(async () => (await showing()) === `${home}/1`, "the screen to open on Home");

  // back to the bottom page, which never closes
  for (const round of [1, 2, 3]) {
    await tap(toDetail);
    await eventually(async () => (await showing()) === `${detail}/2`, `Detail to open, round ${round}`);
    await tap(detailHome);
    await eventually(async () => (await showing()) === `${home}/1`, `Home to come back, round ${round}`);
  }

  // back to a page between, as a header of buttons does
  await tap(toDetail);
  await eventually(async () => (await showing()) === `${detail}/2`, "Detail to open for the header");
  for (const round of [1, 2, 3]) {
    await tap(detailExtra);
    await eventually(async () => (await showing()) === `${extra}/3`, `Extra to open, round ${round}`);
    await tap(extraDetail);
    await eventually(async () => (await showing()) === `${detail}/2`, `Detail to come back, round ${round}`);
  }
}
