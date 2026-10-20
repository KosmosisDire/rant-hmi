// A designer builds a Toggle in the editor alone: a two way value, a track that turns green, a
// knob that slides, and a tap that flips it and sends change. On a page, one bound to Running
// stops and starts the line, and one bound to !Running, which takes no writes, only shows. A
// component's code never names the mesh.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Toggle", 88, 44);
  await d.addInput("value", "false", true);
  await d.addSends("change");
  await d.add("frame", { Name: "track", x: "0", y: "0", w: "88", h: "44", Fill: 'value ? "#2e7d32" : "#3a4046"', Radius: "22" });
  await d.handler("tap", 'value = !value;\nemit("change", value);');
  await d.add("frame", { Name: "knob", x: "value ? 48 : 4", y: "4", w: "36", h: "36", Fill: "#e4e6e8", Radius: "18" });
  await d.css('transition: "left 120ms ease-out"\nbox-shadow: "0 1px 3px #0006"');

  await d.addPage("Toggles");
  const line = await d.place("Toggle", { x: "44", y: "44", w: "88", h: "44", value: "Running" });
  await d.handler("change", 'notify(p ? "Started" : "Stopped");');
  const shown = await d.place("Toggle", { x: "176", y: "44", w: "88", h: "44", value: "!Running" });

  await hmi.set("Running", true);
  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const knobX = async (id) => (await inst(id).locator('.el[data-name="knob"]').boundingBox()).x - (await inst(id).boundingBox()).x;
  await eventually(async () => (await knobX(line)) > 30, "the knob to show the line running");
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
