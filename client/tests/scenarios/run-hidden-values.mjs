// A page that hides, as a tab behind another, is sent no values while hidden, and one shown
// again gets every value anew at once: a count it shows stands still while hidden, however
// long, and jumps to the system's when the page shows, never replaying the counts it missed.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "hiddenCount", variable: { name: "hiddenCount", start: 0, per: "hmi" } });
  await hmi.setRule("", { id: "", name: "Hidden count", when: { kind: "every", ms: 50 }, code: "hiddenCount = hiddenCount + 1;" });
  const pageId = await hmi.addPage("Hidden values");
  const shown = await hmi.addElement(pageId, "span", { name: "Shown", x: "4", y: "4", w: "40", h: "4", text: "String(hiddenCount)", color: "#e4e6e8" });
  await d.openPage("Hidden values");
  await d.tab("Run");
  const at = `.run-layer:not([hidden]) .el[data-id="${shown}"]`;
  const el = page.locator(at);
  const read = async () => Number(await el.textContent());
  await eventually(async () => (await read()) > 10, "the count to show and rise");

  // the page hides, as the browser tells it
  const visibility = (state) =>
    page.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await visibility("hidden");
  await page.waitForTimeout(500);
  const still = await read();
  await page.waitForTimeout(1500);
  check((await read()) === still, `the hidden page to show the same count, not ${await read()} after ${still}`);
  check(hmi.state.values.hiddenCount?.value > still + 20, "the system to have counted on meanwhile");

  // shown again, every count shown from here
  await page.evaluate((at) => {
    const el = document.querySelector(at);
    window.__shown = [];
    new MutationObserver(() => window.__shown.push(Number(el.textContent))).observe(el, { childList: true, characterData: true, subtree: true });
  }, at);
  await visibility("visible");
  await eventually(async () => (await read()) > still, "the count to move once the page shows", 2000);
  const current = hmi.state.values.hiddenCount?.value;
  const seen = await page.evaluate(() => window.__shown);
  check(seen.length > 0 && seen[0] >= current - 10, `the first count shown to be the system's, not ${seen[0]} against ${current}`);
  await hmi.setRule(hmi.state.rules.find((r) => r.name === "Hidden count").id, null);
}
