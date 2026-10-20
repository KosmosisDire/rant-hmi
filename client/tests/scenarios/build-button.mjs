// A designer builds a Button in the editor alone: a label input, a face that darkens while
// pressed, and an optional hold to confirm, a bar filling across the bottom while held. On a
// page, a plain one runs its tap, and a held one confirms only once its bar is full.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Button", 220, 66);
  await d.addInput("text", '"Start"');
  await d.addInput("holdMs", "0");
  await d.addSends("confirm");
  await d.add("frame", { Name: "face", x: "0", y: "0", w: "220", h: "66", Fill: 'root.pressed ? "#1f5a24" : "#2e7d32"', Radius: "8" });
  await d.handler("tap", 'if (!holdMs) emit("confirm");');
  await d.handler("hold", 'if (holdMs) emit("confirm");', "holdMs || 1e9");
  await d.add("text", { Name: "label", x: "0", y: "0", w: "220", h: "66", Text: "text", Colour: "#ffffff", Size: "22", Weight: "600", Align: '"center"' });
  await d.css('line-height: "66px"');
  await d.select("face");
  await d.add("frame", { Name: "bar", x: "0", y: "60", w: "holdMs ? 220 * Math.min(root.heldFor / holdMs, 1) : 0", h: "6", Fill: "#ffffffaa" });

  await d.addPage("Buttons");
  const start = await d.place("Button", { x: "44", y: "44", w: "220", h: "66", text: '"Start"' });
  await d.handler("confirm", "Running = true;");
  const stop = await d.place("Button", { x: "308", y: "44", w: "220", h: "66", text: '"Hold to stop"', holdMs: "600" });
  await d.handler("confirm", "Running = false;");

  await hmi.set("Running", false);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  await eventually(async () => (await inst(start).textContent()) === "Start", "the label");
  await inst(start).click();
  await eventually(() => hmi.state.values.Running?.value === true, "a tap to start the line");

  // a short press on the hold button does nothing, a long one fills the bar and confirms
  const b = await inst(stop).boundingBox();
  const bar = async () => (await inst(stop).locator('.el[data-name="bar"]').boundingBox())?.width ?? 0;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  const face = await inst(stop).locator('.el[data-name="face"]').evaluate((e) => getComputedStyle(e).backgroundColor);
  check(face === "rgb(31, 90, 36)", `the face does not darken while pressed: ${face}`);
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(hmi.state.values.Running?.value === true, "a short press confirmed");
  await page.mouse.down();
  await page.waitForTimeout(300);
  const part = await bar();
  check(part > 30 && part < 180, `the bar is ${part} wide half way`);
  await eventually(() => hmi.state.values.Running?.value === false, "a long hold to stop the line");
  await page.mouse.up();
  await eventually(async () => (await bar()) === 0, "the bar to empty");
}
