// A designer builds a Slider in the editor alone, laid out in whatever box it gets: a track, a
// fill and a thumb placed by the value as a share of its width, a drag across it that sets the
// value in steps, and colours that start at the theme's tokens. Bound to Speed, a press jumps
// the line's speed there, a drag sets it, a readout beside it follows, and a longer slider
// shows the same share.

export default async function ({ page, hmi, d, check, eventually }) {
  await d.addComponent("Slider", 27, 4);
  await d.sizing("Fill");
  await d.addInput("value", "0", true);
  await d.addInput("min", "0");
  await d.addInput("max", "100");
  await d.addInput("step", "1");
  await d.addInput("colour", "$accent");
  await d.addInput("trackColour", "$panel3");
  await d.addInput("thumbColour", "$text");
  await d.addSends("change");
  await d.add("frame", { Name: "slider", x: "0", y: "0", w: "100%", h: "100%", Fill: "", Radius: "" });
  await d.handler("drag", "value = Math.round((min + p.x * (max - min)) / step) * step;\nemit(\"change\", value);");
  const centred = { y: "50%", Origin: '"0% 50%"', h: "0.8", Radius: "0.4" };
  await d.add("frame", { Name: "track", x: "0", w: "100%", ...centred, Fill: "trackColour" });
  await d.select("slider");
  await d.add("frame", { Name: "fill", x: "0", w: "(value - min) / (max - min) * 100%", ...centred, Fill: "colour" });
  await d.select("slider");
  await d.add("frame", { Name: "thumb", x: "(value - min) / (max - min) * 100%", y: "50%", Origin: '"50% 50%"', w: "2", h: "2", Fill: "root.pressed ? thumbColour.lighten(0.5) : thumbColour", Radius: "1" });
  await d.css('box-shadow: "0 1px 4px #0008"');

  await d.addPage("Sliders");
  const speed = await d.place("Slider", { x: "4", y: "4", w: "27", h: "4", value: "Speed", max: "2", step: "0.1" });
  const long = await d.place("Slider", { x: "4", y: "12", w: "60", h: "6", value: "Speed", max: "2", step: "0.1" });
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
  // the longer one fills a quarter of its width too, its track along its middle
  const part = (name) => page.locator(`.run-layer:not([hidden]) .el[data-id="${long}"] .el[data-name="${name}"]`).boundingBox();
  const [box, track, fill] = [await page.locator(`.run-layer:not([hidden]) .el[data-id="${long}"]`).boundingBox(), await part("track"), await part("fill")];
  check(Math.abs(track.width - box.width) < 1 && Math.abs(track.y + track.height / 2 - (box.y + box.height / 2)) < 1, "the long track does not run along its middle");
  check(Math.abs(fill.width / box.width - 0.25) < 0.01, `the long fill is ${(fill.width / box.width).toFixed(3)} of its width, not a quarter`);
}
