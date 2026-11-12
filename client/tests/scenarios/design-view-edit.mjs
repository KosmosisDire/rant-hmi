// A designer edits a page where a view shows it on the board, as they would go into a frame: a
// press picks the view, a press again picks what lies there on the page it shows, laid out at the
// view's size, and that page's own artboard stays where it is. Escape steps out with the view
// picked, a press on the page's own artboard edits it there, and the view's chip picks another
// page to show there.

export default async function ({ page, hmi, d, check, eventually }) {
  const insetId = await hmi.addPage("Inset");
  const box = await hmi.addElement(insetId, "div", { name: "Box", x: "2", y: "2", w: "10", h: "6", background: "$accent" });
  const spareId = await hmi.addPage("Spare");
  await hmi.addElement(spareId, "span", { name: "Words", x: "1", y: "1", w: "20", h: "4", text: '"Spare page"' });
  const frameId = await hmi.addPage("Frame");
  await hmi.addElement(frameId, "div", { name: "Corner", x: "1", y: "1", w: "10", h: "6", background: "$panel3" });
  const well = await hmi.addElement(frameId, "view", { name: "Well", x: "20", y: "10", w: "40", h: "30", page: "Pages.Inset" });
  await d.openPage("Frame");

  const open = page.locator(".artboard .page-layer.open");
  const home = (id) => page.locator(`.artboard .page-layer[data-page="${id}"]:not(.open)`).first();
  const onFrame = (id) => page.locator(`.artboard .page-layer[data-page="${frameId}"] .el[data-id="${id}"]`);
  const selected = () => page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id");
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  const insetHome = await home(insetId).boundingBox();

  // a press picks the view, a press again picks the box on the page it shows, there
  const inner = d.el(well).locator('[data-name="Box"]');
  await inner.click({ force: true });
  await eventually(async () => (await selected()) === well, "a press to pick the view");
  await inner.click({ force: true });
  await eventually(async () => (await open.getAttribute("data-page")) === insetId && (await selected()) === box, "a press again to pick the box on the inset");
  const [sheet, frame] = [await open.locator(":scope > .page").boundingBox(), await onFrame(well).boundingBox()];
  check(near(sheet.x, frame.x) && near(sheet.y, frame.y) && near(sheet.width, frame.width) && near(sheet.height, frame.height), `the inset is edited at ${JSON.stringify(sheet)}, not in the view at ${JSON.stringify(frame)}`);
  const stays = await home(insetId).boundingBox();
  check(near(stays.x, insetHome.x) && near(stays.y, insetHome.y), "the inset's own artboard moved");
  check((await onFrame(well).locator(".page").count()) === 0, "the view still draws the page edited over it");

  await d.drag(box, 60, 0);
  const x = () => Number(hmi.page(insetId).children.find((e) => e.id === box).props.x);
  await eventually(async () => x() > 2, "a drag in the view to move the inset's box");

  // Escape lets go, then steps out with the view picked
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await eventually(async () => (await open.getAttribute("data-page")) === frameId && (await selected()) === well, "Escape to step out to the view");
  await eventually(async () => (await d.el(well).locator('[data-name="Box"]').count()) === 1, "the view to draw its page again");

  // a press on the inset's own artboard edits it there
  await inner.click({ force: true });
  await eventually(async () => (await open.getAttribute("data-page")) === insetId, "a press again to go into the view");
  // every page in sight, the inset's own artboard below the frame
  await page.keyboard.press("Shift+Digit1");
  await d.landed();
  const own = await home(insetId).boundingBox();
  await page.mouse.click(own.x + own.width * 0.8, own.y + own.height * 0.8);
  await eventually(async () => {
    const b = await open.boundingBox();
    return near(b.x, own.x) && near(b.y, own.y);
  }, "a press on the inset's own artboard to edit it there");

  // the chip picks what the board shows in the view, and the page's file keeps its expression
  await d.openPage("Frame");
  await d.pick(well);
  const chip = page.locator(".artboard .view-chip");
  await eventually(async () => (await chip.textContent()) === "Inset", "the chip to name the inset");
  await chip.click();
  await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: /^Spare$/ }) }).click();
  await eventually(async () => (await d.el(well).locator('[data-name="Words"]').count()) === 1, "the chip to show the spare page in the view");
  check(hmi.page(frameId).children.find((e) => e.id === well).props.page === "Pages.Inset", "the chip changed the view's page property");
  await d.el(well).dblclick();
  await eventually(async () => (await open.getAttribute("data-page")) === spareId, "a double click to edit the page the chip picked");
}
