// Every name the language gives comes from one list, which each place's completion offers: the
// math everywhere, a page handler's own functions, a component's emit, JavaScript's own after a
// dot, and the hint for what a call takes. The list holds every math name and no other.

import { API, apiIn } from "../../src/lang/api.js";
import { LIBRARY } from "../../src/lang/math.js";

export default async function ({ page, hmi, d, check, eventually }) {
  // the list and the math library name the same things
  const math = Object.keys(LIBRARY).filter((n) => !n.startsWith("__"));
  const listed = API.filter((a) => !a.places && !a.standard).map((a) => a.name);
  check(math.join() === listed.join(), `the list names ${listed}, the math library ${math}`);
  for (const a of API) if (math.includes(a.name)) check(typeof LIBRARY[a.name] !== "function" || Array.isArray(a.takes), `${a.name} says nothing of what it takes`);

  const pageId = await hmi.addPage("Everything");
  const text = await hmi.addElement(pageId, "span", { name: "Label", x: "4", y: "4", w: "24", h: "4", text: '""' });
  await d.openPage("Everything");
  await d.el(text).click();
  const list = page.locator(".suggest .suggest-name");
  const names = () => list.allTextContents();
  // the first letters of a name, short of the whole, which needs no list, and one more while
  // the list is full of names other scenarios left, as keysArmed crowds out keys
  const offered = async (box, name, want, what) => {
    let now = [];
    for (let n = Math.max(1, Math.min(3, name.length - 1)); n <= name.length; n++) {
      await box.fill("");
      await page.keyboard.type(name.slice(0, n));
      await eventually(async () => (now = await names()).length > 0, () => `${what}: a list for ${name.slice(0, n)}`);
      if (now.includes(want) || now.length < 12) break;
    }
    check(now.includes(want), `${what}: ${want} among ${now.join(", ")}`);
  };

  // an expression: each name the list gives it, by its first letters
  const field = d.field("Text");
  await field.click();
  for (const a of apiIn("expression")) await offered(field, a.name, a.name, "an expression");
  // what a call takes shows while the caret is in it
  await field.fill("");
  await page.keyboard.type("clamp(1, ");
  await eventually(async () => (await page.locator(".signature").textContent())?.includes("clamp(x, low, high)"), "the hint for clamp");
  check((await page.locator(".signature .sign-at").textContent()) === "low", "the hint marks the wrong value");
  // after a dot, JavaScript's own: a number's methods and Math's
  await field.fill("");
  await page.keyboard.type("Line.Speed.");
  await eventually(async () => (await names()).includes("toPrecision"), "a number's methods");
  await field.fill("");
  await page.keyboard.type("Math.ro");
  await eventually(async () => (await names()).includes("round"), "Math's functions");
  await page.keyboard.press("Escape");

  // a page's handler: its own functions too
  await d.handler("tap", "");
  const code = d.code("tap");
  for (const a of apiIn("handler").filter((x) => x.places)) await offered(code, a.name, a.name, "a handler");
}
