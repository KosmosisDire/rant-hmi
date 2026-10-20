// A designer builds a Joystick in the editor alone: a base, a travel ring and a knob drawn in
// one drawing. The knob follows the finger while it stays within the ring, stops at the ring
// beyond it, and springs back on release. It sends move with x and y from -1 to 1, up being
// positive, which the page keeps in two variables.

export default async function ({ page, hmi, d, check, eventually }) {
  for (const name of ["jogX", "jogY"]) hmi.send({ type: "set_variable", name, variable: { name, start: 0, per: "screen" } });

  await d.addComponent("Joystick", 220, 220);
  await d.addInput("travel", "70");
  await d.addVariable("kx", "0");
  await d.addVariable("ky", "0");
  await d.addSends("move");
  await d.add("drawing", { Name: "pad", x: "0", y: "0", w: "220", h: "220" });
  await d.handler("drag", [
    "// the knob goes where the finger is, as far as the ring",
    "const dx = (p.x - 0.5) * 220, dy = (p.y - 0.5) * 220;",
    "const k = Math.min(1, travel / Math.max(Math.hypot(dx, dy), 1));",
    "kx = (dx * k) / travel;",
    "ky = (dy * k) / travel;",
    'emit("move", { x: kx, y: -ky });',
  ].join("\n"));
  await d.handler("release", 'kx = 0;\nky = 0;\nemit("move", { x: 0, y: 0 });');
  await d.addShape("circle", { Name: "base", "Centre x": "110", "Centre y": "110", Radius: "104", Fill: "#1e2125", Stroke: "#3a4046", Width: "2" });
  await d.addShape("circle", { Name: "ring", "Centre x": "110", "Centre y": "110", Radius: "travel", Fill: '"none"', Stroke: "#2f3540", Width: "2", Dashes: '"4 6"' });
  await d.addShape("circle", { Name: "knob", "Centre x": "110 + kx * travel", "Centre y": "110 + ky * travel", Radius: "34", Fill: 'root.pressed ? "#4a8fd6" : "#3a4046"', Stroke: "#e4e6e8", Width: "2" });

  await d.addPage("Joystick");
  const stick = await d.place("Joystick", { x: "44", y: "44", w: "220", h: "220" });
  await d.handler("move", "jogX = p.x;\njogY = p.y;");
  await d.add("text", { Name: "readout", x: "308", y: "132", w: "264", h: "44", Text: '"x " + jogX.toFixed(2) + "  y " + jogY.toFixed(2)', Colour: "#e4e6e8", Size: "20" });

  await d.tab("Run");
  const inst = page.locator(`.run-layer:not([hidden]) .el[data-id="${stick}"]`);
  const knob = inst.locator('[data-name="knob"]');
  const centre = async (l) => {
    const b = await l.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const [cx, cy] = await centre(inst);
  const scale = (await inst.boundingBox()).width / 220;

  // within the ring the knob sits under the finger
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30 * scale, cy - 40 * scale, { steps: 6 });
  const [kx, ky] = await centre(knob);
  check(Math.abs(kx - (cx + 30 * scale)) < 3 && Math.abs(ky - (cy - 40 * scale)) < 3, `the knob is at ${kx - cx}, ${ky - cy} from the centre, not under the finger`);
  const readout = page.locator(".run-layer:not([hidden]) .el.text");
  let said = "";
  const reads = (text, what) => eventually(async () => (said = await readout.textContent()) === text, () => `${what}, the page says ${said}`);
  await reads("x 0.43  y 0.57", "the page to hear the move");

  // beyond it, the knob stops at the ring in the finger's direction
  await page.mouse.move(cx + 200 * scale, cy, { steps: 6 });
  const [fx, fy] = await centre(knob);
  check(Math.abs(fx - (cx + 70 * scale)) < 3 && Math.abs(fy - cy) < 3, `the knob went to ${fx - cx}, ${fy - cy} past the ring`);
  await reads("x 1.00  y 0.00", "a full push right");

  await page.mouse.up();
  const [rx, ry] = await centre(knob);
  check(Math.abs(rx - cx) < 2 && Math.abs(ry - cy) < 2, "the knob did not spring back");
  await reads("x 0.00  y 0.00", "the release to stop the jog");
}
