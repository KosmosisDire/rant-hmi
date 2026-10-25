// A big value's import edited while a screen's scene draws it: its fields narrowed so its points
// lack z, which the scene says in the editor, and widened again, its alias renamed, which the
// page follows, and the import removed, then made again. After each the scene draws it again and
// its values come at their pace, none waiting on word of one taken that never comes.

import { countBig } from "../links.mjs";

const red = ([r, g, b]) => r > 120 && g < 60 && b < 60;
const NOT_POINTS = "not a list of points";

export default async function ({ page, hmi, sys, d, check, eventually }) {
  await hmi.import("ScanE", "Cell/Scan");
  const pageId = await hmi.addPage("Import edit");
  // seen from above, the floor filling the middle
  const scene = await hmi.addElement(pageId, "scene", { name: "cell", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "4" });
  const points = await hmi.addElement(pageId, "points", { name: "scan", points: "ScanE.points", size: "0.05", color: '"#ff0000"' }, scene);
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: pageId });
  await started;

  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(countBig);
  try {
    const screen = await context.newPage();
    await screen.goto(`${sys.url}/run`);
    const el = screen.locator(`.run-layer:not([hidden]) .el[data-id="${scene}"]`);
    // the editor's Design tab shows what a scene found wrong, as a screen never does
    await d.openPage("Import edit");
    const said = async () => (await d.el(scene).getAttribute("title")) ?? "";
    const lapses = () => (sys.backend.log.match(/never said it took/g) ?? []).length;
    /** The scan's values the screen got in `seconds`. */
    const got = async (seconds) => {
      const n = await screen.evaluate(() => window.__big ?? 0);
      await screen.waitForTimeout(seconds * 1000);
      return (await screen.evaluate(() => window.__big ?? 0)) - n;
    };
    /** The scene draws the scan again, saying nothing is wrong, and it comes at its 5 a second. */
    const draws = async (what) => {
      let last = "";
      await eventually(async () => (last = await said()) === "", () => `the scene to say nothing ${what}, not "${last}"`, 10000);
      await d.shows(el, 0.5, 0.5, red, `the scan drawn ${what}`);
      const n = await got(2);
      check(n >= 7, `${what}, the screen got ${n} of the scan's values in 2 s`);
    };
    const now = (alias) => hmi.state.imports.find((i) => i.alias === alias);
    /** Changes import `alias` as the Data tab's inspector does. */
    const change = async (alias, to) => {
      const listed = hmi.next((m) => m.type === "imports");
      hmi.send({ type: "change_import", alias, import: { ...now(alias), fields: undefined, rate: undefined, ...to } });
      await listed;
    };
    const before = lapses();
    await draws("at first");

    // without z its points are no points, until z comes again
    await change("ScanE", { fields: ["points.x", "points.y"] });
    let last = "";
    await eventually(async () => (last = await said()).includes(NOT_POINTS), () => `the scene to say its points lack z, not "${last}"`, 10000);
    await change("ScanE", { fields: ["points"] });
    await draws("with its points' every field again");

    // renamed, the page reads it by its new name
    await change("ScanE", { alias: "ScanR" });
    await eventually(() => hmi.page(pageId).children.find((e) => e.id === scene)?.children.find((e) => e.id === points)?.props.points === "ScanR.points", "the page to read the scan by its new name");
    await draws("by its new name");

    // without the import the scene draws no points, and with it again draws them
    await hmi.unimport("ScanR");
    await d.shows(el, 0.5, 0.5, (c) => !red(c), "the scene without points once the import went");
    await hmi.import("ScanR", "Cell/Scan");
    await draws("once it was imported again");
    check(lapses() === before, `the backend waited on word of a value taken ${lapses() - before} times`);
  } finally {
    await context.close();
  }
}
