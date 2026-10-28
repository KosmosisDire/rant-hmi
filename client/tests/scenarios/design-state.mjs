// A designer keeps state on a repeated row and on its page from the inspector. Each copy of the
// row keeps its own, which its label reads, a tap on the label toggles on the screen and a tap
// on its flip toggles on the system. A count the page keeps for every screen is read by its name,
// apart from Hmi's state of that name. Another screen keeps its own toggles but shares the count.
// Each piece of state opens on its own, a rename follows what reads it, and a move that would
// hide it from a reader is refused.

export default async function ({ page, hmi, d, sys, check, eventually }) {
  hmi.setVariable("Hmi.hits", 100);
  const pageId = await hmi.addPage("States");
  const find = (elements, id) => elements.reduce((got, e) => got ?? (e.id === id ? e : find(e.children, id)), undefined);
  const of = (id) => (id === null ? hmi.page(pageId) : find(hmi.page(pageId).children, id));
  const list = await hmi.addElement(pageId, "div", { name: "List", x: "4", y: "4", w: "40", h: "30", layout: '"down"', gap: "1" });
  const row = await hmi.addElement(pageId, "div", { name: "Row", w: "fill", h: "6", repeat: "3", background: "#30363d" }, list);
  const label = await hmi.addElement(pageId, "span", { name: "Label", x: "1", y: "1", w: "12", h: "4", text: 'lit ? "on" : "off"', color: "#e4e6e8", "font-size": "2" }, row);
  const flip = await hmi.addElement(pageId, "span", { name: "Flip", x: "20", y: "1", w: "12", h: "4", text: '"flip"', color: "#e4e6e8", "font-size": "2" }, row);
  const count = await hmi.addElement(pageId, "span", { name: "Count", x: "50", y: "4", w: "20", h: "4", text: "String(hits)", color: "#e4e6e8", "font-size": "2" });
  await hmi.setHandler(pageId, label, "tap", "lit = !lit;");
  await hmi.setHandler(pageId, flip, "tap", "lit = !lit;\nhits = hits + 1;");
  await hmi.setHandler(pageId, count, "tap", "hits = hits + 1;");

  // the row keeps lit, each screen its own, from the inspector
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const name = d.field("Name");
  // a new piece of state opens on its own, its name ready to type
  const add = async () => {
    await right.locator('button[title="Add state"]').click();
    await eventually(() => name.evaluate((e) => e === document.activeElement), "the new state's name ready to type");
  };
  const back = async (to) => {
    await right.locator(`button[title="Back to ${to}"]`).click();
    await right.locator('button[title="Add state"]').waitFor();
  };
  await d.openPage("States");
  await d.select("Row");
  await add();
  await eventually(() => of(row).state.length === 1, "the row to keep state");
  await name.fill("lit");
  await name.press("Enter");
  await eventually(() => of(row).state[0]?.name === "lit", "the state renamed lit");
  await right.locator(".section", { hasText: /^Kept by Row$/ }).waitFor();
  await d.setField("Starts", "false");
  await eventually(() => of(row).state[0]?.start === false && of(row).state[0]?.per === "screen", "lit to start false, kept each screen");
  await back("Row");
  await right.locator('.member-row[data-state="lit"]').waitFor();
  const mark = page.locator(`.screen:not([hidden]) .list-row[data-id="${row}"] .mark-state`);
  check((await mark.textContent()) === "1", "the row's row in the tree to count what it keeps");

  // the page keeps hits for every screen
  await d.pageRow("States").click();
  await add();
  await eventually(() => of(null).state.length === 1, "the page to keep state");
  await name.fill("hits");
  await name.press("Enter");
  await eventually(() => of(null).state[0]?.name === "hits", "the page's state renamed hits");
  await right.locator(".field", { has: page.locator("label", { hasText: /^Kept$/ }) }).locator("button", { hasText: "Every screen" }).click();
  await eventually(() => of(null).state[0]?.per === "hmi", "hits kept for every screen");
  await back("States");
  // completion offers what the label sees, the nearest first
  await d.select("Label");
  const text = d.field("Text");
  await text.click();
  await text.press("End");
  await page.keyboard.type(" + h");
  await eventually(async () => (await page.locator(".suggest .suggest-name").first().textContent()) === "hits", "the page's hits offered first");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await eventually(() => of(label).props.text === 'lit ? "on" : "off"', "the label's text kept as it was");

  hmi.send({ type: "set_start", page: pageId });
  await d.tab("Run");
  const shown = (screen) => (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const el = shown(page);
  const labels = async (at) => (await at(label).allTextContents()).map((t) => t.trim()).join(" ");
  await eventually(async () => (await labels(el)) === "off off off", async () => `three copies off, not ${await labels(el)}`);
  await eventually(async () => (await el(count).textContent()) === "0", "the page's own hits");

  // a tap on a label toggles its copy here, a flip toggles it on the system and counts
  await el(label).nth(1).click();
  await eventually(async () => (await labels(el)) === "off on off", async () => `the second copy on alone, not ${await labels(el)}`);
  await el(flip).nth(2).click();
  await eventually(async () => (await labels(el)) === "off on on", async () => `the third copy flipped on the system, not ${await labels(el)}`);
  await eventually(async () => (await el(count).textContent()) === "1", "the flip to count");
  await el(count).click();
  await eventually(async () => (await el(count).textContent()) === "2", "the count to count");
  check(hmi.state.values["Hmi.hits"]?.value === 100, "Hmi's own hits changed");

  // another screen shares the count and keeps its own toggles
  const other = await (await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await other.goto(`${sys.url}/run`);
  const there = shown(other);
  await eventually(async () => (await labels(there)) === "off off off", async () => `the other screen's own copies off, not ${await labels(there)}`);
  await eventually(async () => (await there(count).textContent()) === "2", "the other screen to share the count");
  await there(flip).first().click();
  await eventually(async () => (await labels(there)) === "on off off", async () => `the other screen's first copy on, not ${await labels(there)}`);
  await eventually(async () => (await el(count).textContent()) === "3", "the first screen to see the other's count");
  check((await labels(el)) === "off on on", "the other screen's flip toggled this one's");

  // a rename follows what reads it, its copies' values starting over
  await d.tab("Design");
  await d.select("Row");
  await right.locator('.member-row[data-state="lit"]').click();
  await name.fill("glow");
  await name.press("Enter");
  await eventually(() => of(label).props.text === 'glow ? "on" : "off"' && of(flip).handlers[0]?.code === "glow = !glow;\nhits = hits + 1;", "the label and the flip to follow the rename");

  // the flip reads it too, so it cannot move into the label
  await right.locator(".list-row", { hasText: "Flip" }).waitFor();
  await right.locator("button", { hasText: /^Move to$/ }).click();
  await page.locator(".popover.menu .menu-item", { has: page.locator(".menu-label", { hasText: /^To Label$/ }) }).click();
  await page.locator(".notice.fault", { hasText: "Flip reads glow. Change that first." }).waitFor();
  check(of(row).state[0]?.name === "glow" && of(label).state.length === 0, "a refused move moved it");
}
