// Completion knows what any code gives, as the user asked of a vector's length in kg: text from a
// number's format plus text offers text's methods. A handler's own names are known after a dot,
// a list method's function knows its item, and a method's hint says what it takes.

export default async function ({ page, hmi, d, eventually }) {
  await hmi.import("Robot.EndPose", "Robot/Pose");
  const pageId = await hmi.addPage("Typed code");
  const text = await hmi.addElement(pageId, "span", { name: "Label", x: "4", y: "4", w: "24", h: "4", text: '""' });
  await d.openPage("Typed code");
  await d.pick(text);
  const names = () => page.locator(".suggest .suggest-name").allTextContents();
  const offers = async (box, typed, want) => {
    await box.fill("");
    await page.keyboard.type(typed);
    await eventually(async () => (await names()).includes(want), async () => `${typed} to offer ${want}, not ${(await names()).join(", ")}`);
  };

  const field = d.field("Text");
  await field.click();
  await offers(field, '((Robot.EndPose.position.length() / 9.8).toFixed(1) + "kg").pad', "padStart");
  await offers(field, "Robot.EndPose.position.length().toFixed(1).toU", "toUpperCase");
  await page.keyboard.press("Escape");

  await d.addEvent("tap");
  const code = d.code("tap");
  await code.click();
  await offers(code, "const s = rant.statuses(); s[0].", "since");
  await offers(code, "rant.statuses().map((c) => c.", "level");
  await offers(code, "for (const l of rant.logs()) { l.", "origin");
  await offers(code, "const p = Robot.EndPose.position; p.norm", "normalize");
  await code.fill("");
  await page.keyboard.type("Robot.EndPose.position.dot(");
  await eventually(async () => (await page.locator(".signature").textContent())?.startsWith("Robot.EndPose.position.dot("), "the hint for a method");
  await page.keyboard.press("Escape");
}
