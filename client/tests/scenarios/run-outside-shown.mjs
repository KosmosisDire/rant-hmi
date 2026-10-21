// An element hears outside only while its page shows: a press elsewhere on the running page
// or on the editor's tabs counts, one on another tab of the editor or on a page opened over
// it does not.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const name of ["shownOutside", "shownMark", "shownHere"]) hmi.send({ type: "set_variable", name, variable: { name, start: 0, per: "hmi" } });
  const box = (pageId, name, x) => hmi.addElement(pageId, "div", { name, x, y: "4", w: "16", h: "8", background: "#2a2f35" });
  const covered = await hmi.addPage("Covered");
  const cover = await hmi.addPage("Cover");
  const menu = await box(covered, "Menu", "4");
  await hmi.setHandler(covered, menu, "outside", "shownOutside = shownOutside + 1;");
  const mark = await box(covered, "Mark", "24");
  await hmi.setHandler(covered, mark, "tap", "shownMark = shownMark + 1;");
  const go = await box(covered, "Go", "44");
  await hmi.setHandler(covered, go, "tap", "open(Pages.Cover);");
  const here = await box(cover, "Here", "4");
  await hmi.setHandler(cover, here, "tap", "shownHere = shownHere + 1;");
  const shared = (name) => hmi.state.values[name]?.value;
  // ids count per page, so the page names which
  const drawn = (pageId, id) => page.locator(`.run-layer:not([hidden])[data-page="${pageId}"] .el[data-id="${id}"]`);

  await d.openPage("Covered");
  await d.tab("Run");
  await drawn(covered, mark).click();
  await eventually(() => shared("shownMark") === 1 && shared("shownOutside") === 1, () => `a press on Mark to count outside Menu, ${shared("shownOutside")}`);

  // the tab press goes down while the run shows, the presses on Data while it is hidden
  await d.tab("Data");
  await eventually(() => shared("shownOutside") === 2, () => `the Data tab's press to count outside Menu, ${shared("shownOutside")}`);
  for (let n = 0; n < 2; n++) await page.locator(".screen:not([hidden]) .sidebar.left").click();
  await d.tab("Run");
  await drawn(covered, mark).click();
  await eventually(() => shared("shownMark") === 2, "a second press on Mark");
  check(shared("shownOutside") === 3, `presses on a hidden run counted outside Menu, ${shared("shownOutside")} where 3 was due`);

  // a page opened over Covered hides it
  await drawn(covered, go).click();
  await drawn(cover, here).click();
  await eventually(() => shared("shownHere") === 1, "a press on Here");
  check(shared("shownOutside") === 4, `a press on Cover counted outside Menu on the page it covers, ${shared("shownOutside")} where 4 was due`);
}
