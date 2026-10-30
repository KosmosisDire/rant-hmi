// An enum a mesh import's type holds reads in code by its type's name, its options a list: a
// text shows them, completion offers the enum and then its options, and a handler on the
// backend reads them too. An object of the same name hides it.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Cage.EnumJob", "Cage/Gp12/RunJob", "write");
  const job = () => hmi.state.enums.find((e) => e.name === "Job");
  await eventually(() => hmi.state.entities.some((e) => e.name === "Cage/Gp12/RunJob"), "RunJob");
  await eventually(() => job()?.options.join() === "None,Home249,Jog,Pick,Place", () => `the Job enum, the enums are ${JSON.stringify(hmi.state.enums)}`);

  const pageId = await hmi.addPage("Enums");
  const list = await hmi.addElement(pageId, "span", { name: "List", x: "4", y: "4", w: "60", h: "4", text: 'Job.options.join(", ")', color: "#e4e6e8" });
  const ask = await hmi.addElement(pageId, "div", { name: "Ask", x: "4", y: "12", w: "12", h: "6", background: "#4a8fd6" });
  await hmi.setHandler(pageId, ask, "tap", "notify(Job.options.at(-1));");
  await d.openPage("Enums");
  await eventually(async () => (await d.el(list).textContent()) === "None, Home249, Jog, Pick, Place", "the text to list the options");

  await d.el(list).click();
  const text = d.field("Text");
  await text.click();
  await text.fill("");
  await page.keyboard.type("Jo");
  const offered = page.locator(".suggest-row", { has: page.locator(".suggest-name", { hasText: /^Job$/ }) });
  await offered.waitFor();
  check((await offered.locator(".suggest-type").textContent()) === "enum", `the enum offered as ${await offered.locator(".suggest-type").textContent()}`);
  await page.keyboard.type("b.");
  await eventually(async () => (await page.locator(".suggest .suggest-name").allTextContents()).join() === "options", "its options offered after the dot");
  await page.keyboard.press("Escape");

  await d.tab("Run");
  await page.locator(`.run-layer:not([hidden]) .el[data-id="${ask}"]`).click();
  await page.locator(".notice.info", { hasText: /^Place$/ }).waitFor({ timeout: 4000 });

  await hmi.addObject("Job");
  await eventually(() => !job(), "the object named Job to hide the enum");
  hmi.send({ type: "set_object", name: "Job", object: null });
  await eventually(() => !!job(), "the enum back once the object goes");
}
