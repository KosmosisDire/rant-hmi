// A user double clicks a text to type its words at once, double clicks an input to bind it,
// and double clicks a layer row to rename it.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, eventually }) {
  const pageId = await hmi.addPage("Typing");
  const text = await hmi.addElement(pageId, "span", { name: "Title", x: "44", y: "44", w: "264", h: "44", text: '"Old"', color: "#e4e6e8" });
  const field = await hmi.addElement(pageId, "input", { name: "Entry", x: "44", y: "132", w: "176", h: "44" });
  await d.openPage("Typing");
  const type = async (words) => {
    await page.keyboard.type(words);
    await page.keyboard.press("Enter");
  };

  await d.el(text).dblclick();
  await type('"New"');
  await eventually(() => props(hmi, pageId, text).text === '"New"', "the double clicked text to take the typing");

  await d.el(field).dblclick();
  // it has failed twice in full runs and never alone, so a failure says where the typing went
  const focused = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className} holding ${JSON.stringify(document.activeElement?.value)}`);
  await type("Speed");
  await eventually(() => props(hmi, pageId, field).value === "Speed", () => `the double clicked input to take its value, it holds ${JSON.stringify(props(hmi, pageId, field).value)} and the focus was on ${focused}`);

  await page.locator(".screen:not([hidden]) .sidebar.left .pane-body .list-row", { hasText: "Title" }).dblclick();
  await type("Heading");
  await eventually(() => props(hmi, pageId, text).name === "Heading", "the double clicked row to rename its layer");
}
