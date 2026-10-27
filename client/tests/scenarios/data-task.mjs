// A user imports the line's fill, a task that reports its progress: the Data view shows what it
// takes, reports and gives back, a button runs it with a progress bar fed from its updates,
// and a stop button cancels a long fill.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.tab("Data");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await (await d.meshRow("Line1/Fill")).click();
  await right.getByText("Progress", { exact: true }).waitFor();
  check(!(await right.locator(".choice").isVisible()), "a task offers an intent");
  await right.locator("button", { hasText: /^Import$/ }).click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Fill" && i.kind === "task" && i.intent === "write"), "the import, to call");
  await eventually(async () => (await right.locator(".head-title").textContent()).includes("Fill"), "the inspector to show the import");
  check((await right.locator(".tag").first().textContent()) === "call", "the import is not tagged call");

  for (const [name, start] of [["filled", 0], ["parts", 0], ["shares", 0], ["ended", ""]]) {
    hmi.send({ type: "set_variable", name, variable: { name, start, per: "hmi" } });
  }
  await eventually(() => hmi.state.values.ended?.known, "the variables");
  const shared = (name) => hmi.state.values[name]?.value;
  const pageId = await hmi.addPage("Fill box");
  const add = async (name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x, y: "44", w: "176", h: "66", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const fill = await add("Fill", "44", "parts = await Fill(5, (p) => {\n  filled = p;\n  shares = shares + 1;\n});");
  const long = await add("Long", "264", "const job = Fill(1000, (p) => { filled = p; });\ntry { await job; } catch (e) { ended = e.status; }");
  const stop = await add("Stop", "484", "Fill.cancel();");
  const bar = await hmi.addElement(pageId, "div", { name: "Bar", x: "44", y: "154", w: "filled * 60", h: "22", background: "#ff8800" });
  await d.openPage("Fill box");
  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);

  await el(fill).click();
  await eventually(() => shared("filled") > 0 && shared("filled") < 1, () => `a share of the fill under way, ${shared("filled")}`);
  const midway = (await el(bar).boundingBox()).width;
  await eventually(() => shared("parts") === 5, () => `the fill to answer how many it filled, it said ${shared("parts")}`);
  check(shared("filled") === 1 && shared("shares") === 5, `the fill reported ${shared("shares")} times, ending at ${shared("filled")}`);
  const full = (await el(bar).boundingBox()).width;
  check(midway > 0 && midway < full, `the bar did not grow with the fill, ${midway} then ${full} px`);

  await el(long).click();
  await eventually(() => shared("filled") > 0 && shared("filled") < 0.01, () => `the long fill to start, ${shared("filled")}`);
  await el(stop).click();
  await eventually(() => shared("ended") === "cancelled", () => `the stop to cancel the long fill, it ended "${shared("ended")}"`);
  const stopped = shared("filled");
  await page.waitForTimeout(600);
  check(shared("filled") === stopped, "the long fill went on after its cancel");
}
