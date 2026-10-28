// A designer gives a card a drop shadow from its Shadow field's panel: the first part written
// fills the rest so it shows, a token colour keeps it live as code the panel still edits, and
// code that is not one shadow leaves the panel shut.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Shadows");
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "4", y: "4", w: "20", h: "12", background: "#2a2f35" });
  await d.openPage("Shadows");
  await d.select("Card");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const lead = right.locator(".field", { has: page.locator("label", { hasText: /^Shadow$/ }) }).locator(".lead");
  const shadow = () => props(hmi, pageId, card)["box-shadow"];
  const drawn = () => d.el(card).evaluate((e) => getComputedStyle(e).boxShadow);

  await lead.click();
  await d.setField("Y", "1");
  await eventually(() => shadow() === '"0 1 0.8 0 #00000066"', () => `the shadow from its first part, not ${shadow()}`);
  // a bare number in it is units
  await eventually(async () => (await drawn()) === "rgba(0, 0, 0, 0.4) 0px 10px 8px 0px", async () => `Design to draw it, not ${await drawn()}`);

  await d.setField("Colour", "$border");
  await eventually(() => shadow() === "`0 1 0.8 0 ${$border}`", () => `the token kept as code, not ${shadow()}`);
  await d.setField("Blur", "2");
  await eventually(() => shadow() === "`0 1 2 0 ${$border}`", () => `the blur written beside the token, not ${shadow()}`);
  check((await d.field("Colour").inputValue()) === "$border", "the panel shows the token");
  await page.keyboard.press("Escape");

  // code that is not one shadow is edited in its box alone
  await d.setField("Shadow", 'lit ? "0 0 1 $accent" : "none"');
  await eventually(() => shadow() === 'lit ? "0 0 1 $accent" : "none"', "the code kept");
  await lead.click();
  await page.waitForTimeout(200);
  check((await page.locator(".popover .field", { has: page.locator("label", { hasText: /^Blur$/ }) }).count()) === 0, "the panel opened on code");
}
