// An operator types the speed into an input bound to Speed: a number is written and its change
// handler runs, text stays red and unwritten, and an input showing Speed * 2 only shows.

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Entry");
  await d.openPage("Entry");
  await d.addRow("Input");
  await eventually(() => hmi.page(pageId).children.length === 1, "an input");
  const id = hmi.page(pageId).children[0].id;
  await d.setField("Value", "Speed");
  await d.addEvent("change");
  await d.code("change").click();
  await page.keyboard.type('notify("Speed set to " + p.value);');
  await page.keyboard.press("Control+Enter");
  await eventually(() => hmi.page(pageId).children[0].handlers[0]?.code.includes("Speed set"), "the change handler");
  const double = await hmi.addElement(pageId, "input", { name: "Double", x: "264", y: "44", w: "176", h: "44", value: "Speed * 2" });

  hmi.set("Speed", 0.5);
  await d.tab("Run");
  const field = (el) => page.locator(`.run-layer:not([hidden]) .el[data-id="${el}"] input`);
  await eventually(async () => (await field(id).inputValue()) === "0.5", "the input to show the speed");
  await field(id).click();
  await field(id).fill("abc");
  await field(id).press("Enter");
  check(await field(id).evaluate((e) => e.classList.contains("bad")), "text in a number field was not refused");
  check(hmi.state.values.Speed?.value === 0.5, "text reached the speed");
  await field(id).fill("1.25");
  await field(id).press("Enter");
  await eventually(() => hmi.state.values.Speed?.value === 1.25, "the entry to set the speed");
  await page.locator(".notice", { hasText: "Speed set to 1.25" }).waitFor({ timeout: 4000 });
  await eventually(async () => (await field(double).inputValue()) === "2.5", "the derived input to follow");
  check(await field(double).evaluate((e) => e.readOnly), "an input showing Speed * 2 takes entries");
}
