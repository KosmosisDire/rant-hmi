// A second screen goes away mid press on a jog, as a tablet losing wifi does. The release
// still runs, so the line never keeps jogging for a screen that is gone. One whose link breaks
// never says it let go, so its release runs with p.lost, and still reads that screen's own
// variables.

import { between } from "../links.mjs";

export default async function ({ page, hmi, sys, d, eventually }) {
  const pageId = await hmi.addPage("Jog");
  const jog = await hmi.addElement(pageId, "div", { name: "Jog", x: "4", y: "4", w: "16", h: "8", background: "#2a2f35" });
  await hmi.setHandler(pageId, jog, "press", "Speed = 2;");
  await hmi.setHandler(pageId, jog, "release", "Speed = 0.25;");
  await hmi.set("Speed", 0.25);
  await d.openPage("Jog");
  await page.locator(".page-row.open").waitFor();

  const other = await page.context().browser().newContext({ viewport: { width: 1200, height: 800 } });
  const tablet = await other.newPage();
  await tablet.goto(sys.url);
  await tablet.locator(".tab", { hasText: "Design" }).click();
  await tablet.locator(".screen:not([hidden]) .page-row", { hasText: /^Jog/ }).click();
  await tablet.locator(".tab", { hasText: "Run" }).click();
  const button = tablet.locator(`.run-layer:not([hidden]) .el[data-id="${jog}"]`);
  const b = await button.boundingBox();
  await tablet.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await tablet.mouse.down();
  await eventually(() => hmi.state.values.Speed?.value === 2, "the jog to run while held");

  await other.close();
  await eventually(() => hmi.state.values.Speed?.value === 0.25, "the jog to stop when its screen went away");

  hmi.send({ type: "set_variable", name: "lostMine", variable: { name: "lostMine", start: 7, per: "screen" } });
  hmi.send({ type: "set_variable", name: "lostSaw", variable: { name: "lostSaw", start: 0, per: "hmi" } });
  await hmi.setHandler(pageId, jog, "release", "Speed = 0.25;\nif (p.lost) lostSaw = lostMine;");
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: pageId });
  await started;
  const way = await between(Number(new URL(sys.url).port));
  const broken = await page.context().browser().newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const screen = await broken.newPage();
    await screen.goto(`${way.url}/run`);
    const held = screen.locator(`.run-layer:not([hidden]) .el[data-id="${jog}"]`);
    const at = await held.boundingBox();
    await screen.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await screen.mouse.down();
    await eventually(() => hmi.state.values.Speed?.value === 2, "the jog to run while held on the screen whose link breaks");
    way.cut("");
    await eventually(() => hmi.state.values.Speed?.value === 0.25 && hmi.state.values.lostSaw?.value === 7, () => `the lost release to stop the jog and read its screen's own variable, not ${hmi.state.values.lostSaw?.value}`, 8000);
  } finally {
    await broken.close();
    way.close();
  }
}
