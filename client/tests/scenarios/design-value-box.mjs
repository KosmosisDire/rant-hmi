// A designer changes properties from the lead on each field's left: drags a number, picks a
// colour and a theme token, picks a choice, and sets a border one part at a time, binding only
// its colour. A drag never overwrites an expression.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Leads");
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "44", y: "44", w: "220", h: "132", background: "#2a2f35" });
  const label = await hmi.addElement(pageId, "span", { name: "Label", x: "44", y: "220", w: "220", h: "44", text: '"Speed"' });
  hmi.send({ type: "set_token", name: "leadTone", token: { name: "leadTone", dark: "#4a8fd6", light: "#256ebe" } });
  await d.openPage("Leads");
  await d.el(card).click();
  const now = () => props(hmi, pageId, card);
  const lead = (name) => page.locator(".sidebar.right .field, .popover .field").filter({ has: page.locator("label, .lead.inside", { hasText: new RegExp(`^${name}$`) }) }).locator(".lead");
  const scrub = async (name, dx, modifiers = []) => {
    const b = await lead(name).boundingBox();
    await d.gesture(b.x + b.width / 2, b.y + b.height / 2, dx, 0, modifiers);
  };

  await scrub("x", 30);
  await eventually(() => now().x === "74", "x to follow a 30 pixel drag of its lead");
  await scrub("x", -20, ["Shift"]);
  await eventually(() => now().x === "72", "Shift to scrub a tenth as far");
  await page.keyboard.press("Control+z");
  await eventually(() => now().x === "74", "one undo to take back one scrub");

  // a drag that Escape stops leaves the value as it was
  const b = await lead("y").boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(200);
  check(now().y === "44", `Escape did not stop the scrub, y is ${now().y}`);
  await eventually(async () => (await d.field("y").inputValue()) === "44", "the field to show y as it was");

  // an expression is never scrubbed over
  await d.setField("w", "Speed * 100");
  await scrub("w", 40);
  await page.waitForTimeout(200);
  check(now().w === "Speed * 100", `a drag wrote over an expression: ${now().w}`);
  await d.setField("w", "220");

  // a colour from the picker, then a theme token
  await lead("Fill").click();
  const sv = await page.locator(".cp-sv").boundingBox();
  await d.gesture(sv.x + sv.width * 0.9, sv.y + sv.height * 0.1, 5, 0);
  await eventually(() => /^#[0-9a-f]{6}$/.test(now().background) && now().background !== "#2a2f35", "the picked colour to be kept");
  await page.locator(".cp-token", { hasText: "$leadTone" }).click();
  await eventually(() => now().background === "$leadTone", "a token to be kept by its name");
  check((await page.locator(".colour-picker").count()) === 0, "the picker stayed open after a token was picked");

  // a border one part at a time: the width brings a style with it, the colour binds alone
  await page.locator(".border-sum").click();
  await d.setField("Width", "2");
  await eventually(() => now()["border-width"] === "2" && now()["border-style"] === '"solid"', "a width to bring a solid style");
  await d.setField("Colour", 'Running ? "#2e7d32" : "#c62828"');
  await eventually(() => now()["border-color"] === 'Running ? "#2e7d32" : "#c62828"', "the colour alone to be bound");
  check(now()["border-width"] === "2", "binding the colour changed the width");
  const drawn = await d.el(card).evaluate((el) => getComputedStyle(el).borderTopStyle + " " + getComputedStyle(el).borderTopWidth);
  check(drawn === "solid 2px", `the border is drawn as ${drawn}`);
  check(await page.locator(".border-sum .linked").count() === 1, "the bound part is not marked");
  await page.keyboard.press("Escape");

  // a choice from its list
  await d.el(label).click();
  await lead("Align").click();
  await page.locator(".popover .menu-item", { hasText: /^center$/ }).click();
  await eventually(() => props(hmi, pageId, label)["text-align"] === '"center"', "the picked choice to be kept");
}
