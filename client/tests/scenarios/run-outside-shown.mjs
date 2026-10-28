// An element hears outside only while its page shows: a press elsewhere on the running page
// or on the editor's tabs counts, one on another tab of the editor or on a page opened over
// it does not.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const name of ["Hmi.shownOutside", "Hmi.shownMark", "Hmi.shownHere"]) hmi.setVariable(name, 0);
  const box = (pageId, name, x) => hmi.addElement(pageId, "div", { name, x, y: "4", w: "16", h: "8", background: "#2a2f35" });
  const covered = await hmi.addPage("Covered");
  const cover = await hmi.addPage("Cover");
  const menu = await box(covered, "Menu", "4");
  await hmi.setHandler(covered, menu, "outside", "Hmi.shownOutside = Hmi.shownOutside + 1;");
  const mark = await box(covered, "Mark", "24");
  await hmi.setHandler(covered, mark, "tap", "Hmi.shownMark = Hmi.shownMark + 1;");
  const go = await box(covered, "Go", "44");
  await hmi.setHandler(covered, go, "tap", "open(Pages.Cover);");
  const here = await box(cover, "Here", "4");
  await hmi.setHandler(cover, here, "tap", "Hmi.shownHere = Hmi.shownHere + 1;");
  const shared = (name) => hmi.state.values[name]?.value;
  // ids count per page, so the page names which
  const drawn = (pageId, id) => page.locator(`.run-layer:not([hidden])[data-page="${pageId}"] .el[data-id="${id}"]`);

  await d.openPage("Covered");
  await d.tab("Run");
  await drawn(covered, mark).click();
  await eventually(() => shared("Hmi.shownMark") === 1 && shared("Hmi.shownOutside") === 1, () => `a press on Mark to count outside Menu, ${shared("Hmi.shownOutside")}`);

  // the tab press goes down while the run shows, the presses on Objects while it is hidden
  await d.tab("Objects");
  await eventually(() => shared("Hmi.shownOutside") === 2, () => `the Objects tab's press to count outside Menu, ${shared("Hmi.shownOutside")}`);
  for (let n = 0; n < 2; n++) await page.locator(".screen:not([hidden]) .sidebar.left").click();
  await d.tab("Run");
  await drawn(covered, mark).click();
  await eventually(() => shared("Hmi.shownMark") === 2, "a second press on Mark");
  check(shared("Hmi.shownOutside") === 3, `presses on a hidden run counted outside Menu, ${shared("Hmi.shownOutside")} where 3 was due`);

  // a page opened over Covered hides it
  await drawn(covered, go).click();
  await drawn(cover, here).click();
  await eventually(() => shared("Hmi.shownHere") === 1, "a press on Here");
  check(shared("Hmi.shownOutside") === 4, `a press on Cover counted outside Menu on the page it covers, ${shared("Hmi.shownOutside")} where 4 was due`);
}
