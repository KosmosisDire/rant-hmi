// A component repeats once per item of a list, and its part sends picked. The page's handler
// for picked reads the copy it came from, its index and item, and its while reads them too:
// a tap on the first copy is not heard, one on the third sets both.

export default async function ({ page, hmi, d, eventually, check }) {
  hmi.setVariable("Hmi.pickedAt", -1);
  hmi.setVariable("Hmi.pickedSide", "");

  const pick = await hmi.addComponent("Pick");
  await hmi.edit({ kind: "resize_page", page: pick, width: 10, height: 6 });
  await hmi.edit({ kind: "set_event", page: pick, name: "picked", to: "picked" });
  const face = await hmi.addElement(pick, "div", { name: "face", x: "0", y: "0", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(pick, face, "tap", 'emit("picked");');

  const pageId = await hmi.addPage("Sides");
  const sides = await hmi.addElement(pageId, "use", { name: "Side", x: "4 + index * 12", y: "4", w: "10", h: "6", repeat: '["north", "east", "south"]' }, null, "Pick");
  await hmi.setHandler(pageId, sides, "picked", "Hmi.pickedAt = index;\nHmi.pickedSide = item;", { while: "index > 0" });

  await d.openPage("Sides");
  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${sides}"]`);
  await eventually(async () => (await run.count()) === 3, "three copies running");
  await run.nth(0).click();
  await page.waitForTimeout(300);
  check(hmi.state.values["Hmi.pickedAt"]?.value === -1, `the first copy's pick was heard: ${hmi.state.values["Hmi.pickedAt"]?.value}`);
  await run.nth(2).click();
  await eventually(() => hmi.state.values["Hmi.pickedAt"]?.value === 2 && hmi.state.values["Hmi.pickedSide"]?.value === "south", () => `the third copy's pick, got ${hmi.state.values["Hmi.pickedAt"]?.value} ${hmi.state.values["Hmi.pickedSide"]?.value}`);
}
