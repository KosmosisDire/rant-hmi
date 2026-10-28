// A user calls the mesh from a handler: inside the brackets of a send or a function call a hint
// over the line says what it takes, each value with its type, marks the one being typed, and
// offers the whole type as one value instead. It goes once the brackets close.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Line.Belt", "Line1/Conveyor", "write");
  await hmi.import("Line.Clear", "Line1/Reset", "write");
  const pageId = await hmi.addPage("Calls");
  const id = await hmi.addElement(pageId, "div", { name: "Go", x: "44", y: "44", w: "176", h: "88", background: "#2a2f35" });
  await d.openPage("Calls");
  await d.el(id).click();
  await d.addEvent("tap");
  await d.code("tap").click();
  const hint = page.locator(".signature");
  const head = async () => (await hint.locator("div").first().textContent()).replace(/: [^,)]+/g, "");
  const marked = async () => (await hint.locator(".sign-at").textContent()).split(":")[0];

  await page.keyboard.type("Line.Belt.send(");
  await eventually(async () => (await hint.count()) === 1 && (await head()) === "Line.Belt.send(speed, running, part)", "the send's fields");
  check((await hint.locator(".sign-or").textContent()).includes("one Conveyor"), "the whole type is not offered");
  check((await marked()) === "speed", `the first value is not the one marked, ${await marked()} is`);
  await page.keyboard.type("1.5, ");
  await eventually(async () => (await marked()) === "running", "the mark to move on after a comma");
  const box = await hint.boundingBox();
  const code = await d.code("tap").boundingBox();
  check(box.y + box.height <= code.y + 12, "the hint covers the line typed");
  await page.keyboard.type('true, "A1")');
  await eventually(async () => (await hint.count()) === 0, "the hint to go once the brackets close");

  await page.keyboard.press("Enter");
  await page.keyboard.type("const n = await Line.Clear(");
  await eventually(async () => (await hint.count()) === 1 && (await hint.textContent()).startsWith("Line.Clear() gives"), "the call's answer");
  await page.keyboard.type(");");
  await page.keyboard.press("Control+Enter");
  await eventually(() => hmi.page(pageId).children[0].handlers[0]?.code === 'Line.Belt.send(1.5, true, "A1")\nconst n = await Line.Clear();', "the code typed");
}
