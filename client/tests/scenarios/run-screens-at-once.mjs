// Each screen runs a handler as its own: two screens tapping one button at once both count, two
// runs of a slow handler waking together each add to what the other wrote, one tapped again on a
// screen while that screen's run goes on drops only that tap, and a button that waits on the
// page it opened works on another screen meanwhile, which waits on its own.

export default async function ({ page, hmi, sys, check, eventually }) {
  for (const name of ["Hmi.atOnce", "Hmi.slowOnce"]) hmi.setVariable(name, 0);
  const home = await hmi.addPage("AtOnceHome");
  const ask = await hmi.addPage("AtOnceAsk");
  const button = async (pageId, name, x, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x, y: "4", w: "16", h: "8", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const count = await button(home, "Count", "2", "Hmi.atOnce = Hmi.atOnce + 1;");
  const slow = await button(home, "Slow", "22", "await sleep(800);\nHmi.slowOnce = Hmi.slowOnce + 1;");
  const asks = await button(home, "Ask", "42", "await open(Pages.AtOnceAsk);");
  const close = await button(ask, "Close", "2", "close(null);");
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: home });
  await started;
  const value = (name) => hmi.state.values[name]?.value;

  const screens = [];
  for (let n = 0; n < 2; n++) {
    const screen = await (await page.context().browser().newContext()).newPage();
    await screen.goto(`${sys.url}/run`);
    screens.push(screen);
  }
  try {
    const el = (screen, id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
    const showing = (screen) => screen.locator(".run-layer:not([hidden])").getAttribute("data-page").catch(() => null);
    for (const screen of screens) await eventually(async () => (await showing(screen)) === home, "each screen to open on its start page", 10000);

    for (let n = 0; n < 10; n++) await Promise.all(screens.map((s) => el(s, count).click()));
    await eventually(() => value("Hmi.atOnce") === 20, () => `20 taps from two screens at once to count, not ${value("Hmi.atOnce")}`);

    // the first screen's second tap comes while its run sleeps, the other screen's beside it
    const [a, b] = screens;
    await Promise.all([el(a, slow).click(), el(b, slow).click()]);
    await a.waitForTimeout(200);
    await el(a, slow).click();
    await eventually(() => value("Hmi.slowOnce") === 2, () => `a tap from each screen to count, not ${value("Hmi.slowOnce")}`);
    await a.waitForTimeout(1200);
    check(value("Hmi.slowOnce") === 2, `the tap on a screen still running the handler counted too, ${value("Hmi.slowOnce")}`);

    // the first screen waits on the page it opened, and the other opens its own
    await el(a, asks).click();
    await eventually(async () => (await showing(a)) === ask, "the first screen to open the page");
    await el(b, asks).click();
    await eventually(async () => (await showing(b)) === ask, "the other screen to open the page while the first waits on it");
    for (const s of screens) {
      await el(s, close).click();
      await eventually(async () => (await showing(s)) === home, "each screen to close the page");
    }
  } finally {
    for (const s of screens) await s.context().close();
  }
}
