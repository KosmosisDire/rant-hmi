// What a call gives is known after its dot, its value there or not: a vector's length is a
// number, so a number's methods come, a Rant Math call's answer offers its fields, and a colour's
// lighten a colour's methods. A token's card shows its value, a colour with its swatch.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Robot.EndPose", "Robot/Pose");
  hmi.send({ type: "set_token", name: "probeTone", token: { name: "probeTone", dark: "#4a8fd6", light: "" } });
  const pageId = await hmi.addPage("Typed calls");
  const text = await hmi.addElement(pageId, "span", { name: "Label", x: "4", y: "4", w: "24", h: "4", text: '""' });
  await d.openPage("Typed calls");
  await d.pick(text);
  const field = d.field("Text");
  const names = () => page.locator(".suggest .suggest-name").allTextContents();
  const offers = async (typed, want) => {
    await field.fill("");
    await page.keyboard.type(typed);
    await eventually(async () => (await names()).includes(want), async () => `${typed} to offer ${want}, not ${(await names()).join(", ")}`);
  };
  await field.click();
  await offers("Robot.EndPose.position.length().", "toFixed");
  await offers("math.poseInverse(Robot.EndPose).", "orientation");
  await offers("math.poseInverse(Robot.EndPose).position.length().", "toPrecision");
  await offers("$probeTone.lighten(0.2).", "darken");

  // the caret on the token shows its card, with its value and its swatch
  await field.fill("$probeTone");
  await field.press("End");
  await field.press("ArrowLeft");
  const card = page.locator(".about-card");
  await card.waitFor();
  await eventually(async () => (await card.locator(".about-value").textContent()) === "#4a8fd6", async () => `the card to show #4a8fd6, not ${await card.locator(".about-value").textContent()}`);
  check((await card.locator(".about-value .swatch").count()) === 1, "the card shows no swatch for the colour");
}
