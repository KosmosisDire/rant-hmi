// An operator presses a button whose handler sends on a topic imported to write: the line
// hears the message on Line1/Jog and runs at that speed.

export default async function ({ page, hmi, d, eventually }) {
  await hmi.import("Line.Jog", "Line1/Jog", "write");
  const pageId = await hmi.addPage("Send");
  const id = await hmi.addElement(pageId, "div", { name: "Jog fast", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.setHandler(pageId, id, "tap", "Line.Jog.send(1.75);");
  await hmi.set("Line.Speed", 0.5);
  await d.openPage("Send");
  await d.tab("Run");
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 0.5, "the speed at 0.5");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`).click();
  await eventually(() => hmi.state.values["Line.Speed"]?.value === 1.75, "the line to run at the speed sent on Jog");
}
