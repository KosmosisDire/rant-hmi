// A user types CSS that cannot show: the element is marked on the canvas and the inspector says
// why, under the box it was typed in. Words without quotes get a fix, and a value or a name
// the browser does not take is named.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Bad CSS");
  const card = await hmi.addElement(pageId, "div", { name: "Card", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await d.openPage("Bad CSS");
  await d.select("Card");
  const right = page.locator(".screen:not([hidden]) .sidebar.right");
  const notes = right.locator(".field-note");
  const faulty = () => d.el(card).evaluate((el) => el.classList.contains("faulty"));

  // plain CSS the browser takes is kept as text, and words it does not take stay as typed
  await d.css("box-shadow: 0 2px 8px #0008");
  await eventually(() => props(hmi, pageId, card)["box-shadow"] === '"0 2px 8px #0008"', "the shadow kept as text");
  check((await notes.count()) === 0 && !(await faulty()), "a shadow the browser takes is marked");
  await d.css("box-shadow: 0 2px 8px blah");
  await eventually(async () => (await notes.allTextContents()).some((t) => t.startsWith("box-shadow: ")), "a note on the shadow");
  check(await faulty(), "the canvas does not mark the element");
  await right.locator(".field-fix", { hasText: "Make it text" }).click();
  await eventually(() => props(hmi, pageId, card)["box-shadow"] === '"0 2px 8px blah"', "the fix to quote the shadow");
  await eventually(async () => (await notes.allTextContents()).includes("0 2px 8px blah is not a box-shadow the browser takes"), "the note to name what the browser drops");
  await d.css("");
  await eventually(async () => (await notes.count()) === 0 && !(await faulty()), "the note and the mark to go");

  await d.css('colr: "red"');
  await eventually(async () => (await notes.allTextContents()).includes("red is not a colr the browser takes"), "a note naming what the browser drops");
  check(await faulty(), "a property the browser drops leaves the element unmarked");
  await d.css("");

  await d.setField("Fill", '"blah"');
  await eventually(async () => (await notes.allTextContents()).includes("blah is not a background the browser takes"), "the fill's own field to say why");
  await d.setField("Fill", "#2a2f35");
  await eventually(async () => (await notes.count()) === 0 && !(await faulty()), "a good fill to clear it");
}
