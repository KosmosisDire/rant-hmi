// A scene's points that are a big value draw in the screen's data worker, which keeps the value
// and hands the main thread far lists, each its length alone, and the screen takes each new one
// as it draws. Something else on the page reading the value whole brings its lists to the main
// thread too while it does, and the scene draws on. Points code makes from the value need it
// whole, and draw too. A screen whose second socket is refused gets the value on its link, and
// takes each there.

import { refusing } from "../links.mjs";

/** Counts the values of ScanW the data worker hands the page, by how their points came. */
function count() {
  const own = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage");
  Object.defineProperty(Worker.prototype, "onmessage", {
    get: own.get,
    set(f) {
      own.set.call(this, (e) => {
        const points = e.data?.msg?.values?.find((u) => u.alias === "Cell.ScanW")?.value?.points;
        if (points) {
          const seen = (window.__scan ??= { far: 0, whole: 0, other: 0 });
          seen["far" in points ? "far" : "packed" in points ? "whole" : "other"]++;
        }
        f(e);
      });
    },
  });
}

export default async function ({ page, hmi, sys, d, check, eventually }) {
  await hmi.import("Cell.ScanW", "Cell/Scan");
  const pageId = await hmi.addPage("Scene worker");
  // seen from above, the floor filling the middle
  const scene = await hmi.addElement(pageId, "scene", { name: "cell", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "4" });
  const points = await hmi.addElement(pageId, "points", { name: "scan", points: "Cell.ScanW.points", size: "0.05", color: '"#ff0000"' }, scene);
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: pageId });
  await started;

  const context = await page.context().browser().newContext();
  await context.addInitScript(count);
  try {
    const screen = await context.newPage();
    await screen.goto(`${sys.url}/run`);
    const el = (id, on = screen) => on.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
    const red = ([r, g, b]) => r > 120 && g < 60 && b < 60;
    await d.shows(el(scene), 0.5, 0.5, red, "the scan drawn in the middle of the scene");
    const seen = (on) => on.evaluate(() => ({ ...(window.__scan ?? { far: 0, whole: 0, other: 0 }) }));
    /** How the scan's values came in 2 s. */
    const comes = async (on = screen) => {
      const before = await seen(on);
      await on.waitForTimeout(2000);
      const after = await seen(on);
      return { far: after.far - before.far, whole: after.whole - before.whole, other: after.other - before.other };
    };
    let got = await comes();
    check(got.far >= 5 && got.whole === 0 && got.other === 0, `the scene alone read the scan, which came to the page ${JSON.stringify(got)} in 2 s, not far at 5 a second`);

    const way = await refusing(Number(new URL(sys.url).port));
    try {
      const plain = await context.newPage();
      await plain.goto(`${way.url}/run`);
      await d.shows(el(scene, plain), 0.5, 0.5, red, "the scan drawn on the screen whose second socket is refused");
      got = await comes(plain);
      check(got.far >= 5, `the screen whose second socket is refused got the scan ${JSON.stringify(got)} in 2 s, not at 5 a second`);
      await plain.close();
    } finally {
      way.close();
    }

    // a span reading its length reads it whole, and the scene draws on
    const span = await hmi.addElement(pageId, "span", { name: "length", x: "2", y: "44", w: "20", h: "4", text: "String(Cell.ScanW.points.length)" });
    await el(span).filter({ hasText: /^20000$/ }).waitFor({ timeout: 10000 });
    got = await comes();
    check(got.whole >= 5 && got.far === 0, `with a span reading the scan whole it came to the page ${JSON.stringify(got)} in 2 s, not whole`);
    await d.shows(el(scene), 0.5, 0.5, red, "the scan still drawn with the span reading it");
    check(!(await el(scene).getAttribute("title")), `the scene says ${await el(scene).getAttribute("title")}`);

    // with the span gone the scene alone reads it again
    await hmi.removeElement(pageId, span);
    await eventually(async () => (await comes()).far >= 5, "the scan to come far again once the span went", 10000);

    // points code picks from the scan need it whole: the part alone, never the floor
    await hmi.setProps(pageId, points, { name: "scan", points: "Cell.ScanW.points.filter((p) => p.z > 0.1)", size: "0.05", color: '"#ff0000"' });
    await eventually(async () => (await comes()).whole >= 5, "the scan to come whole for the points picked from it", 10000);
    await d.shows(el(scene), 0.5, 0.05, (c) => !red(c), "the floor gone from the scene, the part alone drawn");
    check(!(await el(scene).getAttribute("title")), `the scene says ${await el(scene).getAttribute("title")}`);
  } finally {
    await context.close();
  }
}
