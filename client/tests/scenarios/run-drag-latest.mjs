// An operator drags across a strip whose handler takes a while: the moves that come while it
// runs are skipped, but where the drag ends always lands.

export default async function ({ page, hmi, d, eventually }) {
  hmi.send({ type: "set_variable", name: "slowX", variable: { name: "slowX", start: 0, per: "hmi" } });
  const pageId = await hmi.addPage("Slow strip");
  const strip = await hmi.addElement(pageId, "div", { name: "Strip", x: "4", y: "4", w: "64", h: "8", background: "#2a2f35" });
  await hmi.setHandler(pageId, strip, "drag", "await sleep(150);\nslowX = Math.round(p.x * 100);");
  await d.openPage("Slow strip");
  await d.tab("Run");
  const el = page.locator(`.run-layer:not([hidden]) .el[data-id="${strip}"]`);
  const b = await el.boundingBox();
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(b.x + (b.width * 0.7 * i) / 10, b.y + b.height / 2);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await eventually(() => hmi.state.values.slowX?.value === 70, () => `where the drag ended to land, slowX is ${hmi.state.values.slowX?.value}`, 3000);
}
