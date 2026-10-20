// A Slider built from frames and one drag handler, bound to Speed: a press jumps there, a drag
// shows its own value while held, and the speed ends where it let go.

export default async function ({ page, hmi, d, check, eventually }) {
  const slider = await hmi.addComponent("Slider");
  await hmi.edit({ kind: "resize_page", page: slider, width: 352, height: 88 });
  const input = (name, def, bindable = false) => hmi.edit({ kind: "set_input", page: slider, name, input: { name, default: def, bindable } });
  await input("value", "0", true);
  await input("min", "0");
  await input("max", "1");
  // the fill and thumb sit inside the track, so a press on either reaches its handler
  const part = (name, props, parent = null) => hmi.addElement(slider, "div", { name, ...props }, parent);
  const track = await part("Track", { x: "0", y: "33", w: "352", h: "22", background: "#3a4046", "border-radius": "11" });
  await part("Fill", { x: "0", y: "0", w: "(value - min) / (max - min) * 352", h: "22", background: "#4a8fd6", "border-radius": "11" }, track);
  await part("Thumb", { x: "(value - min) / (max - min) * 308", y: "-11", w: "44", h: "44", background: "#e4e6e8", "border-radius": "22" }, track);
  await hmi.setHandler(slider, track, "drag", "value = min + p.x * (max - min);");

  const pageId = await hmi.addPage("Sliders");
  const inst = await hmi.addElement(pageId, "use", { name: "Speed", x: "44", y: "44", w: "704", h: "176", value: "Speed", min: "0", max: "2" }, null, "Slider");
  await d.openPage("Sliders");
  await d.tab("Run");
  await hmi.set("Speed", 0.5);
  await eventually(() => hmi.state.values.Speed?.value === 0.5, "the speed at 0.5");

  const box = await page.locator(`.run-layer:not([hidden]) .el[data-id="${inst}"] .instance`).boundingBox();
  const at = (f) => [box.x + box.width * f, box.y + box.height / 2];
  const fill = () => page.locator(`.run-layer:not([hidden]) .el[data-id="${inst}"] .el[data-name="Fill"]`).boundingBox().then((b) => b.width / box.width);

  await page.mouse.click(...at(0.75));
  await eventually(() => Math.abs(hmi.state.values.Speed?.value - 1.5) < 0.02, "a press at three quarters to set 1.5");

  await page.mouse.move(...at(0.75));
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(...at(0.75 - (0.5 * i) / 10));
  await eventually(async () => Math.abs((await fill()) - 0.25) < 0.03, "the fill to follow the pointer while held");
  await page.mouse.up();
  await eventually(() => Math.abs(hmi.state.values.Speed?.value - 0.5) < 0.02, "the speed to end where the drag let go");
  await page.waitForTimeout(200);
  check(Math.abs((await fill()) - 0.25) < 0.03, "after release the fill left what its binding says");
}
