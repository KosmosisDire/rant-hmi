// A designer builds a Toggle in the editor alone, laid out in whatever box it gets: a two way
// value, a pill that takes its colour when on, a round knob as high as the pill that slides to
// either end, colours that start at the theme's tokens, and a tap that flips it and sends
// change. On a page, one bound to Running stops and starts the line, one bound to !Running,
// which takes no writes, only shows, and a bigger one keeps its knob round. A component's code
// never names the mesh.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Toggle", 8, 4);
  await d.sizing("Fill");
  await d.addInput("value", "false", true);
  await d.addInput("colour", "$accent");
  await d.addInput("trackColour", "$panel3");
  await d.addInput("knobColour", "$text");
  await d.addSends("change");
  await d.add("frame", { Name: "track", x: "0", y: "0", w: "100%", h: "100%", Fill: "value ? colour : trackColour", Radius: "$radiusPill" });
  await d.handler("tap", 'value = !value;\nemit("change", value);');
  // as high as the track and as wide as high, its colour drawn inside a clear border
  await d.add("frame", { Name: "knob", x: "(value ? 100 : 0)%", y: "0", Origin: 'value ? "100% 0%" : "0% 0%"', w: "hug", h: "100%", Fill: "knobColour", Radius: '"50%"' });
  await page.locator('button[title="Edit the border"]').click();
  await d.set({ Width: "0.4", Colour: '"transparent"' });
  await page.keyboard.press("Escape");
  await d.css('aspect-ratio: 1\nbackground-clip: "padding-box"\ntransition: "left 120ms ease-out, translate 120ms ease-out"\nfilter: "drop-shadow(0 1px 2px #0006)"');

  await d.addPage("Toggles");
  const line = await d.place("Toggle", { x: "4", y: "4", w: "8", h: "4", value: "Running" });
  await d.handler("change", 'notify(p ? "Started" : "Stopped");');
  const shown = await d.place("Toggle", { x: "16", y: "4", w: "8", h: "4", value: "!Running" });
  const big = await d.place("Toggle", { x: "28", y: "4", w: "16", h: "6", value: "Running" });

  await hmi.set("Running", true);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const knobX = async (id) => (await inst(id).locator('.el[data-name="knob"]').boundingBox()).x - (await inst(id).boundingBox()).x;
  await eventually(async () => (await knobX(line)) > 30, "the knob to show the line running");
  // a bigger one's knob is round, as high as it, at its right end
  const [box, knob] = [await inst(big).boundingBox(), await inst(big).locator('.el[data-name="knob"]').boundingBox()];
  check(Math.abs(knob.width - knob.height) < 1 && Math.abs(knob.height - box.height) < 1, `the big knob is ${knob.width} by ${knob.height} in a toggle ${box.height} high`);
  await eventually(async () => {
    const k = await inst(big).locator('.el[data-name="knob"]').boundingBox();
    return Math.abs(k.x + k.width - (box.x + box.width)) < 1;
  }, "the big knob to sit at the right end");
  await inst(line).click();
  await eventually(() => hmi.state.values.Running?.value === false, "a tap to stop the line");
  await page.locator(".notice", { hasText: "Stopped" }).waitFor({ timeout: 4000 });
  await eventually(async () => (await knobX(line)) < 10 && (await knobX(shown)) > 30, "both knobs to follow the line");
  check((await inst(shown).locator(".el.live").count()) === 0 && (await inst(line).locator(".el.live").count()) === 1, "only the bound toggle looks pressable");
  await inst(shown).click();
  await page.waitForTimeout(300);
  check(hmi.state.values.Running?.value === false && (await knobX(shown)) > 30, "a toggle bound one way wrote or moved");
  await inst(line).click();
  await eventually(() => hmi.state.values.Running?.value === true, "a second tap to start it");

  await d.tab("Design");
  await d.openPage("Toggle");
  await d.select("track");
  await d.handler("tap", "Speed = 1;");
  await d.tab("Run");
  await inst(line).click();
  await page.locator(".notice.fault", { hasText: "Speed is no input, variable or part of Toggle" }).waitFor({ timeout: 4000 });

  // and back, so the Toggle ends as a person would leave it
  await d.tab("Design");
  await d.openPage("Toggle");
  await d.select("track");
  await d.handler("tap", 'value = !value;\nemit("change", value);');
}
