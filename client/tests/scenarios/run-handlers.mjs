// An operator taps to speed the line up, holds a jog even as the pointer slides off, calls
// Reset and hears its answer, and a handler with a typo says what went wrong.

export default async function ({ page, hmi, d, check, eventually }) {
  await hmi.import("Line.Reset", "Line1/Reset", "write");
  const pageId = await hmi.addPage("Buttons");
  const button = async (name, x, event, code) => {
    const id = await hmi.addElement(pageId, "div", { name, x: String(x), y: "4", w: "16", h: "8", background: "#2a2f35" });
    await hmi.setHandler(pageId, id, event, code);
    return id;
  };
  const faster = await button("Faster", 4, "tap", "Line.Speed = Line.Speed + 0.5;");
  const jog = await button("Jog", 24, "press", "Line.Speed = 2;");
  await hmi.setHandler(pageId, jog, "release", "Line.Speed = 0.25;");
  const reset = await button("Reset", 44, "tap", "const cleared = await Line.Reset();\nnotify(`Reset after ${cleared} parts`);");
  const broken = await button("Broken", 64, "tap", "Line.Speed = Sped;");

  await d.openPage("Buttons");
  await d.tab("Run");
  const speed = () => hmi.state.values["Line.Speed"]?.value;
  const el = (id) => page.locator(`.run .el[data-id="${id}"]`);
  await eventually(() => typeof speed() === "number", "the speed to be known");
  await hmi.set("Line.Speed", 1);
  await eventually(() => speed() === 1, "the speed to start at 1");

  await el(faster).click();
  await eventually(() => speed() === 1.5, "a tap to speed the line up");

  const b = await el(jog).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await eventually(() => speed() === 2, "a press to jog");
  check(await el(jog).evaluate((e) => e.classList.contains("pressed")), "the jog does not look pressed");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 3, { steps: 4 });
  await page.mouse.up();
  await eventually(() => speed() === 0.25, "letting go off the button to end the jog");

  await el(reset).click();
  await page.locator(".notice.info", { hasText: /^Reset after \d+ parts$/ }).waitFor({ timeout: 4000 });

  await el(broken).click();
  const fault = page.locator(".notice.fault");
  await fault.waitFor({ timeout: 4000 });
  const text = await fault.textContent();
  check(text.includes("Broken tap") && text.includes("Sped names no object, member or state (line 1)"), `the fault says ${text}`);
  check(speed() === 0.25, "the broken handler wrote something");
}
