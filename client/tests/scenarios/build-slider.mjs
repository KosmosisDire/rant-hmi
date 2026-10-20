// A designer builds a Slider in the editor alone: a track, a fill and a thumb placed by the
// value, and a drag across it that sets the value in steps. Bound to Speed, a press jumps the
// line's speed there, a drag sets it, and a readout beside it follows.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Slider", 300, 44);
  await d.addInput("value", "0", true);
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addInput("step", "1");
  await d.addSends("change");
  await d.add("frame", { Name: "slider", x: "0", y: "0", w: "300", h: "44", Fill: "", Radius: "" });
  await d.handler("drag", "value = Math.round((min + p.x * (max - min)) / step) * step;\nemit(\"change\", value);");
  await d.add("frame", { Name: "track", x: "0", y: "18", w: "300", h: "8", Fill: "#3a4046", Radius: "4" });
  await d.select("slider");
  await d.add("frame", { Name: "fill", x: "0", y: "18", w: "(value - min) / (max - min) * 300", h: "8", Fill: "#4a8fd6", Radius: "4" });
  await d.select("slider");
  await d.add("frame", { Name: "thumb", x: "(value - min) / (max - min) * 300 - 11", y: "11", w: "22", h: "22", Fill: 'root.pressed ? "#ffffff" : "#e4e6e8"', Radius: "11" });
  await d.css('box-shadow: "0 1px 4px #0008"');

  await d.addPage("Sliders");
  const speed = await d.place("Slider", { x: "44", y: "44", w: "300", h: "44", value: "Speed", max: "2", step: "0.1" });
  await d.add("text", { Name: "Speed", x: "374", y: "44", w: "132", h: "44", Text: 'Speed.toFixed(1) + " m/s"', Colour: "#e4e6e8", Size: "22" });

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
  const thumb = await inst.locator('.el[data-name="thumb"]').boundingBox();
  check(Math.abs(thumb.x + thumb.width / 2 - (b.x + b.width * 0.25)) < 4, `the thumb sits at ${thumb.x}, not under the pointer`);
  await eventually(async () => (await page.locator(".run-layer:not([hidden]) .el.text", { hasText: "m/s" }).textContent()) === "0.5 m/s", "the readout to follow");
}
