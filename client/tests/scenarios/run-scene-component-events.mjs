// A 3D TapPad shows when the pointer is over it and when it is pressed, counts its own taps, and
// sends where it was hit, which the page reads in the Pad's own frame, turned and moved as the
// Pad is. A second one keeps its own.

export default async function ({ page, hmi, d, eventually }) {
  const pad = await hmi.addComponent("TapPad", "3d");
  await hmi.edit({ kind: "set_state", page: pad, id: null, name: "taps", var: { name: "taps", start: 0, per: "screen" } });
  await hmi.edit({ kind: "set_event", page: pad, name: "hit", to: "hit" });
  const colour = 'cap.pressed ? "#00ff00" : cap.hovered ? "#ffff00" : taps > 0 ? "#0000ff" : "#ff0000"';
  const cap = await hmi.addElement(pad, "box", { name: "cap", size: "vec(0.5, 0.5, 0.5)", color: colour });
  await hmi.setHandler(pad, cap, "tap", 'taps = taps + 1;\nemit("hit", p.point);');

  const pageId = await hmi.addPage("Pads");
  await hmi.edit({ kind: "set_state", page: pageId, id: null, name: "got", var: { name: "got", start: "none", per: "screen" } });
  await hmi.addElement(pageId, "span", { name: "said", x: "2", y: "44", w: "60", h: "3", text: "got" });
  // seen from above, 97 px a metre, x to the right
  const scene = await hmi.addElement(pageId, "scene", { name: "yard", x: "2", y: "2", w: "60", h: "40", yaw: "-PI / 2", pitch: "1.5", distance: "5" });
  // turned a quarter round z, so its own y points along the scene's -x
  const right = await hmi.addElement(pageId, "use", { name: "right", pose: "{ position: vec(1, 0, 0), orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } }" }, scene, "TapPad");
  await hmi.setHandler(pageId, right, "hit", 'got = `${Math.abs(p.x) < 0.05} ${p.y < -0.1} ${p.z.toFixed(2)}`;');
  await hmi.addElement(pageId, "use", { name: "left", pose: "{ position: vec(-1, 0, 0) }" }, scene, "TapPad");

  await d.openPage("Pads");
  await d.tab("Run");
  const layer = page.locator(".run-layer:not([hidden])");
  const el = layer.locator(`.el[data-id="${scene}"]`);
  const said = layer.locator('.el[data-name="said"]');
  const is = (want) => ([r, g, b]) => [r > 150, g > 150, b > 150].join() === want.join();
  const [red, yellow, green, blue] = [[true, false, false], [true, true, false], [false, true, false], [false, false, true]];
  await d.shows(el, 0.661, 0.5, is(red), "the right Pad red");
  const box = await el.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

  // 0.2 m right of its middle
  await page.mouse.move(...at(0.693, 0.5));
  await d.shows(el, 0.661, 0.5, is(yellow), "the right Pad yellow with the pointer over it");
  await page.mouse.down();
  await d.shows(el, 0.661, 0.5, is(green), "the right Pad green while pressed");
  await page.mouse.up();
  // its top is 0.25 m up, and right of its middle along the scene's x is back along its own y
  await eventually(async () => (await said.textContent()) === "true true 0.25", async () => `the hit in the Pad's frame, it says ${await said.textContent()}`);
  await page.mouse.move(...at(0.9, 0.1));
  await d.shows(el, 0.661, 0.5, is(blue), "the right Pad blue once tapped and the pointer away");
  await d.shows(el, 0.339, 0.5, is(red), "the left Pad still red, never tapped");
}
