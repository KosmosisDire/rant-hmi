// A part that fills its row takes a most and a least from its w label's menu, each starting at
// the width drawn now and shown as a field to change, and a second pick takes it away. Where
// parts overlap the last draws on top, until the row puts the first on top.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Limits");
  const row = await hmi.addElement(pageId, "div", { name: "Row", x: "4", y: "4", w: "40", h: "hug", layout: '"right"', gap: "1", padding: "1", background: "#2a2f35" });
  const fill = await hmi.addElement(pageId, "div", { name: "Filler", w: "fill", h: "4", background: "#d2574b" }, row);
  const fixed = await hmi.addElement(pageId, "div", { name: "Fixed", w: "6", h: "4", background: "#4a8fd6" }, row);
  await d.openPage("Limits");
  const k = async () => (await page.locator(".artboard .page").boundingBox()).width / 128;
  const width = async () => Math.round(((await d.box(fill)).width / (await k())) * 10) / 10;
  let seen;
  const is = (w) => eventually(async () => (seen = await width()) === w, () => `the filler to be ${w} wide, it is ${seen}`);
  await is(31);

  await d.select("Filler");
  await d.size("w", "Max width");
  await eventually(() => props(hmi, pageId, fill)["max-width"] === "31", "a most that starts at the width drawn");
  await d.setField("max w", "10");
  await is(10);
  await d.size("w", "Max width");
  await eventually(() => props(hmi, pageId, fill)["max-width"] === undefined, "a second pick to take the most away");
  check((await d.field("max w").count()) === 0, "the most's field stays");
  await is(31);

  await hmi.setProps(pageId, row, { w: "10" });
  await is(1);
  await d.size("w", "Min width");
  await d.setField("min w", "5");
  await is(5);

  // the fixed part pulled back over the filler draws on top of it, unless the row says first
  await hmi.setProps(pageId, fixed, { "margin-left": "-3" });
  await d.deselect();
  const top = async () => {
    const [a, b] = [await d.box(fill), await d.box(fixed)];
    const [x, y] = [(b.x + a.x + a.width) / 2, a.y + a.height / 4];
    return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".el[data-id]")?.getAttribute("data-id"), [x, y]);
  };
  await eventually(async () => (seen = await top()) === fixed, () => `the last part on top, ${seen} is`);
  await d.select("Row");
  await page.locator(".screen:not([hidden]) .sidebar.right .choice button", { hasText: /^First$/ }).click();
  await eventually(() => props(hmi, pageId, row).stack === '"first"', "the row to put its first part on top");
  await eventually(async () => (seen = await top()) === fill, () => `the first part on top, ${seen} is`);
}
