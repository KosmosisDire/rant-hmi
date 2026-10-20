// A new user types into the inspector: a number, a colour, a live value, and words without
// quotes, which fail and offer to become text. The canvas shows each as it should.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Expressions");
  await d.openPage("Expressions");
  await d.addRow("Text");
  const id = await eventually(() => hmi.page(pageId)?.children[0]?.id, "the text");
  const at = () => props(hmi, pageId, id);
  const shown = () => d.el(id).textContent();

  check(at().text === '"Text"', `a new text starts as ${at().text}`);
  await eventually(async () => (await shown()) === "Text", "the new text to show its words");

  await d.setField("Text", "Speed.toFixed(2)");
  await eventually(async () => /^\d+\.\d\d$/.test(await shown()), "the live speed");
  check(await d.field("Text").evaluate((f) => f.closest(".field").classList.contains("bound")), "a live value is not marked bound");

  await d.setField("Colour", "#ff8800");
  await eventually(async () => (await d.el(id).evaluate((e) => getComputedStyle(e).color)) === "rgb(255, 136, 0)", "the colour");
  check(!(await d.field("Colour").evaluate((f) => f.closest(".field").classList.contains("bound"))), "a colour is marked bound");

  await d.setField("Text", "Belt running");
  const note = page.locator(".field", { has: page.locator("label", { hasText: /^Text$/ }) }).locator(".field-note");
  await note.waitFor();
  await note.locator(".field-fix", { hasText: "Make it text" }).click();
  await eventually(() => at().text === '"Belt running"', "the words to become text");
  await eventually(async () => (await shown()) === "Belt running", "the words to show");
  check((await note.count()) === 0, "the note stays after the fix");

  await d.setField("Name", "Belt label");
  await eventually(() => at().name === "Belt label", "the name to be written as typed");
  check(!(await d.field("Name").evaluate((f) => f.closest(".field").classList.contains("bound"))), "a name is marked bound");
}
