// A screen showing a big value keeps showing it through what befalls it on its way: its page
// left and opened again many times while values are on their way, its second socket cut mid
// value, its link cut mid value, and the HMI restarted. The editor's Design tab draws the scene
// as its pages and tabs switch. Each time the scene draws the value again and its values come at
// the link's pace, none waiting on word of one taken that never comes. The link brings 600 KB a
// second of the 1.2 MB the scan sends, so a value is nearly always on its way.

import { between, countBig } from "../links.mjs";

export const fresh = true;

const red = ([r, g, b]) => r > 120 && g < 60 && b < 60;

export default async function ({ page, hmi, sys, d, check, eventually }) {
  await hmi.import("Cell.ScanT", "Cell/Scan");
  const home = await hmi.addPage("TurnsHome");
  const scanned = await hmi.addPage("TurnsScan");
  const button = async (pageId, name, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: "2", y: "44", w: "20", h: "8", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, "tap", code);
    return id;
  };
  const toScan = await button(home, "To scan", "await open(Pages.TurnsScan);");
  const back = await button(scanned, "Back", "await open(Pages.TurnsHome);");
  // seen from above, the floor filling the middle
  const scene = await hmi.addElement(scanned, "scene", { name: "cell", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "4" });
  await hmi.addElement(scanned, "points", { name: "scan", points: "Cell.ScanT.points", size: "0.05", color: '"#ff0000"' }, scene);
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: home });
  await started;

  const way = await between(Number(new URL(sys.url).port), { rate: 600 << 10 });
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(countBig);
  try {
    const screen = await context.newPage();
    await screen.goto(`${way.url}/run`);
    const el = (id) => screen.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
    const showing = () => screen.locator(".run-layer:not([hidden])").getAttribute("data-page").catch(() => null);
    const tap = async (id, to) => {
      await el(id).click();
      await eventually(async () => (await showing()) === to, `the screen to show ${to}`);
    };
    /** Who said the screen never took a value, so far. */
    const lapses = () => (sys.backend.log.match(/never said it took/g) ?? []).length;
    /** Waits for the scene to draw the scan again, then for the scan's values to come for 3 s at
     *  the link's pace, none more than 1.5 s after the one before. */
    const flows = async (what) => {
      await eventually(async () => {
        const n = await screen.evaluate(() => window.__big ?? 0);
        await screen.waitForTimeout(1000);
        return (await screen.evaluate(() => window.__big ?? 0)) - n >= 2;
      }, `the scan to come again ${what}`, 15000);
      await d.shows(el(scene), 0.5, 0.5, red, `the scan drawn ${what}`);
      const from = Date.now();
      await screen.waitForTimeout(3000);
      const at = await screen.evaluate((from) => (window.__bigAt ?? []).filter((t) => t >= from), from);
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      check(at.length >= 4, `${what}, the screen got ${at.length} of the scan's values in 3 s`);
      check(Math.max(0, ...gaps) < 1500, `${what}, the scan's values came ${gaps.join(" ")} ms apart`);
    };

    await eventually(async () => (await showing()) === home, "the screen to open on its start page", 10000);
    await tap(toScan, scanned);
    await flows("once its page opened");

    // left and opened again, each while a value is on its way
    const before = lapses();
    for (let round = 0; round < 12; round++) {
      await tap(back, home);
      await screen.waitForTimeout(Math.random() * 250);
      await tap(toScan, scanned);
      await screen.waitForTimeout(Math.random() * 250);
    }
    await flows("after its page was left and opened 12 times");
    check(lapses() === before, `the backend waited on word of a value taken ${lapses() - before} times`);

    // with the second socket cut its values come on the link, and the second opens again
    const opened = () => (sys.backend.log.match(/opened its second way/g) ?? []).length;
    const seconds = opened();
    check(way.cut("/bulk") === 1, "no second socket to cut");
    await flows("with its second socket cut");
    await eventually(() => opened() > seconds, "the second socket to open again", 15000);
    await flows("with its second socket open again");

    // a link cut makes a new session, whose values come whole
    check(way.cut("/ws") === 1, "no link to cut");
    await flows("after its link was cut");

    // the editor draws the scene in its Design tab, as its pages and tabs switch
    await d.openPage("TurnsScan");
    await d.shows(d.el(scene), 0.5, 0.5, red, "the scan drawn in the Design tab");
    for (let round = 0; round < 6; round++) {
      await d.openPage("TurnsHome");
      await page.waitForTimeout(Math.random() * 200);
      await d.openPage("TurnsScan");
      await page.waitForTimeout(Math.random() * 200);
    }
    await d.shows(d.el(scene), 0.5, 0.5, red, "the scan drawn in the Design tab after its pages switched");
    for (const tab of ["Run", "Objects", "Design"]) {
      await d.tab(tab);
      await page.waitForTimeout(300);
    }
    await d.shows(d.el(scene), 0.5, 0.5, red, "the scan drawn in the Design tab after its tabs switched");

    // a restarted HMI counts its batches from the start again, and the screen takes them
    await page.goto("about:blank");
    await sys.restart();
    await flows("after the HMI restarted");
  } finally {
    await context.close();
    way.close();
  }
}
