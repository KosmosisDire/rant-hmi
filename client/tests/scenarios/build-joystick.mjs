// A designer builds a Joystick in the editor alone: a base, a travel ring and a knob drawn in
// one diagram, which keeps its round shape, its colours inputs that start at the theme's tokens. Only a press on the base works it. The knob follows the finger while it stays
// within the ring, stops at the ring beyond it, and springs back on release. It sends move with
// x and y from -1 to 1, up being positive, which the page keeps in two variables, and held with
// the same on each beat while held, even a still one, and a last 0, 0 when let go.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const name of ["Hmi.jogX", "Hmi.jogY"]) hmi.setVariable(name, 0, "screen");
  // shared, so the test reads them as any screen would
  for (const name of ["Hmi.beats", "Hmi.heldX"]) hmi.setVariable(name, 0);

  await d.addComponent("Joystick", 20, 20);
  await d.addInput("travel", "6.5");
  await d.addInput("repeatMs", "100");
  await d.addInput("fill", "$panel");
  await d.addInput("colour", "$accent");
  await d.addInput("knobColour", "$panel3");
  await d.addInput("lineColour", "$border2");
  await d.addVariable("kx", "0");
  await d.addVariable("ky", "0");
  await d.addSends("move");
  await d.addSends("held");
  await d.add("diagram", { Name: "pad", x: "0", y: "0", w: "20", h: "20" });
  // the base takes the presses, which the ring and the knob above it let through
  await d.addShape("circle", { Name: "base", "Centre x": "10", "Centre y": "10", Radius: "9.5", Fill: "fill", Stroke: "lineColour", Thickness: "0.2" });
  await d.handler("drag", [
    "// the knob goes where the finger is, as far as the ring, on a base 19 across",
    "const dx = (p.x - 0.5) * 19, dy = (p.y - 0.5) * 19;",
    "const k = Math.min(1, travel / Math.max(Math.hypot(dx, dy), 1));",
    "kx = (dx * k) / travel;",
    "ky = (dy * k) / travel;",
    'emit("move", { x: kx, y: -ky });',
  ].join("\n"));
  await d.handler("release", 'kx = 0;\nky = 0;\nemit("move", { x: 0, y: 0 });\nemit("held", { x: 0, y: 0 });');
  await d.handler("repeat", 'emit("held", { x: kx, y: -ky });', { "Every ms": "repeatMs" });
  await d.addShape("circle", { Name: "ring", "Centre x": "10", "Centre y": "10", Radius: "travel", Fill: '"none"', Stroke: "lineColour", Thickness: "0.2", Dashes: '"0.4 0.6"' });
  await d.css('pointer-events: "none"');
  await d.addShape("circle", { Name: "knob", "Centre x": "10 + kx * travel", "Centre y": "10 + ky * travel", Radius: "3", Fill: "base.pressed ? colour : knobColour", Stroke: "$text", Thickness: "0.2" });
  await d.css('pointer-events: "none"');

  await d.addPage("Joystick");
  const stick = await d.place("Joystick", { x: "4", y: "4", w: "20", h: "20" });
  await d.handler("move", "Hmi.jogX = p.x;\nHmi.jogY = p.y;");
  await d.handler("held", "Hmi.beats = Hmi.beats + 1;\nHmi.heldX = p.x;");
  await d.add("text", { Name: "readout", x: "28", y: "12", w: "24", h: "4", Text: '"x " + Hmi.jogX.toFixed(2) + "  y " + Hmi.jogY.toFixed(2)', Colour: "$text", Size: "2" });

  await d.tab("Run");
  const inst = page.locator(`.run-layer:not([hidden]) .el[data-id="${stick}"]`);
  const knob = inst.locator('[data-name="knob"]');
  const centre = async (l) => {
    const b = await l.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const [cx, cy] = await centre(inst);
  const scale = (await inst.boundingBox()).width / 20;
  const shared = (name) => hmi.state.values[name]?.value;
  const beats = () => shared("Hmi.beats");

  // a press in the box's corner, outside the base, does nothing
  const corner = await inst.boundingBox();
  const idle = beats();
  await page.mouse.move(corner.x + 4, corner.y + 4);
  await page.mouse.down();
  await page.mouse.move(corner.x + 30, corner.y + 30, { steps: 4 });
  await page.waitForTimeout(300);
  const [ix, iy] = await centre(knob);
  check(Math.abs(ix - cx) < 2 && Math.abs(iy - cy) < 2 && beats() === idle, "a press outside the base worked the stick");
  await page.mouse.up();

  // within the ring the knob sits under the finger
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 3 * scale, cy - 4 * scale, { steps: 6 });
  const [kx, ky] = await centre(knob);
  check(Math.abs(kx - (cx + 3 * scale)) < 3 && Math.abs(ky - (cy - 4 * scale)) < 3, `the knob is at ${kx - cx}, ${ky - cy} from the centre, not under the finger`);
  const readout = page.locator(".run-layer:not([hidden]) .el.text");
  let said = "";
  const reads = (text, what) => eventually(async () => (said = await readout.textContent()) === text, () => `${what}, the page says ${said}`);
  await reads("x 0.46  y 0.62", "the page to hear the move");

  // beyond it, the knob stops at the ring in the finger's direction
  await page.mouse.move(cx + 20 * scale, cy, { steps: 6 });
  const [fx, fy] = await centre(knob);
  check(Math.abs(fx - (cx + 6.5 * scale)) < 3 && Math.abs(fy - cy) < 3, `the knob went to ${fx - cx}, ${fy - cy} past the ring`);
  await reads("x 1.00  y 0.00", "a full push right");

  // held still, it keeps sending where it is, about once each 100 ms
  const from = beats();
  await page.waitForTimeout(600);
  const counted = beats() - from;
  check(counted >= 3 && counted <= 9, `held still for 600 ms it sent held ${counted} times`);
  check(shared("Hmi.heldX") === 1, "held sends where the stick is");

  await page.mouse.up();
  const [rx, ry] = await centre(knob);
  check(Math.abs(rx - cx) < 2 && Math.abs(ry - cy) < 2, "the knob did not spring back");
  await reads("x 0.00  y 0.00", "the release to stop the jog");
  await eventually(async () => shared("Hmi.heldX") === 0, "the release to send a last held at 0");
  const after = beats();
  await page.waitForTimeout(300);
  check(beats() === after, "held went on after the release");
}
