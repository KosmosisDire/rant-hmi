// A designer makes a bar that takes the size it is placed at: scaled, an instance wider than
// the bar keeps its shape, and once the component's sizing is Fill its part placed at 100%
// stretches to the instance's whole width.

export default async function ({ page, hmi, d, eventually }) {
  const bar = await hmi.addComponent("Band");
  hmi.send({ type: "edit", edit: { kind: "resize_page", page: bar, width: 200, height: 40 } });
  await hmi.addElement(bar, "div", { name: "Fill", x: "0", y: "0", w: "100%", h: "100%", background: "#4a8fd6" });
  const pageId = await hmi.addPage("Bands");
  const inst = await hmi.addElement(pageId, "use", { name: "Band", x: "40", y: "40", w: "400", h: "40" }, null, "Band");
  await d.openPage("Bands");
  const share = async () => {
    const [whole, part] = [await d.box(inst), await d.el(inst).locator(".instance .el").boundingBox()];
    return part.width / whole.width;
  };
  await eventually(async () => Math.abs((await share()) - 0.5) < 0.02, "the scaled bar to keep its shape, half the instance's width");

  await d.openPage("Band");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  await right.locator(".field", { has: page.locator("label", { hasText: /^Sizing$/ }) }).locator("button", { hasText: /^Fill$/ }).click();
  await eventually(() => hmi.page(bar).interface?.sizing === "fill", "the sizing to change");
  await d.openPage("Bands");
  await eventually(async () => Math.abs((await share()) - 1) < 0.02, "the bar's part to fill the instance");
  await page.keyboard.press("Control+z");
  await eventually(() => hmi.page(bar).interface?.sizing === "scale", "undo to put the scale back");
}
