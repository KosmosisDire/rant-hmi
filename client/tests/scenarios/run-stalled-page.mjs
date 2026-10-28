// A page whose main thread stalls, as one does hidden or busy, gets what is newest when it goes
// on, not every value it missed: the backend sends small values only as fast as the page says
// it applied them, so a stall of seconds leaves a quarter second of batches in the link's
// buffers at most, and a count the page shows jumps to the system's within a moment.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.stallCount", 0);
  await hmi.setRule("Hmi", "", { id: "", name: "Stall count", when: { kind: "every", ms: 50 }, code: "Hmi.stallCount = Hmi.stallCount + 1;" });
  const pageId = await hmi.addPage("Stall");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "40", h: "4", text: "String(Hmi.stallCount)", color: "#e4e6e8" });
  await d.openPage("Stall");
  await d.tab("Run");
  const at = `.run-layer:not([hidden]) .el[data-id="${shown}"]`;
  const el = page.locator(at);
  await eventually(async () => Number(await el.textContent()) > 10, "the count to show and rise");

  // every count shown from here, with when it showed
  await page.evaluate((at) => {
    const el = document.querySelector(at);
    window.__shown = [];
    new MutationObserver(() => window.__shown.push([Number(el.textContent), performance.now()])).observe(el, { childList: true, characterData: true, subtree: true });
  }, at);
  // the main thread stalls for three seconds
  const stalled = await page.evaluate(() => {
    const end = performance.now() + 3000;
    while (performance.now() < end);
    return end;
  });
  await page.waitForTimeout(400);
  const current = hmi.state.values["Hmi.stallCount"]?.value;
  const after = await page.evaluate((stalled) => window.__shown.filter(([, t]) => t >= stalled), stalled);
  check(after.length > 0, "the count to show again after the stall");
  // the counts of the stall's seconds, about 60, mostly never show
  const stale = after.filter(([n]) => n < current - 20);
  check(stale.length <= 15, `${stale.length} stale counts showed after the stall, from ${after[0]?.[0]} up to ${current}`);
  // and the newest shows within a moment of the stall's end
  const caught = after.find(([n]) => n >= current - 20);
  check(caught !== undefined && caught[1] - stalled < 500, `the page took ${caught ? Math.round(caught[1] - stalled) : "more than 400"} ms after the stall to show a current count`);
  await hmi.setRule("Hmi", hmi.state.rules.find((r) => r.name === "Stall count").id, null);
}
