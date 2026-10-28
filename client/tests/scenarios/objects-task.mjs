// A user adds the line's fill to Line, a task that reports its progress: the Objects tab shows
// what it takes, reports and gives back, a button runs it with a progress bar fed from its updates,
// and a stop button cancels a long fill.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const i of hmi.state.imports.filter((x) => x.entity === "Line1/Fill")) await hmi.unimport(i.alias);
  await d.openObject("Line");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await (await d.meshRow("Line1/Fill")).click();
  await right.getByText("Progress", { exact: true }).waitFor();
  check(!(await right.locator(".choice").isVisible()), "a task offers an intent");
  await right.locator("button", { hasText: /^Add to Line$/ }).click();
  await eventually(() => hmi.state.imports.some((i) => i.alias === "Line.Fill" && i.kind === "task" && i.intent === "write"), "the member, to call");
  await right.locator(".head-title", { hasText: /^Line\.Fill$/ }).waitFor();
  check((await right.locator(".pane-head .tag").first().textContent()) === "mesh task", "the member is not tagged a mesh task");

  for (const [name, start] of [["Hmi.filled", 0], ["Hmi.parts", 0], ["Hmi.shares", 0], ["Hmi.ended", ""]]) {
    hmi.setVariable(name, start);
  }
  await eventually(() => hmi.state.values["Hmi.ended"]?.known, "the variables");
  const shared = (name) => hmi.state.values[name]?.value;
  const pageId = await hmi.addPage("Fill box");
  const add = async (name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x, y: "44", w: "176", h: "66", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const fill = await add("Fill", "44", "Hmi.parts = await Line.Fill(5, (p) => {\n  Hmi.filled = p;\n  Hmi.shares = Hmi.shares + 1;\n});");
  const long = await add("Long", "264", "const job = Line.Fill(1000, (p) => { Hmi.filled = p; });\ntry { await job; } catch (e) { Hmi.ended = e.status; }");
  const stop = await add("Stop", "484", "Line.Fill.cancel();");
  const bar = await hmi.addElement(pageId, "div", { name: "Bar", x: "44", y: "154", w: "Hmi.filled * 60", h: "22", background: "#ff8800" });
  await d.openPage("Fill box");
  await d.tab("Run");
  const el = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);

  await el(fill).click();
  await eventually(() => shared("Hmi.filled") > 0 && shared("Hmi.filled") < 1, () => `a share of the fill under way, ${shared("Hmi.filled")}`);
  const midway = (await el(bar).boundingBox()).width;
  await eventually(() => shared("Hmi.parts") === 5, () => `the fill to answer how many it filled, it said ${shared("Hmi.parts")}`);
  check(shared("Hmi.filled") === 1 && shared("Hmi.shares") === 5, `the fill reported ${shared("Hmi.shares")} times, ending at ${shared("Hmi.filled")}`);
  const full = (await el(bar).boundingBox()).width;
  check(midway > 0 && midway < full, `the bar did not grow with the fill, ${midway} then ${full} px`);

  await el(long).click();
  await eventually(() => shared("Hmi.filled") > 0 && shared("Hmi.filled") < 0.01, () => `the long fill to start, ${shared("Hmi.filled")}`);
  await el(stop).click();
  await eventually(() => shared("Hmi.ended") === "cancelled", () => `the stop to cancel the long fill, it ended "${shared("Hmi.ended")}"`);
  const stopped = shared("Hmi.filled");
  await page.waitForTimeout(600);
  check(shared("Hmi.filled") === stopped, "the long fill went on after its cancel");
}
