// A screen in a hidden tab stays connected. Its timers run once a minute, as a long hidden
// tab's do, but its browser answers the backend's pings by itself.

export default async function ({ page, sys, check }) {
  await page.addInitScript(() => {
    const every = window.setInterval;
    window.setInterval = (fn, ms, ...args) => every(fn, Math.max(ms ?? 0, 60000), ...args);
  });
  await page.reload();
  await page.locator(".statusbar", { hasText: "System" }).waitFor();
  const lost = () => (sys.backend.log.match(/ lost/g) ?? []).length;
  const before = lost();
  await page.waitForTimeout(1500);
  check(lost() === before, "the backend lost the screen while its tab was hidden");
}
