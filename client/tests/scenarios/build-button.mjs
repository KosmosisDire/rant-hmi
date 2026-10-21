// A designer builds a Button in the editor alone: a label input, a face that darkens while
// pressed, and an optional hold to confirm, a bar filling across the bottom while held. On a
// page, a plain one runs its tap, and a held one confirms only once its bar is full.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Button", 20, 6);
  await d.addInput("text", '"Start"');
  await d.addInput("holdMs", "0");
  await d.addSends("confirm");
  await d.add("frame", { Name: "face", x: "0", y: "0", w: "20", h: "6", Fill: "root.pressed ? $panel2 : $panel3", Radius: "$radius" });
  await d.handler("tap", 'if (!holdMs) emit("confirm");');
  await d.handler("hold", 'if (holdMs) emit("confirm");', "holdMs || 1e9");
  await d.add("text", { Name: "label", x: "0", y: "0", w: "20", h: "6", Text: "text", Colour: "$text", Size: "2", Weight: "600", Align: '"center"' });
  await d.css('line-height: "60px"');
  await d.select("face");
  await d.add("frame", { Name: "bar", x: "0", y: "5.5", w: "holdMs ? 20 * Math.min(root.heldFor / holdMs, 1) : 0", h: "0.5", Fill: "$accent" });

  await d.addPage("Hold buttons");
  const start = await d.place("Button", { x: "4", y: "4", w: "20", h: "6", text: '"Start"' });
  await d.handler("confirm", "Running = true;");
  const stop = await d.place("Button", { x: "28", y: "4", w: "20", h: "6", text: '"Hold to stop"', holdMs: "600" });
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
  check(face === "rgb(33, 33, 33)", `the face does not darken while pressed: ${face}`);
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(hmi.state.values.Running?.value === true, "a short press confirmed");
  await page.mouse.down();
  let seen = 0;
  await eventually(async () => (seen = await bar()) > 20 && seen < 180, () => `the bar to fill part way, it is ${seen} wide`, 550);
  await eventually(() => hmi.state.values.Running?.value === false, "a long hold to stop the line");
  await page.mouse.up();
  await eventually(async () => (await bar()) === 0, "the bar to empty");
}
