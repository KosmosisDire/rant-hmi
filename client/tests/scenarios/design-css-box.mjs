// The More CSS box: a property completes before a line's colon and a value's names after it,
// both in colour. A value is an expression, and plain CSS the browser takes is kept as text,
// a template where it names theme tokens, so they stay live and a number in it is in units.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("CSS box");
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "4", y: "4", w: "16", h: "8", background: "#2a2f35" });
  await d.openPage("CSS box");
  await d.select("Card");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const box = right.locator(".editor.css");

  await box.click();
  await page.keyboard.type("box-sh");
  await page.locator(".suggest-row", { hasText: "box-shadow" }).first().click();
  await eventually(async () => (await box.inputValue()) === "box-shadow: ", async () => `the property to complete, it reads "${await box.inputValue()}"`);
  await page.keyboard.type("0 0.2 0.8 $acc");
  await page.locator(".suggest-row", { has: page.locator(".suggest-name", { hasText: /^\$accent$/ }) }).click();
  check((await box.inputValue()) === "box-shadow: 0 0.2 0.8 $accent", "the token to complete");
  const hl = right.locator(".draft pre.hl");
  check((await hl.locator(".hl-prop").first().textContent()) === "box-shadow", "the property is not coloured as one");
  check((await hl.locator(".hl-local").allTextContents()).includes("$accent"), "the token is not coloured as one");
  await box.press("Control+Enter");
  await eventually(() => props(hmi, pageId, card)["box-shadow"] === "`0 0.2 0.8 ${$accent}`", () => `the shadow kept as a template, it is ${props(hmi, pageId, card)["box-shadow"]}`);
  const style = (k) => d.el(card).evaluate((el, k) => getComputedStyle(el)[k], k);
  await eventually(async () => (await style("boxShadow")).includes("0px 2px 8px"), async () => `the shadow drawn in units, it is ${await style("boxShadow")}`);

  // an expression stays one, plain CSS becomes text, and a typo stays as typed with a note
  await d.css("box-shadow: 0 0.2 0.8 $accent\nmargin: $space 0\noutline-offset: 0.2\ncursor: pointer\noutline: Line.Running ?");
  await eventually(() => props(hmi, pageId, card).cursor === '"pointer"', "plain CSS kept as text");
  const now = props(hmi, pageId, card);
  check(now.margin === "`${$space} 0`" && now["outline-offset"] === "0.2" && now.outline === "Line.Running ?", `the values kept are ${JSON.stringify(now)}`);
  await eventually(async () => (await style("marginTop")) === "8px" && (await style("outlineOffset")) === "2px", "the token's number drawn in units");
  await right.locator(".field-note", { hasText: "outline:" }).waitFor();
  await d.css("");
  await eventually(() => props(hmi, pageId, card).margin === undefined, "the box to clear");
}
