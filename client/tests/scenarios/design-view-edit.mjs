// A designer double clicks a view on the board and edits the page it shows in its place, laid
// out at the view's size, the page around it dimmed. Escape steps out with the view picked, a
// press on the page around goes back to it, and the view's chip picks another page to show there.

export default async function ({ page, hmi, d, check, eventually }) {
  const panelId = await hmi.addPage("Inset");
  const box = await hmi.addElement(panelId, "div", { name: "Box", x: "2", y: "2", w: "10", h: "6", background: "$accent" });
  const otherId = await hmi.addPage("Spare");
  await hmi.addElement(otherId, "span", { name: "Words", x: "1", y: "1", w: "20", h: "4", text: '"Spare page"' });
  const hostId = await hmi.addPage("Frame");
  const corner = await hmi.addElement(hostId, "div", { name: "Corner", x: "1", y: "1", w: "10", h: "6", background: "$panel3" });
  const well = await hmi.addElement(hostId, "view", { name: "Well", x: "20", y: "10", w: "40", h: "30", page: "Pages.Inset" });
  await d.openPage("Frame");

  const open = page.locator(".artboard .page-layer.open");
  const onHost = (id) => page.locator(`.artboard .page-layer[data-page="${hostId}"] .el[data-id="${id}"]`);
  const selected = () => page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id");
  const near = (a, b) => Math.abs(a - b) <= 1.5;

  // a double click edits the page the view shows, where the view is, at its size
  await d.el(well).dblclick();
  await eventually(async () => (await open.getAttribute("data-page")) === panelId, "the double click to edit the panel in its view");
  const [sheet, frame] = [await open.locator(":scope > .page").boundingBox(), await onHost(well).boundingBox()];
  check(near(sheet.x, frame.x) && near(sheet.y, frame.y) && near(sheet.width, frame.width) && near(sheet.height, frame.height), `the panel is edited at ${JSON.stringify(sheet)}, not in the view at ${JSON.stringify(frame)}`);
  check((await onHost(well).locator(".page").count()) === 0, "the view still draws the page edited over it");
  const label = page.locator(".artboard .board-label.open");
  check((await label.textContent()).includes("Inset"), `the label names ${await label.textContent()}, not the page edited`);

  await d.drag(box, 60, 0);
  const x = () => Number(hmi.page(panelId).children.find((e) => e.id === box).props.x);
  await eventually(async () => x() > 2, "a drag in the view to move the panel's box");

  // Escape lets go, then steps out with the view picked
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await eventually(async () => (await open.getAttribute("data-page")) === hostId && (await selected()) === well, "Escape to step out to the view");
  await eventually(async () => (await d.el(well).locator('[data-name="Box"]').count()) === 1, "the view to draw its page again");

  // a press on the page around goes back to it
  await d.el(well).dblclick();
  await eventually(async () => (await open.getAttribute("data-page")) === panelId, "a second double click");
  await onHost(corner).click({ force: true });
  await eventually(async () => (await open.getAttribute("data-page")) === hostId && (await selected()) === corner, "a press on the page around to open it");

  // the chip picks what the board shows in the view, and the page's file keeps its expression
  await d.pick(well);
  const chip = page.locator(".artboard .view-chip");
  await eventually(async () => (await chip.textContent()) === "Inset", "the chip to name the inset");
  await chip.click();
  await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: /^Spare$/ }) }).click();
  await eventually(async () => (await d.el(well).locator('[data-name="Words"]').count()) === 1, "the chip to show the other page in the view");
  check(hmi.page(hostId).children.find((e) => e.id === well).props.page === "Pages.Inset", "the chip changed the view's page property");
  await d.el(well).dblclick();
  await eventually(async () => (await open.getAttribute("data-page")) === otherId, "a double click to edit the page the chip picked");

  // the label of the page edited in place switches it
  await label.click();
  await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: /^Inset$/ }) }).click();
  await eventually(async () => (await open.getAttribute("data-page")) === panelId, "the label's menu to edit the panel there instead");
  await page.keyboard.press("Escape");
  await eventually(async () => (await open.getAttribute("data-page")) === hostId, "Escape to step out again");
}
