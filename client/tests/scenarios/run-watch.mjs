// A screen gets the values of only the imports its pages show, with only the fields they read.
// A screen on a page that shows no camera gets none of its pictures, one whose page reads the
// camera's width gets the width alone, one whose page reads its picture gets them, and one whose
// page plays the camera's video gets none, as the video never needs them. The editor gets them
// while its Objects tab previews every member, and in its Run tab only while the page there reads
// the picture.

import { countBig } from "../links.mjs";

export default async function ({ page, hmi, sys, check, eventually }) {
  check(sys.transcoder, "rant-transcoder is not built: build transcoder-rant or set HMI_TRANSCODER");
  await hmi.import("Line.WatchCam", "Line1/LabelCam");
  const none = await hmi.addPage("Watch none");
  await hmi.addElement(none, "span", { name: "sum", x: "2", y: "2", w: "20", h: "4", text: "1 + 1" });
  const width = await hmi.addPage("Watch width");
  const shown = await hmi.addElement(width, "span", { name: "width", x: "2", y: "2", w: "20", h: "4", text: "String(Line.WatchCam.width)" });
  const read = await hmi.addPage("Watch read");
  await hmi.addElement(read, "span", { name: "bytes", x: "2", y: "2", w: "20", h: "4", text: "String(Line.WatchCam.data.length)" });
  const video = await hmi.addPage("Watch video");
  await hmi.addElement(video, "media", { name: "label", x: "2", y: "2", w: "40", h: "30", src: "Line.WatchCam" });

  const context = await page.context().browser().newContext();
  await context.addInitScript(countBig);
  const big = (p) => p.evaluate(() => window.__big ?? 0);
  /** The pictures `p` gets in 1.5 s. */
  const comes = async (p) => {
    const before = await big(p);
    await p.waitForTimeout(1500);
    return (await big(p)) - before;
  };
  /** An operator's screen opened on `id`, settled a while. */
  const operator = async (id) => {
    const started = hmi.next((m) => m.type === "project");
    hmi.send({ type: "set_start", page: id });
    await started;
    const p = await context.newPage();
    await p.goto(`${sys.url}/run`);
    await p.locator(".run-layer").first().waitFor();
    await p.waitForTimeout(1000);
    return p;
  };
  try {
    const bare = await operator(none);
    check((await comes(bare)) === 0, "a screen whose page shows no camera got its pictures");
    const narrow = await operator(width);
    await eventually(async () => /^\d+$/.test(((await narrow.locator(`.run-layer .el[data-id="${shown}"]`).textContent()) ?? "").trim()), "the camera's width shown");
    check((await comes(narrow)) === 0, "a screen whose page reads only the camera's width got its pictures");
    const reads = await operator(read);
    check((await comes(reads)) >= 3, "a screen whose page reads the camera got too few of its pictures");
    const plays = await operator(video);
    await plays.locator("video").first().waitFor();
    await plays.waitForTimeout(1000);
    check((await comes(plays)) === 0, "a screen whose page plays the camera's video got its pictures too");
    check((await comes(bare)) === 0, "the screen whose page shows no camera got its pictures once others showed it");

    const editor = await context.newPage();
    await editor.goto(sys.url);
    await editor.locator(".tab", { hasText: "Objects" }).click();
    await eventually(async () => (await comes(editor)) >= 3, "the editor's Objects tab to get the camera's pictures", 8000);
    const run = async (name) => {
      await editor.locator(".tab", { hasText: "Design" }).click();
      await editor.locator(".screen:not([hidden]) .page-row", { hasText: new RegExp(`^${name}`) }).click();
      await editor.locator(".tab", { hasText: "Run" }).click();
      await editor.waitForTimeout(1000);
    };
    await run("Watch none");
    check((await comes(editor)) === 0, "the editor's Run tab on a page without the camera got its pictures");
    await run("Watch read");
    await eventually(async () => (await comes(editor)) >= 3, "the editor's Run tab on the page that reads the camera to get its pictures", 8000);
  } finally {
    await context.close();
  }
}
