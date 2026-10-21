// A Run button asks a Confirm page shown over others: only Yes runs, Escape and a tap outside
// answer nothing, the page beneath stays in sight, and Confirm removed while open closes.

export default async function ({ page, hmi, d, check, eventually }) {
  const cell = await hmi.addPage("Cell");
  const confirm = await hmi.addPage("Confirm");
  const button = async (pageId, name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: String(x), y: "4", w: "16", h: "8", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const run = await button(cell, "Run", 4, 'if (!await open(Pages.Confirm)) {\n  notify("Not run");\n  return;\n}\nSpeed = 2;\nnotify("Running");');
  const yes = await button(confirm, "Yes", 4, "close(true);");
  const no = await button(confirm, "No", 24, "close(false);");

  await d.openPage("Confirm");
  const w = d.field("w");
  await w.fill("44");
  await w.press("Enter");
  const h = d.field("h");
  await h.fill("16");
  await h.press("Enter");
  await page.locator(".screen:not([hidden]) .sidebar.right .choice button", { hasText: "Over" }).click();
  await eventually(() => hmi.page(confirm)?.shows === "over" && hmi.page(confirm)?.width === 44, "Confirm to show over others");

  await d.openPage("Cell");
  await d.tab("Run");
  await hmi.set("Speed", 1);
  await eventually(() => hmi.state.values.Speed?.value === 1, "the speed to start at 1");
  const shown = () => page.locator(".run-layer:not([hidden])").evaluateAll((els) => els.map((e) => e.dataset.page).join());
  const tap = (pageId, id) => page.locator(`.run-layer[data-page="${pageId}"] .el[data-id="${id}"]`).click();
  const notice = (text) => page.locator(".notice", { hasText: text }).last().waitFor({ timeout: 4000 });
  const dismiss = () => page.locator(".notice button").evaluateAll((bs) => bs.forEach((b) => b.click()));
  const ask = async () => {
    await tap(cell, run);
    await eventually(async () => (await shown()) === `${cell},${confirm}`, "Confirm over Cell with Cell in sight");
  };

  await ask();
  check((await page.locator(".run-backdrop").count()) === 1, "no backdrop under Confirm");
  await tap(confirm, no);
  await notice("Not run");
  await eventually(async () => (await shown()) === cell, "No to close Confirm");
  check(hmi.state.values.Speed?.value === 1, "No ran the job");
  await dismiss();

  await ask();
  await tap(confirm, yes);
  await notice("Running");
  await eventually(() => hmi.state.values.Speed?.value === 2, "Yes to run the job");
  await dismiss();

  await ask();
  await page.keyboard.press("Escape");
  await notice("Not run");
  await dismiss();

  await ask();
  await page.mouse.click(10, 300);
  await notice("Not run");
  await eventually(async () => (await shown()) === cell, "a tap outside to close Confirm");
  await dismiss();

  await ask();
  hmi.send({ type: "edit", edit: { kind: "remove_page", page: confirm } });
  await notice("Not run");
  await eventually(async () => (await shown()) === cell, "a removed Confirm to close");
}
