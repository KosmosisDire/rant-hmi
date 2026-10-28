// Every end runs, however close together they come. With one keyup handler for every key, still
// running from the first key let go, the second key's keyup waits its turn rather than being
// lost, since a drive key let go with another must never stay held.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.endsSeen", "");
  const value = (name) => hmi.state.values[name]?.value;
  const pageId = await hmi.addPage("Ends");
  const pad = await hmi.addElement(pageId, "div", { name: "Pad", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "keyup", 'await sleep(300);\nHmi.endsSeen = Hmi.endsSeen + p.key + ",";');
  hmi.set("Hmi.endsSeen", "");
  await eventually(() => value("Hmi.endsSeen") === "", "the ends cleared");

  await d.openPage("Ends");
  await d.tab("Run");
  await eventually(async () => (await page.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).count()) === 1, "the page running");

  await page.keyboard.down("w");
  await page.keyboard.down("d");
  await page.keyboard.up("w");
  await page.keyboard.up("d");
  await eventually(() => value("Hmi.endsSeen") === "w,d,", () => `both keyups in turn, not "${value("Hmi.endsSeen")}"`, 3000);
  await page.waitForTimeout(500);
  check(value("Hmi.endsSeen") === "w,d,", `each keyup once, not "${value("Hmi.endsSeen")}"`);
}
