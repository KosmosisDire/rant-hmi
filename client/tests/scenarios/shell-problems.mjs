// A user finds what is wrong: a page's fault and a handler's show in the status bar's count and
// in the problems list, whose row opens the element at fault. A fixed fault leaves by itself,
// what passed stays until cleared, and the HMI's own warning comes with its stack. Those of a
// run on the system and of another screen say where they came from, and an agent reads them
// all at /problems and on the mesh as Hmi/Problems.

export default async function ({ page, hmi, d, sys, check, eventually }) {
  const pageId = await hmi.addPage("Trouble");
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "4", y: "4", w: "16", h: "8", background: "#2a2f35", opacity: "1 +" });
  await hmi.setHandler(pageId, card, "tap", 'throw new Error("the belt jammed");');
  const belt = await hmi.addElement(pageId, "div", { name: "Belt", x: "24", y: "4", w: "16", h: "8", background: "#2a2f35" });
  await hmi.setHandler(pageId, belt, "tap", "Speed = Sped;");
  const panel = page.locator(".problems");
  const row = (text) => panel.locator(".problem-row", { hasText: text });
  const tags = async (r) => (await r.locator(".tag").allTextContents()).join(" ");
  const faults = async () => Number(await page.locator(".problems-count > span").first().textContent());
  const selected = () => page.locator(".screen:not([hidden]) .sidebar.left .list-row.selected[data-id]").getAttribute("data-id");
  const served = async () => (await fetch(`${sys.url}/problems`)).json();

  await d.openPage("Trouble");
  await page.locator(".problems-count").click();
  const fault = row("opacity: ");
  await fault.waitFor({ timeout: 4000 });
  check((await fault.locator(".problem-where").textContent()) === "Trouble / Card", "the fault names its page and element");
  check((await tags(fault)) === "Page", "the fault says it is the page's, and of this screen");
  const shown = await faults();
  check(shown >= 1 && (await page.locator(".problems-count .bad").count()) === 1, "the count shows no fault");

  await d.tab("Data");
  await fault.click();
  await eventually(async () => (await page.locator(".tab.on", { hasText: "Design" }).count()) === 1 && (await selected()) === card, "the row to open Card in Design");

  // a fault that changes while another holds takes its place, and nothing loops. One that stays
  // keeps its row above those that come after it.
  const label = await hmi.addElement(pageId, "div", { name: "Label", x: "44", y: "4", w: "16", h: "8", color: "1 +" });
  await row("color: ").waitFor({ timeout: 4000 });
  await hmi.setProps(pageId, label, { color: "nope" });
  await eventually(async () => (await row("color: ").count()) === 1 && (await row("color: ").textContent()).includes("nope"), "the changed fault to take the old one's place");
  await hmi.setProps(pageId, card, { filter: "nope" });
  await row("filter: ").waitFor({ timeout: 4000 });
  await hmi.setProps(pageId, label, { "font-size": "nope" });
  await row("font-size: ").waitFor({ timeout: 4000 });
  const order = (await panel.locator(".problem-text").allTextContents()).filter((t) => /^(color|filter|font-size): /.test(t));
  check(order[0].startsWith("color: "), `a fault that stayed moved below a newer one: ${order.join(" | ")}`);
  await hmi.setProps(pageId, label, { color: null, "font-size": null });
  await hmi.setProps(pageId, card, { filter: null });
  await eventually(async () => (await row("color: ").count()) + (await row("font-size: ").count()) + (await row("filter: ").count()) === 0, "the fixed faults to leave");

  // a handler's fault is told and listed, and counted each time it comes
  await d.tab("Run");
  const el = (id) => page.locator(`.run .el[data-id="${id}"]`);
  await el(card).click();
  const jam = row("Card tap: the belt jammed");
  await jam.waitFor({ timeout: 4000 });
  await page.locator(".notice.fault", { hasText: "Card tap: the belt jammed" }).waitFor({ timeout: 4000 });
  check((await tags(jam)) === "Handler", "the screen's handler fault says it is a handler's");
  await eventually(async () => (await faults()) === shown + 1, "the count to take the handler's fault");
  await el(card).click();
  await eventually(async () => (await jam.textContent()).includes("2 times"), "the second time to count");
  check((await jam.count()) === 1, "the same fault twice makes two rows");

  // one a run on the system met, and one another screen found, say where they came from
  await el(belt).click();
  const system = row("Belt tap: ");
  await system.waitFor({ timeout: 4000 });
  check((await tags(system)) === "Handler System", `the system's handler fault is tagged ${await tags(system)}`);
  const floor = await page.context().newPage();
  await floor.goto(`${sys.url}/run`);
  await floor.evaluate(() => console.warn("the floor screen saw something"));
  const far = row("the floor screen saw something");
  await far.waitFor({ timeout: 4000 });
  check(/^HMI Screen \d+$/.test(await tags(far)), `another screen's warning is tagged ${await tags(far)}`);

  // an agent reads every one, at /problems and on the mesh
  const all = await served();
  check(all.some((p) => p.text.startsWith("Belt tap: ") && p.screen === null && p.source === "run"), "/problems lacks the system's handler fault");
  check(all.some((p) => p.text === "the floor screen saw something" && p.screen > 0 && p.level === "warn"), "/problems lacks the other screen's warning");
  await hmi.import("HmiProblems", "Hmi/Problems");
  await eventually(() => hmi.state.values.HmiProblems?.value?.some?.((p) => p.text === "Card tap: the belt jammed" && p.count === 2 && p.screen > 0), "Hmi/Problems to hold the handler's fault");
  await floor.close();
  await eventually(async () => (await far.count()) === 0, "a screen that went to take its problems with it");

  // fixed, the page's fault goes by itself, and what passed goes when cleared
  await hmi.setProps(pageId, card, { opacity: null });
  await eventually(async () => (await fault.count()) === 0, "the fixed fault to leave");
  await panel.locator('button[title="Clear those that passed"]').click();
  await eventually(async () => (await jam.count()) === 0 && (await system.count()) === 0, "clearing to drop the handlers' faults");
  check((await served()).some((p) => p.text === "Card tap: the belt jammed"), "clearing here dropped the fault for an agent too");

  // the HMI's own warning, whose row shows its stack
  await page.evaluate(() => console.warn(new Error("a test warning")));
  const own = row("a test warning");
  await own.waitFor({ timeout: 4000 });
  check((await tags(own)) === "HMI", "the warning says it is the HMI's");
  await own.click();
  await panel.locator(".problem-detail", { hasText: "Error: a test warning" }).waitFor({ timeout: 4000 });
  await page.locator('.problems button[title="Close"]').click();
  await eventually(async () => (await panel.count()) === 0, "the list to close");
}
