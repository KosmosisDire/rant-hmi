// A designer builds a Button in the editor alone, laid out in whatever box an instance gets: a
// face that fills it and darkens while pressed, its label centred, and an optional hold to
// confirm, a colour sweeping across the face under the label while held, so a round face shows
// it too. Its look is inputs that start at the theme's tokens. On a page, a plain one runs its
// tap, a held one confirms only once the sweep is across, and a wide one and a tall one keep
// their labels centred and their faces whole.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Button", 20, 6);
  await d.sizing("Fill");
  await d.addInput("text", '"Start"');
  await d.addInput("holdMs", "0");
  await d.addInput("fill", "$panel3");
  await d.addInput("textColour", "$text");
  await d.addInput("textSize", "2");
  await d.addInput("radius", "$radius");
  await d.addInput("holdColour", "$accent");
  await d.addSends("confirm");
  await d.add("frame", { Name: "face", x: "0", y: "0", w: "100%", h: "100%", Fill: "root.pressed ? fill.darken(0.15) : fill", Radius: "radius", Overflow: '"hidden"' });
  await d.handler("tap", 'if (!holdMs) emit("confirm");');
  await d.handler("hold", 'if (holdMs) emit("confirm");', "holdMs || 1e9");
  await d.add("frame", { Name: "progress", x: "0", y: "0", w: "(holdMs ? 100 * Math.min(root.heldFor / holdMs, 1) : 0)%", h: "100%", Fill: "holdColour", Radius: "" });
  await d.select("face");
  await d.add("frame", { Name: "content", x: "0", y: "0", w: "100%", h: "100%", Fill: "", Radius: "" });
  await d.layOut("Left to right", "Center");
  await d.add("text", { Name: "label", w: "hug", h: "hug", Text: "text", Colour: "textColour", Size: "textSize", Weight: "600" });

  await d.addPage("Hold buttons");
  const start = await d.place("Button", { x: "4", y: "4", w: "20", h: "6", text: '"Start"' });
  await d.handler("confirm", "Running = true;");
  const stop = await d.place("Button", { x: "28", y: "4", w: "20", h: "6", text: '"Hold to stop"', holdMs: "600" });
  await d.handler("confirm", "Running = false;");
  const wide = await d.place("Button", { x: "4", y: "14", w: "48", h: "8", text: '"Wide"', fill: "$accent" });
  const tall = await d.place("Button", { x: "56", y: "4", w: "12", h: "18", text: '"Tall"' });

  await hmi.set("Running", false);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const part = (id, name) => inst(id).locator(`.el[data-name="${name}"]`);
  const colour = (id) => part(id, "face").evaluate((e) => getComputedStyle(e).backgroundColor);
  await eventually(async () => (await inst(start).textContent()) === "Start", "the label");

  // any box: the face fills it, the label sits in its middle
  for (const id of [wide, tall]) {
    const [box, face, label] = [await inst(id).boundingBox(), await part(id, "face").boundingBox(), await part(id, "label").boundingBox()];
    const off = (a, b) => Math.abs(a - b);
    check(off(face.width, box.width) < 1 && off(face.height, box.height) < 1, `the face is ${face.width} by ${face.height} in a box ${box.width} by ${box.height}`);
    const [cx, cy] = [label.x + label.width / 2 - (box.x + box.width / 2), label.y + label.height / 2 - (box.y + box.height / 2)];
    check(off(cx, 0) < 1.5 && off(cy, 0) < 1.5, `the label is ${cx.toFixed(1)}, ${cy.toFixed(1)} off the middle`);
  }
  check((await colour(wide)) === "rgb(220, 56, 83)", `an instance's own fill shows as ${await colour(wide)}`);

  await inst(start).click();
  await eventually(() => hmi.state.values.Running?.value === true, "a tap to start the line");

  // a short press on the hold button does nothing, a long one sweeps across and confirms
  const b = await inst(stop).boundingBox();
  const sweep = async () => (await part(stop, "progress").boundingBox())?.width ?? 0;
  const lightness = (rgb) => rgb.match(/\d+/g).slice(0, 3).map(Number).reduce((a, c) => a + c, 0);
  const still = await colour(stop);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  const held = await colour(stop);
  check(lightness(held) < lightness(still), `the face does not darken while pressed: ${still} to ${held}`);
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(hmi.state.values.Running?.value === true, "a short press confirmed");
  await page.mouse.down();
  let seen = 0;
  await eventually(async () => (seen = await sweep()) > 20 && seen < 180, () => `the sweep to go part way, it is ${seen} wide`, 550);
  const [face, along, label] = [await part(stop, "face").boundingBox(), await part(stop, "progress").boundingBox(), await part(stop, "label").boundingBox()];
  check(Math.abs(face.y - along.y) < 1 && Math.abs(face.height - along.height) < 1, "the sweep does not cover the face from top to bottom");
  const over = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".el[data-name]")?.getAttribute("data-name"), [label.x + label.width / 2, label.y + label.height / 2]);
  check(over === "label", `the sweep hides the label under ${over}`);
  await eventually(() => hmi.state.values.Running?.value === false, "a long hold to stop the line");
  await page.mouse.up();
  await eventually(async () => (await sweep()) === 0, "the sweep to go back");
}
