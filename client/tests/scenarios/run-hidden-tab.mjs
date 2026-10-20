// A screen in a hidden tab keeps what it holds. Its timers run once a minute, as a long hidden
// tab's do, but its browser answers the backend's pings by itself, so the backend never takes
// it for silent and lets go.

export default async function ({ page, hmi, d, check, eventually }) {
  const held = await hmi.addPage("Hidden hold");
  const pad = await hmi.addElement(held, "div", { name: "pad", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await hmi.setHandler(held, pad, "press", "Speed = 1.25;");
  await hmi.setHandler(held, pad, "release", "Speed = 0;");

  await page.addInitScript(() => {
    const every = window.setInterval;
    window.setInterval = (fn, ms, ...args) => every(fn, Math.max(ms ?? 0, 60000), ...args);
  });
  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  await d.openPage("Hidden hold");
  await d.tab("Run");
  const b = await page.locator(`.run-layer:not([hidden]) .el[data-id="${pad}"]`).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await eventually(() => hmi.state.values.Speed?.value === 1.25, "the press to set Speed");
  await page.waitForTimeout(1500);
  check(hmi.state.values.Speed?.value === 1.25, "the backend let go of the hold while the tab was hidden");
  await page.mouse.up();
  await eventually(() => hmi.state.values.Speed?.value === 0, "the release to set Speed back");
}
