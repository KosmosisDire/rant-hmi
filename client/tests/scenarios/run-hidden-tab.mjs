// A screen whose page falls silent, as a hidden tab's does when its timers run once a minute,
// has the backend let go of what it holds within a second, its release running with p.lost,
// though its browser still answers the backend's pings by itself. A page that stays quick
// keeps its hold.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "hiddenLost", variable: { name: "hiddenLost", start: 0, per: "hmi" } });
  const held = await hmi.addPage("Hidden hold");
  const pad = await hmi.addElement(held, "div", { name: "pad", x: "4", y: "4", w: "16", h: "8", background: "#2a2f35" });
  await hmi.setHandler(held, pad, "press", "Speed = 1.25;");
  await hmi.setHandler(held, pad, "release", "Speed = 0; if (p.lost) hiddenLost = 1;");
  await d.openPage("Hidden hold");
  await d.tab("Run");

  const press = async () => {
    const b = await page.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await eventually(() => hmi.state.values.Speed?.value === 1.25, "the press to set Speed");
  };
  await press();
  await page.waitForTimeout(1500);
  check(hmi.state.values.Speed?.value === 1.25, "the backend let go of a hold whose page pings as it should");
  await page.mouse.up();
  await eventually(() => hmi.state.values.Speed?.value === 0, "the release to set Speed back");
  check(hmi.state.values.hiddenLost?.value === 0, "a release the page sent ran as lost");

  // the page's pings slow to once a minute, as a long hidden tab's timers do
  await page.addInitScript(() => {
    const every = window.setInterval;
    window.setInterval = (fn, ms, ...args) => every(fn, Math.max(ms ?? 0, 60000), ...args);
  });
  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.openPage("Hidden hold");
  await d.tab("Run");
  await press();
  const at = Date.now();
  await eventually(() => hmi.state.values.Speed?.value === 0 && hmi.state.values.hiddenLost?.value === 1, "the backend to let go of the silent page's hold as lost", 3000);
  check(Date.now() - at < 2000, `the silent page's hold took ${Date.now() - at} ms to let go`);
  await page.mouse.up();
}
