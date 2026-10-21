// A designer builds a one axis Joystick1D: a track with a knob that follows the finger along it,
// as far as its travel, and springs back to the middle on release. Only a press on the track
// works it. It sends move with x from -1 to 1, right being positive, and held with the same on
// each beat while held, and a last 0 when let go. Turned upright it works upright, up positive.

export default async function ({ page, hmi, d, check, eventually }) {
  hmi.send({ type: "set_variable", name: "lever", variable: { name: "lever", start: 0, per: "screen" } });
  for (const name of ["leverBeats", "leverHeld"]) hmi.send({ type: "set_variable", name, variable: { name, start: 0, per: "hmi" } });

  await d.addComponent("Joystick1D", 264, 66);
  await d.addInput("travel", "99");
  await d.addInput("repeatMs", "100");
  await d.addVariable("kx", "0");
  await d.addSends("move");
  await d.addSends("held");
  await d.add("drawing", { Name: "pad", x: "0", y: "0", w: "264", h: "66" });
  // the track takes the presses, which the marks and the knob above it let through
  await d.addShape("rect", { Name: "track", x: "3", y: "3", Width: "258", Height: "60", Round: "30", Fill: "#1e2125", Stroke: "#3a4046", Thickness: "2" });
  await d.handler("drag", ["// the knob goes where the finger is along a track 258 across, as far as the travel", "kx = Math.max(-1, Math.min(1, ((p.x - 0.5) * 258) / travel));", 'emit("move", { x: kx });'].join("\n"));
  await d.handler("release", 'kx = 0;\nemit("move", { x: 0 });\nemit("held", { x: 0 });');
  await d.handler("repeat", 'emit("held", { x: kx });', "repeatMs");
  await d.addShape("line", { Name: "span", "From x": "132 - travel", "From y": "33", "To x": "132 + travel", "To y": "33", Stroke: "#2f3540", Thickness: "2", Dashes: '"4 6"' });
  await d.css('pointer-events: "none"');
  await d.addShape("circle", { Name: "knob", "Centre x": "132 + kx * travel", "Centre y": "33", Radius: "24", Fill: 'track.pressed ? "#4a8fd6" : "#3a4046"', Stroke: "#e4e6e8", Thickness: "2" });
  await d.css('pointer-events: "none"');

  await d.addPage("Lever");
  const lying = await d.place("Joystick1D", { x: "44", y: "44", w: "264", h: "66" });
  await d.handler("move", "lever = p.x;");
  await d.handler("held", "leverBeats = leverBeats + 1;\nleverHeld = p.x;");
  const upright = await d.place("Joystick1D", { x: "176", y: "330", w: "264", h: "66", Origin: '"50% 50%"', Rotate: "-90" });
  await d.handler("move", "lever = p.x;");
  await d.add("text", { Name: "readout", x: "352", y: "55", w: "220", h: "44", Text: '"x " + lever.toFixed(2)', Colour: "#e4e6e8", Size: "20" });

  await d.tab("Run");
  const inst = (id) => page.locator(`.run-layer:not([hidden]) .el[data-id="${id}"]`);
  const centre = async (l) => {
    const b = await l.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const knob = inst(lying).locator('[data-name="knob"]');
  const [cx, cy] = await centre(inst(lying));
  const scale = (await inst(lying).boundingBox()).width / 264;
  const readout = page.locator(".run-layer:not([hidden]) .el.text");
  let said = "";
  const reads = (text, what) => eventually(async () => (said = await readout.textContent()) === text, () => `${what}, the page says ${said}`);
  const shared = (name) => hmi.state.values[name]?.value;

  // a press in the box's corner, outside the rounded track, does nothing
  const box = await inst(lying).boundingBox();
  const idle = shared("leverBeats");
  await page.mouse.move(box.x + 8 * scale, box.y + 8 * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 60 * scale, box.y + 8 * scale, { steps: 4 });
  await page.waitForTimeout(300);
  const [ix] = await centre(knob);
  check(Math.abs(ix - cx) < 2 && shared("leverBeats") === idle, "a press outside the track worked the lever");
  await page.mouse.up();

  // along the track the knob sits under the finger, and a move across it moves nothing
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 49.5 * scale, cy + 20 * scale, { steps: 6 });
  const [kx, ky] = await centre(knob);
  check(Math.abs(kx - (cx + 49.5 * scale)) < 3 && Math.abs(ky - cy) < 2, `the knob is at ${kx - cx}, ${ky - cy} from the middle, not under the finger along the track`);
  await reads("x 0.50", "the page to hear the move");
  // beyond its travel it stops
  await page.mouse.move(cx + 300 * scale, cy, { steps: 6 });
  const [fx] = await centre(knob);
  check(Math.abs(fx - (cx + 99 * scale)) < 3, `the knob went to ${fx - cx} past its travel`);
  await reads("x 1.00", "a full push right");
  const from = shared("leverBeats");
  await page.waitForTimeout(600);
  const counted = shared("leverBeats") - from;
  check(counted >= 3 && counted <= 9, `held still for 600 ms it sent held ${counted} times`);
  check(shared("leverHeld") === 1, "held sends where the lever is");
  await page.mouse.up();
  const [rx] = await centre(knob);
  check(Math.abs(rx - cx) < 2, "the knob did not spring back");
  await reads("x 0.00", "the release to stop");

  // turned upright, a push up is a push right
  const up = inst(upright).locator('[data-name="knob"]');
  const [ux, uy] = await centre(inst(upright));
  await page.mouse.move(ux, uy);
  await page.mouse.down();
  await page.mouse.move(ux + 20 * scale, uy - 49.5 * scale, { steps: 6 });
  const [qx, qy] = await centre(up);
  check(Math.abs(qx - ux) < 2 && Math.abs(qy - (uy - 49.5 * scale)) < 3, `the upright knob is at ${qx - ux}, ${qy - uy} from the middle, not under the finger`);
  await reads("x 0.50", "the upright lever to read up as positive");
  await page.mouse.up();
  await reads("x 0.00", "the upright lever to spring back");
}
