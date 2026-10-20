// A user gives a Meter an input filled per instance from live data: a rename reaches its code
// and instances, completion offers inputs only, and a rename then a quick click is one change.

export default async function ({ page, hmi, d, check, eventually }) {
  const meter = await hmi.addComponent("Meter");
  const label = await hmi.addElement(meter, "span", { name: "Label", x: "11", y: "11", w: "242", h: "44", text: '""', color: "#e4e6e8" });
  const side = (sel) => page.locator(`.screen:not([hidden]) .sidebar.${sel}`);

  await d.openPage("Meter");
  await side("right").locator('button[title="Add an input"]').click();
  await eventually(() => hmi.page(meter).interface.inputs.length === 1, "an input");
  const nameBox = side("right").locator(".input-name");
  await nameBox.fill("level");
  await nameBox.press("Enter");
  const def = side("right").locator(".input-default input");
  await eventually(() => hmi.page(meter).interface.inputs[0].name === "level", "the rename to level");
  await def.fill("50");
  await def.press("Enter");
  await eventually(() => hmi.page(meter).interface.inputs[0].default === "50", "the default");

  await d.el(label).click();
  const text = d.field("Text");
  await text.click();
  await text.fill("");
  await page.keyboard.type("le");
  check((await page.locator(".suggest .suggest-name").allTextContents()).join() === "level", "completion in a component offers more than its inputs");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type(' + "%"');
  await page.keyboard.press("Enter");
  await eventually(async () => (await d.el(label).textContent()) === "50%", "the component to read its default");

  await d.setField("Text", "Speed");
  await page.locator(".field-note", { hasText: "Speed names no datapoint" }).waitFor();
  await d.setField("Text", 'level + "%"');

  const pageId = await hmi.addPage("Meters");
  const inst = await hmi.addElement(pageId, "use", { name: "Meter", x: "44", y: "44", w: "264", h: "176" }, null, "Meter");
  await d.openPage("Meters");
  await d.el(inst).click();
  const level = d.field("level");
  check((await level.getAttribute("placeholder")) === "50", "the instance's input shows no default");
  await d.setField("level", "Speed * 10");
  const shown = () => d.el(inst).locator(".instance .el").textContent();
  await eventually(async () => /^\d+(\.\d+)?%$/.test(await shown()) && (await shown()) !== "50%", "the instance to read live data through its input");

  await d.openPage("Meter");
  await nameBox.fill("fill");
  await nameBox.press("Enter");
  await eventually(() => hmi.page(pageId).children[0].props.fill === "Speed * 10", "the instance's value to follow the rename");
  await eventually(() => hmi.page(meter).children[0].props.text === 'fill + "%"', "the component's code to follow the rename");

  // a rename left by clicking two way, before the backend answers, still makes one input
  await nameBox.fill("amount");
  await side("right").locator(".handler .check input").click();
  await eventually(() => {
    const inputs = hmi.page(meter).interface.inputs;
    return inputs.length === 1 && inputs[0].name === "amount" && inputs[0].bindable;
  }, "one two way input named amount");
}
