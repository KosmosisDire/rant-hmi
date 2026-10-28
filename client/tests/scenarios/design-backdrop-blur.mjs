// A designer frosts a pane over stripes from its Backdrop blur field: a number blurs what shows
// through it by that many units, in Design and in Run, and CSS text in its place is taken as
// written.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Frosted");
  await hmi.addElement(pageId, "div", { name: "Stripes", x: "4", y: "4", w: "30", h: "20", background: '"repeating-linear-gradient(90deg, #cf9a3a 0 6px, #2a2f35 6px 12px)"' });
  const glass = await hmi.addElement(pageId, "div", { name: "Glass", x: "8", y: "8", w: "20", h: "10" });
  await d.openPage("Frosted");
  // how far the red of the stripes seen through the pane swings across its middle
  const swing = async () => {
    const reds = [];
    for (let i = 0; i < 12; i++) reds.push((await d.colour(d.el(glass), 0.3 + i * 0.03, 0.5))[0]);
    return Math.max(...reds) - Math.min(...reds);
  };
  check((await swing()) > 100, "the stripes do not show sharp through the bare pane");
  await d.select("Glass");
  await d.setField("Backdrop blur", "0.8");
  await eventually(() => props(hmi, pageId, glass)["backdrop-filter"] === "0.8", "the blur kept");
  const blur = (l) => l.evaluate((e) => getComputedStyle(e).backdropFilter);
  await eventually(async () => (await blur(d.el(glass))) === "blur(8px)", async () => `Design to blur by 8 px, not ${await blur(d.el(glass))}`);
  await eventually(async () => (await swing()) < 40, "the stripes to blur under the pane");

  await d.setField("Backdrop blur", '"blur(4px) saturate(1.5)"');
  await eventually(async () => (await blur(d.el(glass))) === "blur(4px) saturate(1.5)", async () => `the CSS text taken, not ${await blur(d.el(glass))}`);

  await d.tab("Run");
  const run = page.locator(`.run-layer:not([hidden]) .el[data-id="${glass}"]`);
  await eventually(async () => (await run.count()) === 1 && (await blur(run)) === "blur(4px) saturate(1.5)", "Run to blur it too");
}
