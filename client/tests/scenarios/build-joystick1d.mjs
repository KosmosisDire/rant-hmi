// A designer builds a one axis Joystick1D, laid out along whatever box it gets: a track with a
// round knob that follows the finger along it, as far as its reach, a share of half its length,
// and springs back to the middle on release, its look inputs that start at the theme's tokens.
// Only a press on the track works it. It sends move with x from -1 to 1, right being positive, and held with the same on
// each beat while held, and a last 0 when let go. Turned upright it works upright, up positive.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.setVariable("Hmi.lever", 0, "screen");
  for (const name of ["Hmi.leverBeats", "Hmi.leverHeld"]) hmi.setVariable(name, 0);

  await d.addComponent("Joystick1D", 24, 6);
  await d.sizing("Fill");
  await d.addInput("reach", "0.75");
  await d.addInput("repeatMs", "100");
  await d.addInput("fill", "$panel");
  await d.addInput("colour", "$accent");
  await d.addInput("knobColour", "$panel3");
  await d.addInput("lineColour", "$border2");
  await d.addVariable("kx", "0");
  await d.addSends("move");
  await d.addSends("held");
  // the track takes the presses, which the marks and the knob on it let through
  await d.add("frame", { Name: "track", x: "0", y: "0", w: "100%", h: "100%", Fill: "fill", Radius: "$radiusPill" });
  await page.locator('button[title="Edit the border"]').click();
  await d.set({ Width: "0.2", Colour: "lineColour" });
  await page.keyboard.press("Escape");
  await d.handler("drag", ["// the knob goes where the finger is along the track, as far as its reach", "kx = Math.max(-1, Math.min(1, ((p.x - 0.5) * 2) / reach));", 'emit("move", { x: kx });'].join("\n"));
  await d.handler("release", 'kx = 0;\nemit("move", { x: 0 });\nemit("held", { x: 0 });');
  await d.handler("repeat", 'emit("held", { x: kx });', { "Every ms": "repeatMs" });
  await d.add("frame", { Name: "span", Origin: '"0% 50%"', x: "(50 - reach * 50)%", y: "50%", w: "(reach * 100)%", h: "0", Fill: "", Radius: "" });
  await d.css('border-top-width: 0.2\nborder-top-style: "dashed"\nborder-top-color: lineColour\npointer-events: "none"');
  await d.select("track");
  await d.add("frame", { Name: "knob", Origin: '"50% 50%"', x: "(50 + kx * reach * 50)%", y: "50%", w: "hug", h: "75%", Fill: "track.pressed ? colour : knobColour", Radius: '"50%"' });
  await page.locator('button[title="Edit the border"]').click();
  await d.set({ Width: "0.2", Colour: "$text" });
  await page.keyboard.press("Escape");
  await d.css('aspect-ratio: 1\npointer-events: "none"');

  await d.addPage("Lever");
  const lying = await d.place("Joystick1D", { x: "4", y: "4", w: "24", h: "6" });
  await d.handler("move", "Hmi.lever = p.x;");
  await d.handler("held", "Hmi.leverBeats = Hmi.leverBeats + 1;\nHmi.leverHeld = p.x;");
  const upright = await d.place("Joystick1D", { Origin: '"50% 50%"', x: "16", y: "30", w: "24", h: "6", Rotate: "-90" });
  await d.handler("move", "Hmi.lever = p.x;");
  await d.add("text", { Name: "readout", x: "32", y: "5", w: "20", h: "4", Text: '"x " + Hmi.lever.toFixed(2)', Colour: "$text", Size: "2" });

  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const centre = async (l) => {
    const b = await l.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const knob = inst(lying).locator('[data-name="knob"]');
  const [cx, cy] = await centre(inst(lying));
  const scale = (await inst(lying).boundingBox()).width / 24;
  const readout = page.locator(".run-layer:not([hidden]) .el.text");
  let said = "";
  const reads = (text, what) => eventually(async () => (said = await readout.textContent()) === text, () => `${what}, the page says ${said}`);
  const shared = (name) => hmi.state.values[name]?.value;

  // a press in the box's corner, outside the rounded track, does nothing
  const box = await inst(lying).boundingBox();
  const idle = shared("Hmi.leverBeats");
  await page.mouse.move(box.x + 0.7 * scale, box.y + 0.7 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 5.5 * scale, box.y + 0.7 * scale, { steps: 4 });
  await page.waitForTimeout(300);
  const [ix] = await centre(knob);
  check(Math.abs(ix - cx) < 2 && shared("Hmi.leverBeats") === idle, "a press outside the track worked the lever");
  await page.mouse.up();

  // along the track the knob sits under the finger, and a move across it moves nothing
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 4.5 * scale, cy + 2 * scale, { steps: 6 });
  const [kx, ky] = await centre(knob);
  check(Math.abs(kx - (cx + 4.5 * scale)) < 3 && Math.abs(ky - cy) < 2, `the knob is at ${kx - cx}, ${ky - cy} from the middle, not under the finger along the track`);
  await reads("x 0.50", "the page to hear the move");
  // beyond its travel it stops
  await page.mouse.move(cx + 27 * scale, cy, { steps: 6 });
  const [fx] = await centre(knob);
  check(Math.abs(fx - (cx + 9 * scale)) < 3, `the knob went to ${fx - cx} past its travel`);
  await reads("x 1.00", "a full push right");
  const from = shared("Hmi.leverBeats");
  await page.waitForTimeout(600);
  const counted = shared("Hmi.leverBeats") - from;
  check(counted >= 3 && counted <= 9, `held still for 600 ms it sent held ${counted} times`);
  check(shared("Hmi.leverHeld") === 1, "held sends where the lever is");
  await page.mouse.up();
  const [rx] = await centre(knob);
  check(Math.abs(rx - cx) < 2, "the knob did not spring back");
  await reads("x 0.00", "the release to stop");

  // turned upright, a push up is a push right
  const up = inst(upright).locator('[data-name="knob"]');
  const [ux, uy] = await centre(inst(upright));
  await page.mouse.move(ux, uy);
  await page.mouse.down();
  await page.mouse.move(ux + 2 * scale, uy - 4.5 * scale, { steps: 6 });
  const [qx, qy] = await centre(up);
  check(Math.abs(qx - ux) < 2 && Math.abs(qy - (uy - 4.5 * scale)) < 3, `the upright knob is at ${qx - ux}, ${qy - uy} from the middle, not under the finger`);
  await reads("x 0.50", "the upright lever to read up as positive");
  await page.mouse.up();
  await reads("x 0.00", "the upright lever to spring back");
}
