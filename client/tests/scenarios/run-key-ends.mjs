// Every end runs, however close together they come. With one keyup handler for every key, still
// running from the first key let go, the second key's keyup waits its turn rather than being
// lost, since a drive key let go with another must never stay held.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "endsSeen", variable: { name: "endsSeen", start: "", per: "hmi" } });
  const value = (name) => hmi.state.values[name]?.value;
  const pageId = await hmi.addPage("Ends");
  const pad = await hmi.addElement(pageId, "div", { name: "Pad", x: "4", y: "4", w: "10", h: "6", background: "#2a2f35" });
  await hmi.setHandler(pageId, pad, "keyup", 'await sleep(300);\nendsSeen = endsSeen + p.key + ",";');
  hmi.set("endsSeen", "");
  await eventually(() => value("endsSeen") === "", "the ends cleared");

  await d.openPage("Ends");
  await d.tab("Run");
  await eventually(async () => (await page.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).count()) === 1, "the page running");

  await page.keyboard.down("w");
  await page.keyboard.down("d");
  await page.keyboard.up("w");
  await page.keyboard.up("d");
  await eventually(() => value("endsSeen") === "w,d,", () => `both keyups in turn, not "${value("endsSeen")}"`, 3000);
  await page.waitForTimeout(500);
  check(value("endsSeen") === "w,d,", `each keyup once, not "${value("endsSeen")}"`);
}
