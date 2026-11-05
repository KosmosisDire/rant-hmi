// A big cloud goes to the GPU a share a frame, never whole, as Chrome holds the data worker while
// its GPU process hands on a write past 16 MB. Its buffers are made once by their size, never by
// bytes, and kept while its count changes a little from value to value, and its values keep
// coming, each taken once the scene shows it.

import { countBig } from "../links.mjs";

// what the worker writes in a frame at most, as draw.ts says
const SHARE = 4 << 20;

/** Keeps in the data worker what goes to the GPU: the largest write, the writes, and the buffers
 *  made by their size and those made with their bytes. */
function watch() {
  const p = WebGL2RenderingContext.prototype;
  const seen = (self.__gpu = { largest: 0, writes: 0, sized: 0, filled: 0 });
  const write = p.bufferSubData;
  p.bufferSubData = function (target, at, bytes, from, length) {
    const n = length === undefined ? bytes.byteLength : length * bytes.BYTES_PER_ELEMENT;
    seen.largest = Math.max(seen.largest, n);
    seen.writes++;
    return write.apply(this, arguments);
  };
  const make = p.bufferData;
  p.bufferData = function (target, bytes) {
    if (typeof bytes === "number") seen.sized++;
    else if (bytes && bytes.byteLength > 1 << 20) seen.filled++;
    return make.apply(this, arguments);
  };
}

export default async function ({ page, hmi, sys, d, check, eventually }) {
  await hmi.import("Cell.RoomB", "Cell/Room");
  const pageId = await hmi.addPage("Big cloud");
  // seen from above, the 6 by 4 m room in view, turning a little so the scene draws each frame
  const scene = await hmi.addElement(pageId, "scene", { name: "room", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2 + Math.sin(time.now / 500) * 0.05", pitch: "1.5", distance: "9", background: "#000000" });
  await hmi.addElement(pageId, "points", { name: "room", points: "Cell.RoomB", size: "0.02", color: '"#ff00ff"' }, scene);
  const started = hmi.next((m) => m.type === "project");
  hmi.send({ type: "set_start", page: pageId });
  await started;

  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(countBig);
  try {
    const screen = await context.newPage();
    const worker = new Promise((r) => screen.on("worker", (w) => w.url().includes("data.worker") && r(w)));
    await screen.goto(`${sys.url}/run`);
    const data = await worker;
    await data.evaluate(watch);
    const el = screen.locator(`.run-layer:not([hidden]) .el[data-id="${scene}"]`);
    await d.sees(el, { magenta: "r > 150 && b > 150 && g < 80" }, (s) => s.magenta > 5000, "the room's cloud drawn");

    // past its first values, whose buffers are made, the next go into them
    await screen.waitForTimeout(3000);
    await data.evaluate(() => Object.assign(self.__gpu, { largest: 0, writes: 0, sized: 0, filled: 0 }));
    const values = await screen.evaluate(() => window.__big ?? 0);
    await screen.waitForTimeout(5000);
    const got = (await screen.evaluate(() => window.__big ?? 0)) - values;
    const gpu = await data.evaluate(() => self.__gpu);
    check(got >= 4, `the room's values came at its 1 a second, ${got} in 5 s`);
    check(gpu.writes >= 2 * got && gpu.largest <= SHARE, `each 8 MB value went to the GPU a share at a time, its ${gpu.writes} writes up to ${gpu.largest} bytes`);
    check(gpu.filled === 0, `no buffer was made with its bytes, ${gpu.filled} were`);
    check(gpu.sized === 0, `the values went into the buffers the cloud had, its count changing, ${gpu.sized} made`);
    await d.sees(el, { magenta: "r > 150 && b > 150 && g < 80" }, (s) => s.magenta > 5000, "the room's cloud still drawn");
  } finally {
    await context.close();
  }
}
