// A designer builds a Slider in the editor alone: a track, a fill and a thumb placed by the
// value, and a drag across it that sets the value in steps. Bound to Speed, a press jumps the
// line's speed there, a drag sets it, and a readout beside it follows.

export default async function ({ page, hmi, d, eventually }) {
  await d.addComponent("Slider", 27, 4);
  await d.addInput("value", "0", true);
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addInput("step", "1");
  await d.addSends("change");
  await d.add("frame", { Name: "slider", x: "0", y: "0", w: "27", h: "4", Fill: "", Radius: "" });
  await d.handler("drag", "value = Math.round((min + p.x * (max - min)) / step) * step;\nemit(\"change\", value);");
  await d.add("frame", { Name: "track", x: "0", y: "1.6", w: "27", h: "0.8", Fill: "$panel3", Radius: "0.4" });
  await d.select("slider");
  await d.add("frame", { Name: "fill", x: "0", y: "1.6", w: "(value - min) / (max - min) * 27", h: "0.8", Fill: "$accent", Radius: "0.4" });
  await d.select("slider");
  await d.add("frame", { Name: "thumb", x: "(value - min) / (max - min) * 27 - 1", y: "1", w: "2", h: "2", Fill: "root.pressed ? $onFill : $text", Radius: "1" });
  await d.css('box-shadow: "0 1px 4px #0008"');

  await d.addPage("Sliders");
  const speed = await d.place("Slider", { x: "4", y: "4", w: "27", h: "4", value: "Speed", max: "2", step: "0.1" });
  await d.add("text", { Name: "Speed", x: "34", y: "4", w: "12", h: "4", Text: 'Speed.toFixed(1) + " m/s"', Colour: "$text", Size: "2" });

  await hmi.set("Speed", 0);
  await d.tab("Run");
  const inst = page.locator(`.run-layer:not([hidden]) .el[data-id="${speed}"]`);
  const b = await inst.boundingBox();
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height / 2);
  await eventually(() => Math.abs((hmi.state.values.Speed?.value ?? 0) - 1) < 0.01, () => `a press half way to set Speed to 1, not ${hmi.state.values.Speed?.value}`);
  await page.mouse.move(b.x + 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 8 });
  await eventually(() => Math.abs((hmi.state.values.Speed?.value ?? 0) - 1.5) < 0.01, "a drag to three quarters to set Speed to 1.5");
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await eventually(() => Math.abs((hmi.state.values.Speed?.value ?? 0) - 0.5) < 0.01, "a drag back to set it to 0.5");
  // the page draws the value a moment after this test hears it
  let middle = 0;
  const under = async () => {
    const t = await inst.locator('.el[data-name="thumb"]').boundingBox();
    middle = t.x + t.width / 2;
    return Math.abs(middle - (b.x + b.width * 0.25)) < 4;
  };
  await eventually(under, () => `the thumb to sit under the pointer, not at ${middle}`);
  await eventually(async () => (await page.locator(".run-layer:not([hidden]) .el.text", { hasText: "m/s" }).textContent()) === "0.5 m/s", "the readout to follow");
}
