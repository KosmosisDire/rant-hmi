// A new user types expressions with the list's help: names, fields, a number's format, picked
// by keys or a click. Enter with nothing picked keeps the text, and handlers offer send.

import { props } from "../designer.mjs";

export default async function ({ page, hmi, d, check, eventually }) {
  const pageId = await hmi.addPage("Complete");
  const id = await hmi.addElement(pageId, "span", { name: "Joint", x: "44", y: "44", w: "264", h: "44", text: '""', color: "#e4e6e8" });
  await d.openPage("Complete");
  await d.el(id).click();
  const list = page.locator(".suggest .suggest-name");
  const names = () => list.allTextContents();
  const pick = async (name) => {
    const at = (await names()).indexOf(name);
    check(at >= 0, `${name} is not offered among ${(await names()).join(", ")}`);
    for (let i = 0; i <= at; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  };

  const text = d.field("Text");
  await text.click();
  check((await list.count()) === 0, "a filled field opened the list on focus");
  await text.fill("");
  await page.keyboard.type("Jo");
  await eventually(async () => (await names()).includes("Joints"), "Joints in the list");
  check((await page.locator(".suggest-row.chosen").count()) === 0, "the list picked a row by itself");
  await pick("Joints");
  await page.keyboard.type(".");
  await eventually(async () => (await names()).join() === "position,velocity,effort", "the fields of Joints in schema order");
  await page.keyboard.type("pos");
  await pick("position");
  await page.keyboard.type("[0].");
  await eventually(async () => (await names()).includes("toFixed"), "a number's format");
  await pick("toFixed");
  await page.keyboard.press("Enter");
  await eventually(() => props(hmi, pageId, id).text === "Joints.position[0].toFixed(1)", "the expression built from picks");
  await eventually(async () => /^-?\d+\.\d$/.test(await d.el(id).textContent()), "the live joint on the canvas");

  await text.click();
  await text.fill("Spee");
  await page.keyboard.press("Enter");
  await eventually(() => props(hmi, pageId, id).text === "Spee", "Enter with nothing picked to keep what was typed");

  await page.locator('button[title="Add an event"]').click();
  await page.locator(".event-menu button", { hasText: "Tap" }).click();
  const code = page.locator(".screen:not([hidden]) .sidebar.right .handler .editor.code");
  await code.click();
  await page.keyboard.type("Sp");
  await page.locator(".suggest-row", { hasText: "Speed" }).click();
  await page.keyboard.type(" = 1;");
  await page.keyboard.press("Control+Enter");
  await eventually(() => hmi.page(pageId).children[0].handlers[0]?.code === "Speed = 1;", "the handler typed with a click on the list");

  // a handler sends on a topic imported to write, which a property never offers
  await hmi.import("JogOut", "Line1/Jog", "write");
  await code.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("JogO");
  await pick("JogOut");
  await page.keyboard.type(".");
  await eventually(async () => (await names())[0] === "send", "send on the topic");
  await page.keyboard.press("Escape");
  await text.click();
  await text.fill("");
  await page.keyboard.type("JogO");
  await eventually(async () => (await names()).includes("JogOut"), "the topic to read in a property");
  await page.keyboard.press("Escape");
}
